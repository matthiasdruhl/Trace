"""
Evaluate local Trace retrieval quality against labeled relevance cases.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import re
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import lancedb
import numpy as np
import pandas as pd

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from filter_expr import (
    FilterExpr,
    FilterSyntaxError,
    compile_filter,
    evaluate_filter,
    parse_sql_filter,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES_PATH = ROOT / "fixtures" / "eval" / "retrieval_relevance_cases.json"
DEFAULT_ARTIFACTS_ROOT = ROOT / "artifacts" / "evaluations"
METHOD_TRACE_PREFILTER = "trace_prefilter_vector"
METHOD_KEYWORD_ONLY = "keyword_only"
METHOD_VECTOR_POSTFILTER = "vector_postfilter"
METHOD_SEMANTIC_ONLY_VECTOR = "semantic_only_vector"
METHOD_ORDER = (
    METHOD_TRACE_PREFILTER,
    METHOD_KEYWORD_ONLY,
    METHOD_VECTOR_POSTFILTER,
)
STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "before",
        "both",
        "by",
        "find",
        "for",
        "from",
        "had",
        "have",
        "in",
        "into",
        "is",
        "it",
        "not",
        "of",
        "on",
        "or",
        "show",
        "still",
        "that",
        "the",
        "their",
        "there",
        "to",
        "until",
        "were",
        "which",
        "with",
    }
)


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
class RetrievalCase:
    case_id: str
    query: str
    sql_filter: str | None
    compiled_sql_filter: str | None
    filter_expr: FilterExpr | None
    limit: int
    relevant_incident_ids: tuple[str, ...]
    category: str | None
    notes: str | None


@dataclass(frozen=True)
class MethodCaseResult:
    method: str
    returned_ids: tuple[str, ...]
    relevant_hits: tuple[str, ...]
    returned_count: int
    relevant_hit_count: int
    recall_at_k: float
    precision_at_k: float
    precision_over_returned: float
    filter_all_results_match: bool
    filtered_strict_success: bool | None
    candidate_pool_limit: int | None
    candidate_pool_count: int | None
    preview: tuple[dict[str, Any], ...]


class RetrievalConfigError(ValueError):
    """User-facing configuration validation error."""


@dataclass(frozen=True)
class SearchExecution:
    rows: list[dict[str, Any]]
    candidate_pool_limit: int | None = None
    candidate_pool_count: int | None = None

    def __getitem__(self, index: int) -> dict[str, Any]:
        return self.rows[index]

    def __iter__(self):
        return iter(self.rows)

    def __len__(self) -> int:
        return len(self.rows)


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
        raise RetrievalConfigError(
            f"Retrieval case {case_id!r} field {field_name!r} must be an integer, not a boolean."
        )
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise RetrievalConfigError(
            f"Retrieval case {case_id!r} field {field_name!r} must be an integer."
        ) from exc
    if isinstance(raw_value, str) and not re.fullmatch(r"[+-]?\d+", raw_value.strip()):
        raise RetrievalConfigError(
            f"Retrieval case {case_id!r} field {field_name!r} must be an integer."
        )
    return value


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
        "source_parquet_path",
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
            "Error: Retrieval evaluation requires an embedding-backed dataset "
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
    for field_name in ("lance_dataset_path", "source_parquet_path"):
        path = Path(str(manifest[field_name])).resolve()
        if not path.exists():
            print(f"Error: Manifest path does not exist for {field_name}: {path}", file=sys.stderr)
            raise SystemExit(1)


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
            "Re-run without --embedding-model or regenerate the dataset with the model you intend to evaluate.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    model = override_model or manifest_model
    seed._validate_embedding_model_or_exit(model)
    return model


def load_cases(path: Path) -> list[RetrievalCase]:
    raw = load_json(path)
    if not isinstance(raw, list) or not raw:
        print(f"Error: Retrieval cases in {path} must be a non-empty JSON array.", file=sys.stderr)
        raise SystemExit(1)

    seen_ids: set[str] = set()
    cases: list[RetrievalCase] = []
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
            print(f"Error: Duplicate retrieval case id {case_id!r} in {path}.", file=sys.stderr)
            raise SystemExit(1)
        if not query:
            print(f"Error: Retrieval case {case_id!r} is missing a non-empty 'query'.", file=sys.stderr)
            raise SystemExit(1)

        try:
            limit = parse_case_int(item.get("limit"), field_name="limit", case_id=case_id, default=5)
        except RetrievalConfigError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            raise SystemExit(1) from None
        if limit < 1 or limit > 50:
            print(f"Error: Retrieval case {case_id!r} must have limit between 1 and 50.", file=sys.stderr)
            raise SystemExit(1)

        raw_relevant_ids = item.get("relevant_incident_ids")
        if not isinstance(raw_relevant_ids, list) or not raw_relevant_ids:
            print(
                f"Error: Retrieval case {case_id!r} must include a non-empty 'relevant_incident_ids' array.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        relevant_incident_ids: list[str] = []
        for i, value in enumerate(raw_relevant_ids):
            relevant_id = str(value).strip()
            if not relevant_id:
                print(
                    f"Error: Retrieval case {case_id!r} relevant_incident_ids[{i}] must be a non-empty string.",
                    file=sys.stderr,
                )
                raise SystemExit(1)
            relevant_incident_ids.append(relevant_id)

        sql_filter_raw = item.get("sql_filter")
        sql_filter = str(sql_filter_raw).strip() if sql_filter_raw is not None else None
        if sql_filter == "":
            sql_filter = None
        try:
            filter_expr = parse_sql_filter(sql_filter)
        except FilterSyntaxError as exc:
            print(
                f"Error: Retrieval case {case_id!r} has invalid sql_filter ({exc.code}): {exc}",
                file=sys.stderr,
            )
            raise SystemExit(1) from None

        category_raw = str(item.get("category", "")).strip()
        notes_raw = str(item.get("notes", "")).strip()

        cases.append(
            RetrievalCase(
                case_id=case_id,
                query=query,
                sql_filter=sql_filter,
                compiled_sql_filter=compile_filter(filter_expr) if filter_expr is not None else None,
                filter_expr=filter_expr,
                limit=limit,
                relevant_incident_ids=tuple(relevant_incident_ids),
                category=category_raw or None,
                notes=notes_raw or None,
            )
        )
        seen_ids.add(case_id)
    return cases


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate local Trace retrieval quality against labeled cases."
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
        default=Path(".test-tmp/eval-seed"),
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
        help=f"JSON file of labeled retrieval cases (default: {DEFAULT_CASES_PATH}).",
    )
    parser.add_argument(
        "--report-path",
        type=Path,
        default=None,
        help="Optional explicit JSON report path. Defaults to artifacts/evaluations/<run_id>/report.json.",
    )
    parser.add_argument(
        "--artifacts-root",
        type=Path,
        default=DEFAULT_ARTIFACTS_ROOT,
        help=f"Root directory for generated evaluation artifacts (default: {DEFAULT_ARTIFACTS_ROOT}).",
    )
    parser.add_argument(
        "--embedding-model",
        type=str,
        default=None,
        help="Override the embedding model used for evaluation queries. Defaults to the manifest model.",
    )
    parser.add_argument(
        "--preview-results",
        type=int,
        default=3,
        help="Number of result previews to keep per case and method (default: 3).",
    )
    parser.add_argument(
        "--postfilter-candidate-multiplier",
        type=int,
        default=10,
        help=(
            "Multiplier used to size the vector_postfilter candidate pool relative to case limit "
            "(default: 10). Ignored when --postfilter-candidate-limit is set."
        ),
    )
    parser.add_argument(
        "--postfilter-candidate-limit",
        type=int,
        default=None,
        help=(
            "Optional fixed candidate pool size for vector_postfilter. "
            "When set, overrides --postfilter-candidate-multiplier."
        ),
    )
    return parser.parse_args()


def resolve_manifest_path(args: argparse.Namespace) -> Path:
    if args.manifest_path is not None:
        return args.manifest_path.expanduser().resolve()
    return seed.seed_manifest_path(args.output_dir.expanduser().resolve(), args.table_name.strip())


def make_run_id(now: datetime) -> str:
    return now.strftime("%Y%m%dT%H%M%SZ")


def resolve_report_paths(args: argparse.Namespace, run_id: str) -> tuple[Path, Path]:
    if args.report_path is not None:
        report_path = args.report_path.expanduser().resolve()
        summary_name = f"{report_path.stem}.summary.md"
        return report_path, report_path.with_name(summary_name)
    run_dir = args.artifacts_root.expanduser().resolve() / run_id
    return run_dir / "report.json", run_dir / "summary.md"


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def load_table(manifest: dict[str, Any]):
    lance_path = Path(str(manifest["lance_dataset_path"])).resolve()
    db = lancedb.connect(str(lance_path.parent))
    return db.open_table(lance_path.stem)


def load_source_rows(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    source_path = Path(str(manifest["source_parquet_path"])).resolve()
    df = pd.read_parquet(source_path)
    return df.to_dict(orient="records")


def resolve_postfilter_candidate_limit(
    case: RetrievalCase,
    *,
    multiplier: int,
    fixed_limit: int | None,
) -> int:
    if fixed_limit is not None:
        return max(case.limit, fixed_limit)
    return max(case.limit, case.limit * multiplier)


def validate_cases_against_source_rows_or_exit(
    cases: list[RetrievalCase],
    source_rows: list[dict[str, Any]],
) -> None:
    row_by_id: dict[str, dict[str, Any]] = {}
    duplicate_incident_ids: list[str] = []
    for row in source_rows:
        incident_id = str(row.get("incident_id") or "").strip()
        if not incident_id:
            print("Error: Source dataset contains a row with a missing incident_id.", file=sys.stderr)
            raise SystemExit(1)
        if incident_id in row_by_id:
            duplicate_incident_ids.append(incident_id)
            continue
        row_by_id[incident_id] = row

    if duplicate_incident_ids:
        duplicate_counts = Counter(duplicate_incident_ids)
        duplicates_text = ", ".join(
            f"{incident_id} ({count + 1} rows)"
            for incident_id, count in sorted(duplicate_counts.items())
        )
        print(
            "Error: Source dataset incident_id values must be unique. "
            f"Duplicates found: {duplicates_text}.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    missing_messages: list[str] = []
    invalid_filter_messages: list[str] = []
    for case in cases:
        missing_ids = [
            incident_id for incident_id in case.relevant_incident_ids if incident_id not in row_by_id
        ]
        if missing_ids:
            missing_messages.append(
                f"{case.case_id}: labeled incident_id(s) not found in source dataset: {', '.join(missing_ids)}"
            )
        if case.filter_expr is not None:
            invalid_ids = [
                incident_id
                for incident_id in case.relevant_incident_ids
                if incident_id in row_by_id and not evaluate_filter(case.filter_expr, row_by_id[incident_id])
            ]
            if invalid_ids:
                invalid_filter_messages.append(
                    f"{case.case_id}: labeled positives do not satisfy sql_filter: {', '.join(invalid_ids)}"
                )

    if missing_messages or invalid_filter_messages:
        for message in missing_messages + invalid_filter_messages:
            print(f"Error: {message}", file=sys.stderr)
        raise SystemExit(1)


def tokenize(text: str) -> list[str]:
    return [token for token in re.findall(r"[a-z0-9]+", text.lower()) if token not in STOPWORDS]


@dataclass(frozen=True)
class KeywordStats:
    document_frequencies: dict[str, int]
    term_frequencies_by_id: dict[str, Counter[str]]
    document_lengths: dict[str, int]
    avg_doc_length: float
    row_by_id: dict[str, dict[str, Any]]
    total_docs: int


def build_keyword_stats(rows: list[dict[str, Any]]) -> KeywordStats:
    document_frequencies: Counter[str] = Counter()
    term_frequencies_by_id: dict[str, Counter[str]] = {}
    document_lengths: dict[str, int] = {}
    row_by_id: dict[str, dict[str, Any]] = {}
    for row in rows:
        incident_id = str(row["incident_id"])
        tokens = tokenize(str(row.get("text_content", "")))
        term_counts = Counter(tokens)
        term_frequencies_by_id[incident_id] = term_counts
        document_lengths[incident_id] = len(tokens)
        row_by_id[incident_id] = row
        for token in term_counts:
            document_frequencies[token] += 1
    avg_doc_length = 0.0
    if document_lengths:
        avg_doc_length = sum(document_lengths.values()) / len(document_lengths)
    return KeywordStats(
        document_frequencies=dict(document_frequencies),
        term_frequencies_by_id=term_frequencies_by_id,
        document_lengths=document_lengths,
        avg_doc_length=avg_doc_length,
        row_by_id=row_by_id,
        total_docs=len(document_lengths),
    )


def bm25_score(query_tokens: list[str], incident_id: str, stats: KeywordStats) -> float:
    if not query_tokens:
        return 0.0
    term_counts = stats.term_frequencies_by_id[incident_id]
    doc_len = stats.document_lengths[incident_id]
    avg_doc_len = stats.avg_doc_length or 1.0
    k1 = 1.5
    b = 0.75
    score = 0.0
    unique_query_tokens = set(query_tokens)
    for token in unique_query_tokens:
        tf = term_counts.get(token, 0)
        if tf <= 0:
            continue
        df = stats.document_frequencies.get(token, 0)
        idf = math.log(1.0 + ((stats.total_docs - df + 0.5) / (df + 0.5)))
        numerator = tf * (k1 + 1.0)
        denominator = tf + k1 * (1.0 - b + b * (doc_len / avg_doc_len))
        score += idf * (numerator / denominator)
    return score


def evaluate_case_metrics(
    case: RetrievalCase,
    method: str,
    execution: SearchExecution | list[dict[str, Any]],
    *,
    preview_limit: int,
) -> MethodCaseResult:
    if isinstance(execution, list):
        execution = SearchExecution(rows=execution)
    rows = execution.rows
    returned_ids = tuple(str(row.get("incident_id")) for row in rows if row.get("incident_id") is not None)
    relevant_hits = tuple(incident_id for incident_id in returned_ids if incident_id in case.relevant_incident_ids)
    returned_count = len(returned_ids)
    relevant_hit_count = len(relevant_hits)
    recall_at_k = relevant_hit_count / len(case.relevant_incident_ids)
    precision_at_k = relevant_hit_count / case.limit
    precision_over_returned = relevant_hit_count / returned_count if returned_count else 0.0
    filter_all_results_match = all(evaluate_filter(case.filter_expr, row) for row in rows)
    filtered_strict_success = None
    if case.filter_expr is not None:
        filtered_strict_success = (
            filter_all_results_match and relevant_hit_count == len(case.relevant_incident_ids)
        )
    preview: list[dict[str, Any]] = []
    for row in rows[:preview_limit]:
        preview_item = {
            "incident_id": row.get("incident_id"),
            "doc_type": row.get("doc_type"),
            "city_code": row.get("city_code"),
        }
        if "_distance" in row:
            preview_item["distance"] = row.get("_distance")
        if "_keyword_score" in row:
            preview_item["keyword_score"] = row.get("_keyword_score")
        preview.append(preview_item)
    return MethodCaseResult(
        method=method,
        returned_ids=returned_ids,
        relevant_hits=relevant_hits,
        returned_count=returned_count,
        relevant_hit_count=relevant_hit_count,
        recall_at_k=recall_at_k,
        precision_at_k=precision_at_k,
        precision_over_returned=precision_over_returned,
        filter_all_results_match=filter_all_results_match,
        filtered_strict_success=filtered_strict_success,
        candidate_pool_limit=execution.candidate_pool_limit,
        candidate_pool_count=execution.candidate_pool_count,
        preview=tuple(preview),
    )


def trace_prefilter_vector_search(
    table: Any,
    *,
    query_vector: np.ndarray,
    case: RetrievalCase,
) -> SearchExecution:
    search = table.search(query_vector)
    if case.compiled_sql_filter:
        if hasattr(search, "where"):
            search = search.where(case.compiled_sql_filter, prefilter=True)
            return SearchExecution(rows=list(search.limit(case.limit).to_list()))
        rows = list(search.limit(case.limit).to_list())
        return SearchExecution(rows=[row for row in rows if evaluate_filter(case.filter_expr, row)][: case.limit])
    return SearchExecution(rows=list(search.limit(case.limit).to_list()))


def keyword_only_search(
    stats: KeywordStats,
    *,
    case: RetrievalCase,
) -> SearchExecution:
    query_tokens = tokenize(case.query)
    scored_rows: list[dict[str, Any]] = []
    for incident_id, row in stats.row_by_id.items():
        if not evaluate_filter(case.filter_expr, row):
            continue
        score = bm25_score(query_tokens, incident_id, stats)
        if score <= 0:
            continue
        enriched = dict(row)
        enriched["_keyword_score"] = score
        scored_rows.append(enriched)
    scored_rows.sort(
        key=lambda row: (
            -float(row["_keyword_score"]),
            str(row.get("incident_id")),
        )
    )
    return SearchExecution(rows=scored_rows[: case.limit])


def vector_postfilter_search(
    table: Any,
    *,
    query_vector: np.ndarray,
    case: RetrievalCase,
    postfilter_candidate_multiplier: int = 10,
    postfilter_candidate_limit: int | None = None,
) -> SearchExecution:
    candidate_limit = resolve_postfilter_candidate_limit(
        case,
        multiplier=postfilter_candidate_multiplier,
        fixed_limit=postfilter_candidate_limit,
    )
    candidates = list(table.search(query_vector).limit(candidate_limit).to_list())
    filtered = [row for row in candidates if evaluate_filter(case.filter_expr, row)]
    return SearchExecution(
        rows=filtered[: case.limit],
        candidate_pool_limit=candidate_limit,
        candidate_pool_count=len(candidates),
    )


def semantic_only_vector_search(
    table: Any,
    *,
    query_vector: np.ndarray,
    case: RetrievalCase,
) -> SearchExecution:
    return SearchExecution(rows=list(table.search(query_vector).limit(case.limit).to_list()))


def aggregate_method_metrics(case_payloads: list[dict[str, Any]], method: str) -> dict[str, Any]:
    method_results = [case_payload["methods"][method] for case_payload in case_payloads]
    filtered_results = [result for result in method_results if result["sql_filter"]]
    filtered_successes = [
        result
        for result in filtered_results
        if result.get(
            "filtered_strict_success",
            result["filter_all_results_match"] and result["relevant_hit_count"] > 0,
        )
    ]
    avg_recall = sum(result["recall_at_k"] for result in method_results) / len(method_results)
    avg_precision = sum(result["precision_at_k"] for result in method_results) / len(method_results)
    avg_precision_over_returned = (
        sum(result.get("precision_over_returned", result["precision_at_k"]) for result in method_results)
        / len(method_results)
    )
    filtered_accuracy = (
        len(filtered_successes) / len(filtered_results) if filtered_results else None
    )
    return {
        "case_count": len(method_results),
        "average_recall_at_k": avg_recall,
        "average_precision_at_k": avg_precision,
        "average_precision_over_returned": avg_precision_over_returned,
        "filtered_query_strict_accuracy": filtered_accuracy,
        "filtered_case_count": len(filtered_results),
    }


def build_failure_notes(case_payloads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for case_payload in case_payloads:
        trace_result = case_payload["methods"][METHOD_TRACE_PREFILTER]
        baseline_recalls = [
            case_payload["methods"][METHOD_KEYWORD_ONLY]["recall_at_k"],
            case_payload["methods"][METHOD_VECTOR_POSTFILTER]["recall_at_k"],
        ]
        notes: list[str] = []
        if trace_result["relevant_hit_count"] == 0:
            notes.append("Trace missed every labeled relevant record.")
        if trace_result["recall_at_k"] < max(baseline_recalls):
            notes.append("Trace recall is lower than at least one baseline on this case.")
        if trace_result["sql_filter"] and not trace_result["filter_all_results_match"]:
            notes.append("Trace returned a row that did not satisfy the labeled filter.")
        if trace_result["sql_filter"] and not trace_result["filtered_strict_success"]:
            notes.append("Trace did not retrieve the full labeled positive set within k for this filtered case.")
        if notes:
            failures.append(
                {
                    "case_id": case_payload["case_id"],
                    "trace_recall_at_k": trace_result["recall_at_k"],
                    "keyword_recall_at_k": case_payload["methods"][METHOD_KEYWORD_ONLY]["recall_at_k"],
                    "vector_postfilter_recall_at_k": case_payload["methods"][METHOD_VECTOR_POSTFILTER]["recall_at_k"],
                    "notes": notes,
                }
            )
    return failures


def build_case_payload(
    case: RetrievalCase,
    method_results: list[MethodCaseResult],
) -> dict[str, Any]:
    return {
        "case_id": case.case_id,
        "query": case.query,
        "sql_filter": case.sql_filter,
        "limit": case.limit,
        "category": case.category,
        "notes": case.notes,
        "relevant_incident_ids": list(case.relevant_incident_ids),
        "methods": {
            method_result.method: {
                **asdict(method_result),
                "sql_filter": case.sql_filter,
            }
            for method_result in method_results
        },
    }


def build_summary_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Retrieval Evaluation Summary",
        "",
        f"- Generated at: `{report['generated_at']}`",
        f"- Cases path: `{report['cases_path']}`",
        f"- Manifest path: `{report['manifest_path']}`",
        f"- Dataset path: `{report['lance_dataset_path']}`",
        f"- Source parquet: `{report['source_parquet_path']}`",
        f"- Embedding model: `{report['embedding_model']}`",
        f"- Vector postfilter candidate multiplier: `{report['evaluation_config']['postfilter_candidate_multiplier']}`",
        f"- Vector postfilter candidate limit override: `{report['evaluation_config']['postfilter_candidate_limit']}`",
        "",
        "| Method | Avg Recall@k | Avg Precision@k | Avg Precision@returned | Filtered Strict Accuracy |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for method in METHOD_ORDER:
        metrics = report["aggregate_metrics"][method]
        filtered_accuracy = metrics["filtered_query_strict_accuracy"]
        filtered_accuracy_text = "n/a" if filtered_accuracy is None else f"{filtered_accuracy:.3f}"
        lines.append(
            f"| `{method}` | {metrics['average_recall_at_k']:.3f} | {metrics['average_precision_at_k']:.3f} | {metrics['average_precision_over_returned']:.3f} | {filtered_accuracy_text} |"
        )
    lines.extend(["", "## Notable Cases", ""])
    failure_notes = report["trace_failure_cases"]
    if not failure_notes:
        lines.append("Trace did not lose to either baseline on the current labeled cases.")
    else:
        for item in failure_notes:
            lines.append(
                f"- `{item['case_id']}`: {' '.join(item['notes'])}"
            )
    return "\n".join(lines) + "\n"


def build_report(
    *,
    generated_at: datetime,
    manifest_path: Path,
    cases_path: Path,
    report_path: Path,
    summary_path: Path,
    manifest: dict[str, Any],
    embedding_model: str,
    case_payloads: list[dict[str, Any]],
    postfilter_candidate_multiplier: int = 10,
    postfilter_candidate_limit: int | None = None,
) -> dict[str, Any]:
    aggregate_metrics = {
        method: aggregate_method_metrics(case_payloads, method) for method in METHOD_ORDER
    }
    return {
        "generated_at": generated_at.isoformat(),
        "run_id": make_run_id(generated_at),
        "manifest_path": str(manifest_path),
        "cases_path": str(cases_path),
        "report_path": str(report_path),
        "summary_path": str(summary_path),
        "lance_dataset_path": str(manifest["lance_dataset_path"]),
        "source_parquet_path": str(manifest["source_parquet_path"]),
        "embedding_model": embedding_model,
        "dataset_embedding_model": str(manifest["embedding_model"]),
        "query_embedding_model": embedding_model,
        "vector_dimension": manifest["vector_dimension"],
        "case_count": len(case_payloads),
        "evaluation_config": {
            "postfilter_candidate_multiplier": postfilter_candidate_multiplier,
            "postfilter_candidate_limit": postfilter_candidate_limit,
        },
        "methods": list(METHOD_ORDER),
        "aggregate_metrics": aggregate_metrics,
        "trace_failure_cases": build_failure_notes(case_payloads),
        "cases": case_payloads,
    }


def run_evaluation(
    *,
    manifest_path: Path,
    cases_path: Path,
    report_path: Path,
    summary_path: Path,
    generated_at: datetime,
    embedding_model: str,
    preview_limit: int,
    postfilter_candidate_multiplier: int = 10,
    postfilter_candidate_limit: int | None = None,
) -> int:
    manifest = load_manifest(manifest_path)
    validate_manifest_or_exit(manifest, manifest_path)
    cases = load_cases(cases_path)
    source_rows = load_source_rows(manifest)
    validate_cases_against_source_rows_or_exit(cases, source_rows)
    keyword_stats = build_keyword_stats(source_rows)
    table = load_table(manifest)

    api_key = seed.resolve_openai_api_key_or_exit("openai")
    query_vectors = seed.generate_openai_embeddings(
        [case.query for case in cases],
        api_key=api_key or "",
        model=embedding_model,
        expected_dim=int(manifest["vector_dimension"]),
    )

    case_payloads: list[dict[str, Any]] = []
    for case, query_vector in zip(cases, query_vectors):
        vector_np = np.asarray(query_vector, dtype=np.float32)
        trace_rows = trace_prefilter_vector_search(table, query_vector=vector_np, case=case)
        keyword_rows = keyword_only_search(keyword_stats, case=case)
        postfilter_rows = vector_postfilter_search(
            table,
            query_vector=vector_np,
            case=case,
            postfilter_candidate_multiplier=postfilter_candidate_multiplier,
            postfilter_candidate_limit=postfilter_candidate_limit,
        )
        method_results = [
            evaluate_case_metrics(case, METHOD_TRACE_PREFILTER, trace_rows, preview_limit=preview_limit),
            evaluate_case_metrics(case, METHOD_KEYWORD_ONLY, keyword_rows, preview_limit=preview_limit),
            evaluate_case_metrics(case, METHOD_VECTOR_POSTFILTER, postfilter_rows, preview_limit=preview_limit),
        ]
        if case.filter_expr is not None:
            semantic_only_rows = semantic_only_vector_search(
                table,
                query_vector=vector_np,
                case=case,
            )
            method_results.append(
                evaluate_case_metrics(
                    case,
                    METHOD_SEMANTIC_ONLY_VECTOR,
                    semantic_only_rows,
                    preview_limit=preview_limit,
                )
            )

        case_payloads.append(
            build_case_payload(
                case,
                method_results,
            )
        )

    report = build_report(
        generated_at=generated_at,
        manifest_path=manifest_path,
        cases_path=cases_path,
        report_path=report_path,
        summary_path=summary_path,
        manifest=manifest,
        embedding_model=embedding_model,
        case_payloads=case_payloads,
        postfilter_candidate_multiplier=postfilter_candidate_multiplier,
        postfilter_candidate_limit=postfilter_candidate_limit,
    )
    summary = build_summary_markdown(report)
    write_json(report_path, report)
    write_text(summary_path, summary)

    print(f"Retrieval evaluation completed. Report: {report_path}")
    print(f"Summary: {summary_path}")
    return 0


def main() -> int:
    args = parse_args()
    if args.postfilter_candidate_multiplier < 1:
        print("Error: --postfilter-candidate-multiplier must be at least 1.", file=sys.stderr)
        raise SystemExit(1)
    if args.postfilter_candidate_limit is not None and args.postfilter_candidate_limit < 1:
        print("Error: --postfilter-candidate-limit must be at least 1.", file=sys.stderr)
        raise SystemExit(1)
    manifest_path = resolve_manifest_path(args)
    manifest = load_manifest(manifest_path)
    embedding_model = resolve_embedding_model(
        manifest,
        args.embedding_model,
        manifest_path=manifest_path,
    )
    generated_at = datetime.now(timezone.utc)
    report_path, summary_path = resolve_report_paths(args, make_run_id(generated_at))
    return run_evaluation(
        manifest_path=manifest_path,
        cases_path=args.cases_path.expanduser().resolve(),
        report_path=report_path,
        summary_path=summary_path,
        generated_at=generated_at,
        embedding_model=embedding_model,
        preview_limit=max(1, args.preview_results),
        postfilter_candidate_multiplier=args.postfilter_candidate_multiplier,
        postfilter_candidate_limit=args.postfilter_candidate_limit,
    )


if __name__ == "__main__":
    raise SystemExit(main())
