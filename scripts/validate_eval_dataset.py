"""
Validate a locally generated embedding-backed Trace eval dataset before upload.

This script runs a small set of curated semantic queries against a local Lance
dataset, writes a JSON report, and records the latest validation result in the
seed manifest so step-2 eval promotion remains auditable.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import lancedb
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES_PATH = ROOT / "fixtures" / "eval" / "local_validation_cases.json"
MAX_SQL_FILTER_CHARS = 8192
ALLOWED_FILTER_FIELDS = frozenset({"incident_id", "timestamp", "city_code", "doc_type"})


def _load_seed_module():
    path = ROOT / "scripts" / "seed.py"
    spec = importlib.util.spec_from_file_location("seed_script", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load seed.py from {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("seed_script", mod)
    spec.loader.exec_module(mod)
    return mod


seed = _load_seed_module()


@dataclass(frozen=True)
class ValidationCase:
    case_id: str
    query: str
    sql_filter: str | None
    limit: int
    min_expected_matches: int
    expected_doc_types: tuple[str, ...]
    expected_city_codes: tuple[str, ...]
    require_all_results_match: bool


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    passed: bool
    query: str
    sql_filter: str | None
    limit: int
    result_count: int
    matched_result_count: int
    top_result_matches_expectations: bool
    failure_reasons: tuple[str, ...]
    result_preview: tuple[dict[str, Any], ...]


class ValidationConfigError(ValueError):
    """User-facing configuration validation error."""


class FilterSyntaxError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class FilterCompare:
    field: str
    op: str
    value: tuple[str, str]


@dataclass(frozen=True)
class FilterIn:
    field: str
    values: tuple[tuple[str, str], ...]


FilterExpr = Any


def _invalid_sql_filter() -> FilterSyntaxError:
    return FilterSyntaxError(
        "INVALID_SQL_FILTER",
        "Unsupported sql_filter syntax. Allowed fields: incident_id, timestamp, city_code, doc_type.",
    )


def _invalid_filter_value() -> FilterSyntaxError:
    return FilterSyntaxError(
        "INVALID_FILTER_VALUE",
        "Invalid timestamp literal in sql_filter. Expected RFC 3339.",
    )


def _has_bare_semicolon(raw: str) -> bool:
    in_string = False
    i = 0
    while i < len(raw):
        char = raw[i]
        if in_string:
            if char == "'":
                if i + 1 < len(raw) and raw[i + 1] == "'":
                    i += 2
                    continue
                in_string = False
        elif char == "'":
            in_string = True
        elif char == ";":
            return True
        i += 1
    return False


def _validate_timestamp_literal(raw: str) -> None:
    if not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", raw
    ):
        raise _invalid_filter_value()
    try:
        datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _invalid_filter_value() from exc


def _validate_filter_literal(field: str, raw: str) -> tuple[str, str]:
    if field == "timestamp":
        _validate_timestamp_literal(raw)
        return ("timestamp", raw)
    return ("string", raw)


def _escape_sql_string(value: str) -> str:
    return value.replace("'", "''")


def _compile_filter_value(value: tuple[str, str]) -> str:
    value_type, raw = value
    escaped = _escape_sql_string(raw)
    if value_type == "timestamp":
        return f"CAST('{escaped}' AS TIMESTAMP)"
    return f"'{escaped}'"


def compile_filter(expr: FilterExpr) -> str:
    if isinstance(expr, FilterCompare):
        return f"{expr.field} {expr.op} {_compile_filter_value(expr.value)}"
    if isinstance(expr, FilterIn):
        values = ", ".join(_compile_filter_value(value) for value in expr.values)
        return f"{expr.field} IN ({values})"
    if expr[0] == "and":
        return f"({compile_filter(expr[1])}) AND ({compile_filter(expr[2])})"
    if expr[0] == "or":
        return f"({compile_filter(expr[1])}) OR ({compile_filter(expr[2])})"
    if expr[0] == "not":
        return f"NOT ({compile_filter(expr[1])})"
    raise AssertionError(f"Unsupported filter expression: {expr!r}")


class FilterParser:
    def __init__(self, raw: str) -> None:
        self.rest = raw

    def skip_ws(self) -> None:
        self.rest = self.rest.lstrip()

    @staticmethod
    def _is_ident_char(char: str) -> bool:
        return char.isascii() and (char.isalnum() or char == "_")

    @staticmethod
    def _is_ident_start(char: str) -> bool:
        return char.isascii() and (char.isalpha() or char == "_")

    def consume_keyword_if(self, keyword: str) -> bool:
        self.skip_ws()
        candidate = self.rest[: len(keyword)]
        if candidate.lower() != keyword.lower():
            return False
        if len(self.rest) > len(keyword):
            next_char = self.rest[len(keyword)]
            if self._is_ident_char(next_char):
                return False
        self.rest = self.rest[len(keyword) :]
        return True

    def parse_identifier(self) -> str:
        self.skip_ws()
        if not self.rest or not self._is_ident_start(self.rest[0]):
            raise _invalid_sql_filter()
        end = 1
        while end < len(self.rest) and self._is_ident_char(self.rest[end]):
            end += 1
        ident = self.rest[:end]
        self.rest = self.rest[end:]
        mapped = ident.lower()
        if mapped not in ALLOWED_FILTER_FIELDS:
            raise _invalid_sql_filter()
        return mapped

    def parse_string_literal(self) -> str:
        self.skip_ws()
        if not self.rest.startswith("'"):
            raise _invalid_sql_filter()
        i = 1
        chars: list[str] = []
        while i < len(self.rest):
            current = self.rest[i]
            if current == "'":
                if i + 1 < len(self.rest) and self.rest[i + 1] == "'":
                    chars.append("'")
                    i += 2
                    continue
                self.rest = self.rest[i + 1 :]
                return "".join(chars)
            chars.append(current)
            i += 1
        raise _invalid_sql_filter()

    def parse_compare_op(self) -> str:
        self.skip_ws()
        for op in ("!=", "<=", ">=", "=", "<", ">"):
            if self.rest.startswith(op):
                self.rest = self.rest[len(op) :]
                return op
        raise _invalid_sql_filter()

    def parse_in_list(self, field: str) -> FilterIn:
        self.skip_ws()
        if not self.rest.startswith("("):
            raise _invalid_sql_filter()
        self.rest = self.rest[1:]
        values: list[tuple[str, str]] = []
        while True:
            raw = self.parse_string_literal()
            values.append(_validate_filter_literal(field, raw))
            self.skip_ws()
            if self.rest.startswith(","):
                self.rest = self.rest[1:]
                continue
            if self.rest.startswith(")"):
                self.rest = self.rest[1:]
                break
            raise _invalid_sql_filter()
        if not values:
            raise _invalid_sql_filter()
        return FilterIn(field=field, values=tuple(values))

    def parse_primary(self) -> FilterExpr:
        self.skip_ws()
        if self.rest.startswith("("):
            self.rest = self.rest[1:]
            expr = self.parse_or()
            self.skip_ws()
            if not self.rest.startswith(")"):
                raise _invalid_sql_filter()
            self.rest = self.rest[1:]
            return expr

        field = self.parse_identifier()
        if self.consume_keyword_if("IN"):
            return self.parse_in_list(field)
        op = self.parse_compare_op()
        raw = self.parse_string_literal()
        return FilterCompare(field=field, op=op, value=_validate_filter_literal(field, raw))

    def parse_unary(self) -> FilterExpr:
        if self.consume_keyword_if("NOT"):
            return ("not", self.parse_unary())
        return self.parse_primary()

    def parse_and(self) -> FilterExpr:
        expr = self.parse_unary()
        while self.consume_keyword_if("AND"):
            expr = ("and", expr, self.parse_unary())
        return expr

    def parse_or(self) -> FilterExpr:
        expr = self.parse_and()
        while self.consume_keyword_if("OR"):
            expr = ("or", expr, self.parse_and())
        return expr


def parse_and_compile_sql_filter(raw: str | None) -> str | None:
    if raw is None:
        return None
    sql_filter = raw.strip()
    if not sql_filter:
        return None
    n_chars = len(sql_filter)
    if n_chars > MAX_SQL_FILTER_CHARS:
        raise FilterSyntaxError(
            "SQL_FILTER_TOO_LONG",
            f"sql_filter must be at most {MAX_SQL_FILTER_CHARS} characters (got {n_chars})",
        )
    if _has_bare_semicolon(sql_filter):
        raise _invalid_sql_filter()
    parser = FilterParser(sql_filter)
    expr = parser.parse_or()
    parser.skip_ws()
    if parser.rest:
        raise _invalid_sql_filter()
    return compile_filter(expr)


def parse_case_int(
    raw_value: Any,
    *,
    field_name: str,
    case_id: str,
    default: int,
) -> int:
    if raw_value is None:
        return default
    if isinstance(raw_value, bool):
        raise ValidationConfigError(
            f"Validation case {case_id!r} field {field_name!r} must be an integer, not a boolean."
        )
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValidationConfigError(
            f"Validation case {case_id!r} field {field_name!r} must be an integer."
        ) from exc
    if isinstance(raw_value, str) and not re.fullmatch(r"[+-]?\d+", raw_value.strip()):
        raise ValidationConfigError(
            f"Validation case {case_id!r} field {field_name!r} must be an integer."
        )
    return value


def parse_case_string_list(
    raw_value: Any,
    *,
    field_name: str,
    case_id: str,
) -> tuple[str, ...]:
    if raw_value is None:
        return ()
    if not isinstance(raw_value, list):
        raise ValidationConfigError(
            f"Validation case {case_id!r} field {field_name!r} must be a JSON array."
        )
    return tuple(str(value).strip() for value in raw_value if str(value).strip())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate a local embedding-backed Trace eval dataset."
    )
    parser.add_argument(
        "--manifest-path",
        type=Path,
        default=None,
        help="Path to <table>.seed-manifest.json. Defaults to <output-dir>/<table>.seed-manifest.json.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("lance_seed"),
        help="Local seed output directory used to resolve the default manifest path.",
    )
    parser.add_argument(
        "--table-name",
        type=str,
        default="uber_audit",
        help="Table name used to resolve the default manifest path.",
    )
    parser.add_argument(
        "--cases-path",
        type=Path,
        default=DEFAULT_CASES_PATH,
        help=f"JSON file of validation cases (default: {DEFAULT_CASES_PATH}).",
    )
    parser.add_argument(
        "--report-path",
        type=Path,
        default=None,
        help="Where to write the validation report. Defaults to <output-dir>/<table>.eval-validation.json.",
    )
    parser.add_argument(
        "--embedding-model",
        type=str,
        default=None,
        help="Override the embedding model used for validation queries. Defaults to the manifest model.",
    )
    parser.add_argument(
        "--preview-results",
        type=int,
        default=3,
        help="Number of result previews to keep per case in the JSON report (default: 3).",
    )
    return parser.parse_args()


def resolve_manifest_path(args: argparse.Namespace) -> Path:
    if args.manifest_path is not None:
        return args.manifest_path.expanduser().resolve()
    return seed.seed_manifest_path(
        args.output_dir.expanduser().resolve(), args.table_name.strip()
    )


def resolve_report_path(args: argparse.Namespace, manifest: dict[str, Any]) -> Path:
    if args.report_path is not None:
        return args.report_path.expanduser().resolve()
    lance_path = Path(str(manifest["lance_dataset_path"])).resolve()
    output_dir = lance_path.parent
    table_name = lance_path.stem
    return output_dir / f"{table_name}.eval-validation.json"


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"Error: File not found: {path}", file=sys.stderr)
        raise SystemExit(1) from None
    except json.JSONDecodeError as exc:
        print(f"Error: Invalid JSON in {path}: {exc}", file=sys.stderr)
        raise SystemExit(1) from None


def load_manifest(path: Path) -> dict[str, Any]:
    manifest = load_json(path)
    if not isinstance(manifest, dict):
        print(f"Error: Manifest at {path} must be a JSON object.", file=sys.stderr)
        raise SystemExit(1)
    return manifest


def validate_manifest_or_exit(manifest: dict[str, Any], manifest_path: Path) -> None:
    required_fields = (
        "embedding_mode",
        "embedding_model",
        "vector_dimension",
        "lance_dataset_path",
    )
    missing = [field for field in required_fields if field not in manifest]
    if missing:
        print(
            f"Error: Manifest {manifest_path} is missing required fields: {', '.join(missing)}.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    if manifest["embedding_mode"] != "openai":
        print(
            "Error: Local eval validation requires an embedding-backed dataset "
            "(manifest embedding_mode must be 'openai').",
            file=sys.stderr,
        )
        raise SystemExit(1)
    manifest_model = str(manifest.get("embedding_model") or "").strip()
    if not manifest_model:
        print(
            f"Error: Manifest {manifest_path} must set a non-empty embedding_model for openai datasets.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    seed._validate_embedding_model_or_exit(manifest_model)
    if manifest["vector_dimension"] != seed.VECTOR_DIM:
        print(
            "Error: Manifest vector dimension "
            f"{manifest['vector_dimension']} does not match expected {seed.VECTOR_DIM}.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    lance_path = Path(str(manifest["lance_dataset_path"])).resolve()
    if not lance_path.exists():
        print(f"Error: Lance dataset path does not exist: {lance_path}", file=sys.stderr)
        raise SystemExit(1)


def load_cases(path: Path) -> list[ValidationCase]:
    raw = load_json(path)
    if not isinstance(raw, list) or not raw:
        print(f"Error: Validation cases in {path} must be a non-empty JSON array.", file=sys.stderr)
        raise SystemExit(1)

    seen_ids: set[str] = set()
    cases: list[ValidationCase] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            print(f"Error: Case {index} in {path} must be a JSON object.", file=sys.stderr)
            raise SystemExit(1)
        case_id = str(item.get("id", "")).strip()
        query = str(item.get("query", "")).strip()
        if not case_id:
            print(f"Error: Case {index} in {path} is missing a non-empty 'id'.", file=sys.stderr)
            raise SystemExit(1)
        if case_id in seen_ids:
            print(f"Error: Duplicate validation case id {case_id!r} in {path}.", file=sys.stderr)
            raise SystemExit(1)
        if not query:
            print(f"Error: Validation case {case_id!r} is missing a non-empty 'query'.", file=sys.stderr)
            raise SystemExit(1)

        try:
            limit = parse_case_int(
                item.get("limit"),
                field_name="limit",
                case_id=case_id,
                default=5,
            )
            min_expected_matches = parse_case_int(
                item.get("min_expected_matches"),
                field_name="min_expected_matches",
                case_id=case_id,
                default=1,
            )
            expected_doc_types = parse_case_string_list(
                item.get("expected_doc_types"),
                field_name="expected_doc_types",
                case_id=case_id,
            )
            expected_city_codes = parse_case_string_list(
                item.get("expected_city_codes"),
                field_name="expected_city_codes",
                case_id=case_id,
            )
        except ValidationConfigError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            raise SystemExit(1) from None
        if limit < 1:
            print(f"Error: Validation case {case_id!r} must have limit >= 1.", file=sys.stderr)
            raise SystemExit(1)
        if min_expected_matches < 1 or min_expected_matches > limit:
            print(
                f"Error: Validation case {case_id!r} must have 1 <= min_expected_matches <= limit.",
                file=sys.stderr,
            )
            raise SystemExit(1)

        sql_filter_raw = item.get("sql_filter")
        sql_filter = str(sql_filter_raw).strip() if sql_filter_raw is not None else None
        if sql_filter == "":
            sql_filter = None
        try:
            compiled_sql_filter = parse_and_compile_sql_filter(sql_filter)
        except FilterSyntaxError as exc:
            print(
                f"Error: Validation case {case_id!r} has invalid sql_filter ({exc.code}): {exc}",
                file=sys.stderr,
            )
            raise SystemExit(1) from None

        cases.append(
            ValidationCase(
                case_id=case_id,
                query=query,
                sql_filter=compiled_sql_filter,
                limit=limit,
                min_expected_matches=min_expected_matches,
                expected_doc_types=expected_doc_types,
                expected_city_codes=expected_city_codes,
                require_all_results_match=bool(item.get("require_all_results_match", False)),
            )
        )
        seen_ids.add(case_id)
    return cases


def resolve_embedding_model(
    manifest: dict[str, Any],
    override: str | None,
    *,
    manifest_path: Path | None = None,
) -> str:
    manifest_model = str(manifest.get("embedding_model") or "").strip()
    override_model = (override or "").strip()

    if not manifest_model:
        manifest_label = f" {manifest_path}" if manifest_path is not None else ""
        print(
            f"Error: Manifest{manifest_label} must set a non-empty embedding_model for openai datasets.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    seed._validate_embedding_model_or_exit(manifest_model)

    if override_model and manifest_model and override_model != manifest_model:
        manifest_label = f" in {manifest_path}" if manifest_path is not None else ""
        print(
            "Error: --embedding-model "
            f"{override_model!r} does not match manifest embedding_model {manifest_model!r}{manifest_label}. "
            "Re-run without --embedding-model or regenerate the dataset with the model you intend to validate.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    model = override_model or manifest_model
    seed._validate_embedding_model_or_exit(model)
    return model


def load_table(manifest: dict[str, Any]):
    lance_path = Path(str(manifest["lance_dataset_path"])).resolve()
    db = lancedb.connect(str(lance_path.parent))
    return db.open_table(lance_path.stem)


def row_matches_expectations(row: dict[str, Any], case: ValidationCase) -> bool:
    if case.expected_doc_types and str(row.get("doc_type")) not in case.expected_doc_types:
        return False
    if case.expected_city_codes and str(row.get("city_code")) not in case.expected_city_codes:
        return False
    return True


def build_result_preview(
    rows: list[dict[str, Any]], preview_limit: int
) -> tuple[dict[str, Any], ...]:
    previews: list[dict[str, Any]] = []
    for row in rows[:preview_limit]:
        text_content = str(row.get("text_content", ""))
        previews.append(
            {
                "incident_id": row.get("incident_id"),
                "city_code": row.get("city_code"),
                "doc_type": row.get("doc_type"),
                "distance": row.get("_distance"),
                "text_preview": text_content[:180],
            }
        )
    return tuple(previews)


def evaluate_case(
    case: ValidationCase,
    rows: list[dict[str, Any]],
    *,
    preview_limit: int,
) -> CaseResult:
    matched_rows = [row for row in rows if row_matches_expectations(row, case)]
    top_matches = bool(rows) and row_matches_expectations(rows[0], case)

    failure_reasons: list[str] = []
    if not rows:
        failure_reasons.append("query returned no results")
    if rows and not top_matches:
        failure_reasons.append("top result did not match expected metadata")
    if len(matched_rows) < case.min_expected_matches:
        failure_reasons.append(
            f"expected at least {case.min_expected_matches} matching results in top {case.limit}, "
            f"found {len(matched_rows)}"
        )
    if case.require_all_results_match and any(
        not row_matches_expectations(row, case) for row in rows
    ):
        failure_reasons.append("not every returned row matched the required metadata")

    return CaseResult(
        case_id=case.case_id,
        passed=not failure_reasons,
        query=case.query,
        sql_filter=case.sql_filter,
        limit=case.limit,
        result_count=len(rows),
        matched_result_count=len(matched_rows),
        top_result_matches_expectations=top_matches,
        failure_reasons=tuple(failure_reasons),
        result_preview=build_result_preview(rows, preview_limit),
    )


def search_rows(
    table: Any,
    *,
    query_vector: np.ndarray,
    case: ValidationCase,
) -> list[dict[str, Any]]:
    search = table.search(query_vector)
    if case.sql_filter:
        search = search.where(case.sql_filter, prefilter=True).bypass_vector_index()
    return list(search.limit(case.limit).to_list())


def build_report(
    *,
    manifest_path: Path,
    cases_path: Path,
    report_path: Path,
    manifest: dict[str, Any],
    embedding_model: str,
    results: list[CaseResult],
) -> dict[str, Any]:
    passed_case_count = sum(1 for result in results if result.passed)
    dataset_embedding_model = str(manifest["embedding_model"])
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "manifest_path": str(manifest_path),
        "cases_path": str(cases_path),
        "report_path": str(report_path),
        "lance_dataset_path": str(manifest["lance_dataset_path"]),
        "embedding_model": embedding_model,
        "dataset_embedding_model": dataset_embedding_model,
        "query_embedding_model": embedding_model,
        "vector_dimension": manifest["vector_dimension"],
        "passed": passed_case_count == len(results),
        "case_count": len(results),
        "passed_case_count": passed_case_count,
        "failed_case_count": len(results) - passed_case_count,
        "cases": [asdict(result) for result in results],
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def update_manifest_with_report(
    manifest_path: Path,
    manifest: dict[str, Any],
    *,
    report: dict[str, Any],
) -> None:
    manifest["latest_local_validation"] = {
        "generated_at": report["generated_at"],
        "report_path": report["report_path"],
        "cases_path": report["cases_path"],
        "passed": report["passed"],
        "case_count": report["case_count"],
        "passed_case_count": report["passed_case_count"],
        "failed_case_count": report["failed_case_count"],
        "embedding_model": report["embedding_model"],
        "dataset_embedding_model": report["dataset_embedding_model"],
        "query_embedding_model": report["query_embedding_model"],
        "vector_dimension": report["vector_dimension"],
    }
    seed.write_seed_manifest(manifest_path, manifest)


def run_validation(
    *,
    manifest_path: Path,
    cases_path: Path,
    report_path: Path,
    embedding_model: str,
    preview_limit: int,
) -> int:
    manifest = load_manifest(manifest_path)
    validate_manifest_or_exit(manifest, manifest_path)
    cases = load_cases(cases_path)

    api_key = seed.resolve_openai_api_key_or_exit("openai")
    query_vectors = seed.generate_openai_embeddings(
        [case.query for case in cases],
        api_key=api_key or "",
        model=embedding_model,
        expected_dim=int(manifest["vector_dimension"]),
    )

    table = load_table(manifest)
    results: list[CaseResult] = []
    for case, query_vector in zip(cases, query_vectors):
        try:
            rows = search_rows(
                table,
                query_vector=np.asarray(query_vector, dtype=np.float32),
                case=case,
            )
        except Exception as exc:
            print(
                f"Error: Validation case {case.case_id!r} failed during Lance search: {exc}",
                file=sys.stderr,
            )
            raise SystemExit(1) from None
        results.append(evaluate_case(case, rows, preview_limit=preview_limit))

    report = build_report(
        manifest_path=manifest_path,
        cases_path=cases_path,
        report_path=report_path,
        manifest=manifest,
        embedding_model=embedding_model,
        results=results,
    )
    write_json(report_path, report)
    update_manifest_with_report(manifest_path, manifest, report=report)

    if report["passed"]:
        print(
            "Local eval validation passed "
            f"({report['passed_case_count']}/{report['case_count']} cases)."
        )
        print(f"Validation report: {report_path}")
        return 0

    print(
        "Local eval validation failed "
        f"({report['failed_case_count']} of {report['case_count']} cases).",
        file=sys.stderr,
    )
    print(f"Validation report: {report_path}", file=sys.stderr)
    return 1


def main() -> int:
    args = parse_args()
    manifest_path = resolve_manifest_path(args)
    manifest = load_manifest(manifest_path)
    embedding_model = resolve_embedding_model(
        manifest,
        args.embedding_model,
        manifest_path=manifest_path,
    )
    report_path = resolve_report_path(args, manifest)
    return run_validation(
        manifest_path=manifest_path,
        cases_path=args.cases_path.expanduser().resolve(),
        report_path=report_path,
        embedding_model=embedding_model,
        preview_limit=max(1, args.preview_results),
    )


if __name__ == "__main__":
    raise SystemExit(main())
