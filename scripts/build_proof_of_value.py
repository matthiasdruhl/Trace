"""
Build committed Step 3 proof-of-value artifacts from retrieval evaluation data.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import evaluate_retrieval as retrieval


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_VERSION = 2
PROOF_CONFIG_VERSION = 1
COMPARISON_KEYWORD_VS_TRACE = "keyword_vs_trace"
COMPARISON_SEMANTIC_SCOPE = "semantic_scope"
TOP_RESULTS_LIMIT = 5
LOCAL_EVIDENCE_BOUNDARY = (
    "Local retrieval evidence from the current embedding-backed eval corpus only; "
    "not proof of deployed-path equivalence or a broad benchmark."
)
SELECTION_NOTE = (
    "The same local retrieval report also evaluates `vector_postfilter`. On the "
    "current labeled corpus it matches `trace_prefilter_vector`, so this proof "
    "pack should be read as two selected examples of keyword brittleness and "
    "scope control rather than universal baseline dominance."
)


@dataclass(frozen=True)
class ProofArtifactSpec:
    artifact_id: str
    comparison_type: str
    retrieval_case_id: str
    title: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build committed proof-of-value artifacts from retrieval evaluation outputs."
    )
    parser.add_argument("--manifest-path", type=Path, required=True)
    parser.add_argument("--retrieval-report", type=Path, required=True)
    parser.add_argument("--cases-path", type=Path, required=True)
    parser.add_argument("--proof-config", type=Path, required=True)
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--output-markdown", type=Path, required=True)
    return parser.parse_args()


def load_json_object(path: Path, *, label: str) -> dict[str, Any]:
    payload = retrieval.load_json(path.expanduser().resolve())
    if not isinstance(payload, dict):
        print(f"Error: {label} at {path} must be a JSON object.", file=sys.stderr)
        raise SystemExit(1)
    return payload


def require_object_key(payload: dict[str, Any], *, key: str, owner: str) -> Any:
    if key not in payload:
        print(f"Error: {owner} is missing required field {key!r}.", file=sys.stderr)
        raise SystemExit(1)
    return payload[key]


def require_path_string(value: Any, *, owner: str) -> Path:
    raw_path = str(value or "").strip()
    if not raw_path:
        print(f"Error: {owner} must be a non-empty path string.", file=sys.stderr)
        raise SystemExit(1)
    return Path(raw_path).expanduser().resolve()


def require_string(value: Any, *, owner: str) -> str:
    text = str(value or "").strip()
    if not text:
        print(f"Error: {owner} must be a non-empty string.", file=sys.stderr)
        raise SystemExit(1)
    return text


def load_proof_config(path: Path) -> tuple[ProofArtifactSpec, ...]:
    payload = load_json_object(path, label="Proof config")
    version = payload.get("version")
    if version != PROOF_CONFIG_VERSION:
        print(
            f"Error: Proof config {path} must set version {PROOF_CONFIG_VERSION}.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    raw_artifacts = payload.get("artifacts")
    if not isinstance(raw_artifacts, list) or not raw_artifacts:
        print(
            f"Error: Proof config {path} must include a non-empty artifacts array.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    specs: list[ProofArtifactSpec] = []
    seen_ids: set[str] = set()
    for index, raw_item in enumerate(raw_artifacts):
        if not isinstance(raw_item, dict):
            print(
                f"Error: Proof config artifact {index} in {path} must be an object.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        artifact_id = str(raw_item.get("artifact_id") or "").strip()
        comparison_type = str(raw_item.get("comparison_type") or "").strip()
        retrieval_case_id = str(raw_item.get("retrieval_case_id") or "").strip()
        title = str(raw_item.get("title") or "").strip()
        if not artifact_id:
            print(
                f"Error: Proof config artifact {index} in {path} is missing artifact_id.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if artifact_id in seen_ids:
            print(
                f"Error: Duplicate proof artifact_id {artifact_id!r} in {path}.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if comparison_type not in {
            COMPARISON_KEYWORD_VS_TRACE,
            COMPARISON_SEMANTIC_SCOPE,
        }:
            print(
                f"Error: Proof artifact {artifact_id!r} has unsupported comparison_type "
                f"{comparison_type!r}.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if not retrieval_case_id:
            print(
                f"Error: Proof artifact {artifact_id!r} is missing retrieval_case_id.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if not title:
            print(
                f"Error: Proof artifact {artifact_id!r} is missing title.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        specs.append(
            ProofArtifactSpec(
                artifact_id=artifact_id,
                comparison_type=comparison_type,
                retrieval_case_id=retrieval_case_id,
                title=title,
            )
        )
        seen_ids.add(artifact_id)
    return tuple(specs)


def ensure_report_cases(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_cases = report.get("cases")
    if not isinstance(raw_cases, list):
        print("Error: Retrieval report is missing a cases array.", file=sys.stderr)
        raise SystemExit(1)
    case_lookup: dict[str, dict[str, Any]] = {}
    for index, case_payload in enumerate(raw_cases):
        if not isinstance(case_payload, dict):
            print(
                f"Error: Retrieval report case {index} must be an object.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        case_id = str(case_payload.get("case_id") or "").strip()
        if not case_id:
            print(
                f"Error: Retrieval report case {index} is missing case_id.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if case_id in case_lookup:
            print(
                f"Error: Retrieval report contains duplicate case_id {case_id!r}.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        case_lookup[case_id] = case_payload
    return case_lookup


def require_methods(
    case_payload: dict[str, Any],
    *,
    case_id: str,
    methods: tuple[str, ...],
) -> dict[str, dict[str, Any]]:
    raw_methods = case_payload.get("methods")
    if not isinstance(raw_methods, dict):
        print(
            f"Error: Retrieval report case {case_id!r} is missing methods.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    resolved: dict[str, dict[str, Any]] = {}
    for method in methods:
        raw_payload = raw_methods.get(method)
        if not isinstance(raw_payload, dict):
            print(
                f"Error: Retrieval report case {case_id!r} is missing method {method!r}.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        resolved[method] = raw_payload
    return resolved


def parse_ranked_ids(
    raw_ids: Any,
    *,
    owner: str,
    allow_empty: bool,
) -> tuple[str, ...]:
    if not isinstance(raw_ids, list):
        print(f"Error: {owner} must be a JSON array of incident ids.", file=sys.stderr)
        raise SystemExit(1)
    parsed_ids: list[str] = []
    seen_ids: set[str] = set()
    for index, raw_value in enumerate(raw_ids):
        incident_id = str(raw_value or "").strip()
        if not incident_id:
            print(
                f"Error: {owner}[{index}] must be a non-empty incident id.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if incident_id in seen_ids:
            print(
                f"Error: {owner} contains duplicate incident id {incident_id!r}.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        parsed_ids.append(incident_id)
        seen_ids.add(incident_id)
    if not allow_empty and not parsed_ids:
        print(f"Error: {owner} must not be empty.", file=sys.stderr)
        raise SystemExit(1)
    return tuple(parsed_ids)


def require_returned_ids(
    method_payload: dict[str, Any],
    *,
    case_id: str,
    method: str,
) -> tuple[str, ...]:
    return parse_ranked_ids(
        method_payload.get("returned_ids"),
        owner=f"Retrieval report case {case_id!r} method {method!r} returned_ids",
        allow_empty=True,
    )


def ensure_report_case_matches_case(
    report_case: dict[str, Any],
    *,
    case: retrieval.RetrievalCase,
) -> None:
    reported_query = require_string(
        require_object_key(
            report_case,
            key="query",
            owner=f"Retrieval report case {case.case_id!r}",
        ),
        owner=f"Retrieval report case {case.case_id!r} query",
    )
    if reported_query != case.query:
        print(
            f"Error: Retrieval report case {case.case_id!r} query does not match the cases file.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    reported_filter = require_object_key(
        report_case,
        key="sql_filter",
        owner=f"Retrieval report case {case.case_id!r}",
    )
    normalized_filter = (
        None if reported_filter is None else (str(reported_filter).strip() or None)
    )
    if normalized_filter != case.sql_filter:
        print(
            f"Error: Retrieval report case {case.case_id!r} sql_filter does not match the cases file.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    normalized_relevant = parse_ranked_ids(
        require_object_key(
            report_case,
            key="relevant_incident_ids",
            owner=f"Retrieval report case {case.case_id!r}",
        ),
        owner=f"Retrieval report case {case.case_id!r} relevant_incident_ids",
        allow_empty=False,
    )
    if normalized_relevant != case.relevant_incident_ids:
        print(
            f"Error: Retrieval report case {case.case_id!r} relevant_incident_ids do not match the cases file.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def validate_report_metadata_against_inputs(
    report: dict[str, Any],
    *,
    manifest: dict[str, Any],
    manifest_path: Path,
    cases_path: Path,
) -> None:
    report_owner = "Retrieval report"
    expected_paths = {
        "manifest_path": manifest_path,
        "cases_path": cases_path,
        "lance_dataset_path": Path(str(manifest["lance_dataset_path"])).expanduser().resolve(),
        "source_parquet_path": Path(str(manifest["source_parquet_path"])).expanduser().resolve(),
    }
    for field, expected_path in expected_paths.items():
        reported_path = require_path_string(
            require_object_key(report, key=field, owner=report_owner),
            owner=f"{report_owner} field {field!r}",
        )
        if reported_path != expected_path:
            print(
                f"Error: Retrieval report field {field!r} does not match the provided input. "
                f"Expected {expected_path}, got {reported_path}.",
                file=sys.stderr,
            )
            raise SystemExit(1)

    expected_embedding_model = require_string(
        manifest.get("embedding_model"),
        owner="Manifest embedding_model",
    )
    for field in ("dataset_embedding_model", "query_embedding_model"):
        reported_model = require_string(
            require_object_key(report, key=field, owner=report_owner),
            owner=f"{report_owner} field {field!r}",
        )
        if reported_model != expected_embedding_model:
            print(
                f"Error: Retrieval report field {field!r} does not match the manifest embedding model. "
                f"Expected {expected_embedding_model!r}, got {reported_model!r}.",
                file=sys.stderr,
            )
            raise SystemExit(1)

    reported_dimension = require_object_key(
        report,
        key="vector_dimension",
        owner=report_owner,
    )
    try:
        normalized_dimension = int(reported_dimension)
    except (TypeError, ValueError):
        print(
            "Error: Retrieval report field 'vector_dimension' must be an integer.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
    expected_dimension = int(manifest["vector_dimension"])
    if normalized_dimension != expected_dimension:
        print(
            "Error: Retrieval report vector_dimension does not match the manifest. "
            f"Expected {expected_dimension}, got {normalized_dimension}.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def repo_relative_string(path: Path) -> str:
    resolved = path.expanduser().resolve()
    try:
        return resolved.relative_to(ROOT).as_posix()
    except ValueError:
        return str(resolved)


def row_lookup_by_incident_id(source_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(source_rows):
        incident_id = str(row.get("incident_id") or "").strip()
        if not incident_id:
            print(
                f"Error: Source dataset row {index} is missing incident_id.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if incident_id in lookup:
            print(
                f"Error: Source dataset incident_id values must be unique; found duplicate "
                f"{incident_id!r}.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        lookup[incident_id] = row
    return lookup


def normalize_timestamp(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return str(isoformat())
        except TypeError:
            pass
    return str(value)


def build_excerpt(value: Any, *, max_chars: int = 180) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        return "No excerpt available."
    if len(text) <= max_chars:
        return text
    return f"{text[: max_chars - 3].rstrip()}..."


def summarize_scope(sql_filter: str | None) -> str:
    if not sql_filter:
        return "No structured scope. This artifact isolates the semantic retrieval advantage."

    patterns = {
        "city_code": r"city_code\s*=\s*'([^']+)'",
        "doc_type": r"doc_type\s*=\s*'([^']+)'",
        "timestamp_ge": r"timestamp\s*>=\s*'([^']+)'",
        "timestamp_le": r"timestamp\s*<=\s*'([^']+)'",
    }
    parts: list[str] = []
    city_match = re.search(patterns["city_code"], sql_filter)
    if city_match:
        parts.append(f"city {city_match.group(1)}")
    doc_match = re.search(patterns["doc_type"], sql_filter)
    if doc_match:
        parts.append(f"document type {doc_match.group(1)}")
    start_match = re.search(patterns["timestamp_ge"], sql_filter)
    if start_match:
        parts.append(f"from {start_match.group(1)}")
    end_match = re.search(patterns["timestamp_le"], sql_filter)
    if end_match:
        parts.append(f"through {end_match.group(1)}")
    return " | ".join(parts) if parts else sql_filter


def build_operator_task(case: retrieval.RetrievalCase) -> str:
    if case.sql_filter:
        return (
            f"Answer the archive question '{case.query}' within the constrained "
            f"{summarize_scope(case.sql_filter)} slice."
        )
    return f"Answer the archive question '{case.query}' without relying on exact keyword overlap."


def build_primary_evidence_label(row: dict[str, Any]) -> str:
    return (
        f"{row['incident_id']} | {row['doc_type']} | {row['city_code']} | "
        f"{row['timestamp']}"
    )


def build_result_entry(
    row: dict[str, Any],
    *,
    rank: int,
    filter_expr: retrieval.FilterExpr | None,
    relevant_ids: set[str],
) -> dict[str, Any]:
    incident_id = str(row.get("incident_id") or "").strip()
    scope_match = (
        None
        if filter_expr is None
        else bool(retrieval.evaluate_filter(filter_expr, row))
    )
    return {
        "rank": rank,
        "incident_id": incident_id,
        "city_code": str(row.get("city_code") or ""),
        "doc_type": str(row.get("doc_type") or ""),
        "timestamp": normalize_timestamp(row.get("timestamp")),
        "is_labeled_positive": incident_id in relevant_ids,
        "matches_scope": scope_match,
        "excerpt": build_excerpt(row.get("text_content")),
    }


def build_rows_from_ids(
    incident_ids: list[str],
    *,
    row_by_id: dict[str, dict[str, Any]],
    filter_expr: retrieval.FilterExpr | None,
    relevant_ids: set[str],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for rank, incident_id in enumerate(incident_ids, start=1):
        if incident_id not in row_by_id:
            print(
                f"Error: Incident id {incident_id!r} was referenced in the retrieval report "
                "but not found in the source dataset.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        rows.append(
            build_result_entry(
                row_by_id[incident_id],
                rank=rank,
                filter_expr=filter_expr,
                relevant_ids=relevant_ids,
            )
        )
    return rows


def build_rows_from_search_execution(
    search_execution: retrieval.SearchExecution,
    *,
    filter_expr: retrieval.FilterExpr | None,
    relevant_ids: set[str],
) -> list[dict[str, Any]]:
    return [
        build_result_entry(
            row,
            rank=index,
            filter_expr=filter_expr,
            relevant_ids=relevant_ids,
        )
        for index, row in enumerate(search_execution.rows, start=1)
    ]


def count_scope_matches(rows: list[dict[str, Any]]) -> int | None:
    if not rows:
        return None
    if all(row["matches_scope"] is None for row in rows):
        return None
    return sum(1 for row in rows if row["matches_scope"] is True)


def labeled_hits(rows: list[dict[str, Any]]) -> list[str]:
    return [row["incident_id"] for row in rows if row["is_labeled_positive"]]


def scope_miss_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if row["matches_scope"] is False]


def build_mode_summary(
    *,
    mode: str,
    label: str,
    rows: list[dict[str, Any]],
    relevant_ids: tuple[str, ...],
    case_limit: int,
    weaker_mode: bool,
    trace_mode: bool,
) -> dict[str, Any]:
    hit_ids = labeled_hits(rows)
    scope_match_count = count_scope_matches(rows)
    missed_ids = [
        incident_id for incident_id in relevant_ids if incident_id not in hit_ids
    ]
    unlabeled_count = sum(1 for row in rows if not row["is_labeled_positive"])
    summary = {
        "mode": mode,
        "label": label,
        "returned_count": len(rows),
        "returned_ids": [row["incident_id"] for row in rows],
        "labeled_hit_ids": hit_ids,
        "missed_labeled_ids": missed_ids,
        "scope_match_count": scope_match_count,
        "scope_miss_ids": [row["incident_id"] for row in scope_miss_rows(rows)],
        "top_results": rows[:TOP_RESULTS_LIMIT],
    }

    relevant_total = len(relevant_ids)
    if weaker_mode and mode == retrieval.METHOD_KEYWORD_ONLY:
        parts = [
            f"Keyword-only returned {len(hit_ids)} of {relevant_total} labeled positives in the top {case_limit}."
        ]
        if missed_ids:
            parts.append(f"It missed {len(missed_ids)} labeled incident(s).")
        if unlabeled_count:
            parts.append(f"{unlabeled_count} returned row(s) were unlabeled matches.")
        summary["summary"] = " ".join(parts)
    elif weaker_mode:
        scope_misses = scope_miss_rows(rows)
        if scope_misses:
            cities = sorted({row["city_code"] for row in scope_misses})
            city_text = ", ".join(cities)
            summary["summary"] = (
                f"Semantic-only vector retrieval returned {len(hit_ids)} of {relevant_total} labeled positives "
                f"but surfaced {len(scope_misses)} out-of-scope row(s) from {city_text} in the top {case_limit}."
            )
        else:
            summary["summary"] = (
                f"Semantic-only vector retrieval returned {len(hit_ids)} of {relevant_total} labeled positives "
                "and kept every returned row inside scope."
            )
    elif trace_mode and scope_match_count is not None:
        summary["summary"] = (
            f"Trace returned {len(hit_ids)} of {relevant_total} labeled positives and kept "
            f"{scope_match_count} of {len(rows)} returned rows inside the requested scope."
        )
    else:
        summary["summary"] = (
            f"Trace returned {len(hit_ids)} of {relevant_total} labeled positives in the top "
            f"{case_limit} without relying on exact keyword overlap."
        )
    return summary


def validate_keyword_vs_trace_claim(
    *,
    spec: ProofArtifactSpec,
    keyword_summary: dict[str, Any],
    trace_summary: dict[str, Any],
) -> None:
    if not keyword_summary["missed_labeled_ids"]:
        print(
            f"Error: Proof artifact {spec.artifact_id!r} cannot claim a keyword gap because "
            "keyword-only did not miss any labeled positives.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    if len(trace_summary["labeled_hit_ids"]) <= len(keyword_summary["labeled_hit_ids"]):
        print(
            f"Error: Proof artifact {spec.artifact_id!r} cannot claim a Trace win because "
            "Trace did not retrieve more labeled positives than keyword-only.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def validate_semantic_scope_claim(
    *,
    spec: ProofArtifactSpec,
    case: retrieval.RetrievalCase,
    weaker_summary: dict[str, Any],
    trace_summary: dict[str, Any],
) -> None:
    if case.sql_filter is None or case.filter_expr is None:
        print(
            f"Error: Proof artifact {spec.artifact_id!r} uses semantic_scope but "
            f"retrieval case {case.case_id!r} has no sql_filter.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    if not weaker_summary["scope_miss_ids"]:
        print(
            f"Error: Proof artifact {spec.artifact_id!r} cannot claim a scope gap because "
            "semantic-only results stayed within scope.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    if trace_summary["scope_miss_ids"]:
        print(
            f"Error: Proof artifact {spec.artifact_id!r} cannot claim a scope-preserving Trace win "
            "because Trace returned out-of-scope rows.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    if trace_summary["scope_match_count"] is None:
        print(
            f"Error: Proof artifact {spec.artifact_id!r} is missing scope annotations for Trace results.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    weaker_scope_matches = weaker_summary["scope_match_count"]
    if weaker_scope_matches is None or trace_summary["scope_match_count"] <= weaker_scope_matches:
        print(
            f"Error: Proof artifact {spec.artifact_id!r} cannot claim a Trace scope advantage because "
            "Trace did not preserve more in-scope rows than semantic-only retrieval.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def build_comparison_table_rows(mode_summaries: list[dict[str, Any]]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for summary in mode_summaries:
        scope_match_count = summary["scope_match_count"]
        rows.append(
            {
                "mode": summary["label"],
                "labeled_hits": (
                    f"{len(summary['labeled_hit_ids'])}/{len(summary['labeled_hit_ids']) + len(summary['missed_labeled_ids'])}"
                ),
                "scope_matches": (
                    "n/a"
                    if scope_match_count is None
                    else f"{scope_match_count}/{summary['returned_count']}"
                ),
                "takeaway": summary["summary"],
            }
        )
    return rows


def build_handoff(
    *,
    artifact_id: str,
    case: retrieval.RetrievalCase,
    trace_summary: dict[str, Any],
    weaker_summary: dict[str, Any],
) -> dict[str, str]:
    if not trace_summary["top_results"]:
        print(
            f"Error: Proof artifact {artifact_id!r} cannot build a handoff because Trace "
            "returned no rows.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    primary_row = next(
        (row for row in trace_summary["top_results"] if row["is_labeled_positive"]),
        trace_summary["top_results"][0],
    )
    if case.sql_filter:
        suggested_handoff = (
            f"Escalate incident {primary_row['incident_id']} with the filtered evidence pack "
            f"for {summarize_scope(case.sql_filter)} before regulator or compliance review."
        )
    else:
        suggested_handoff = (
            f"Escalate incident {primary_row['incident_id']} with the semantic evidence trail "
            "instead of relying on exact keyword matches."
        )
    return {
        "investigation_goal": case.query,
        "applied_scope": summarize_scope(case.sql_filter),
        "primary_evidence": build_primary_evidence_label(primary_row),
        "why_trace_wins": trace_summary["summary"],
        "why_weaker_mode_failed": weaker_summary["summary"],
        "suggested_handoff": suggested_handoff,
        "boundary": "Templated from the retrieved evidence and mode summaries; not a separate model output.",
    }


def build_keyword_vs_trace_artifact(
    spec: ProofArtifactSpec,
    *,
    case: retrieval.RetrievalCase,
    report_case: dict[str, Any],
    row_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    relevant_ids = set(case.relevant_incident_ids)
    methods = require_methods(
        report_case,
        case_id=case.case_id,
        methods=(retrieval.METHOD_KEYWORD_ONLY, retrieval.METHOD_TRACE_PREFILTER),
    )
    keyword_rows = build_rows_from_ids(
        list(
            require_returned_ids(
                methods[retrieval.METHOD_KEYWORD_ONLY],
                case_id=case.case_id,
                method=retrieval.METHOD_KEYWORD_ONLY,
            )
        ),
        row_by_id=row_by_id,
        filter_expr=None,
        relevant_ids=relevant_ids,
    )
    trace_rows = build_rows_from_ids(
        list(
            require_returned_ids(
                methods[retrieval.METHOD_TRACE_PREFILTER],
                case_id=case.case_id,
                method=retrieval.METHOD_TRACE_PREFILTER,
            )
        ),
        row_by_id=row_by_id,
        filter_expr=None,
        relevant_ids=relevant_ids,
    )
    keyword_summary = build_mode_summary(
        mode=retrieval.METHOD_KEYWORD_ONLY,
        label="Keyword only",
        rows=keyword_rows,
        relevant_ids=case.relevant_incident_ids,
        case_limit=case.limit,
        weaker_mode=True,
        trace_mode=False,
    )
    trace_summary = build_mode_summary(
        mode=retrieval.METHOD_TRACE_PREFILTER,
        label="Trace hybrid",
        rows=trace_rows,
        relevant_ids=case.relevant_incident_ids,
        case_limit=case.limit,
        weaker_mode=False,
        trace_mode=False,
    )
    validate_keyword_vs_trace_claim(
        spec=spec,
        keyword_summary=keyword_summary,
        trace_summary=trace_summary,
    )
    return {
        "artifact_id": spec.artifact_id,
        "comparison_type": spec.comparison_type,
        "title": spec.title,
        "retrieval_case_id": case.case_id,
        "query": case.query,
        "operator_task": build_operator_task(case),
        "applied_scope": {
            "sql_filter": case.sql_filter,
            "summary": summarize_scope(case.sql_filter),
        },
        "labeled_positive_ids": list(case.relevant_incident_ids),
        "comparison_table": build_comparison_table_rows(
            [keyword_summary, trace_summary]
        ),
        "modes": {
            "weaker": keyword_summary,
            "trace": trace_summary,
        },
        "operator_handoff_note": build_handoff(
            artifact_id=spec.artifact_id,
            case=case,
            trace_summary=trace_summary,
            weaker_summary=keyword_summary,
        ),
    }


def build_semantic_scope_artifact(
    spec: ProofArtifactSpec,
    *,
    case: retrieval.RetrievalCase,
    report_case: dict[str, Any],
    row_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    relevant_ids = set(case.relevant_incident_ids)
    methods = require_methods(
        report_case,
        case_id=case.case_id,
        methods=(
            retrieval.METHOD_TRACE_PREFILTER,
            retrieval.METHOD_SEMANTIC_ONLY_VECTOR,
        ),
    )
    trace_rows = build_rows_from_ids(
        list(
            require_returned_ids(
                methods[retrieval.METHOD_TRACE_PREFILTER],
                case_id=case.case_id,
                method=retrieval.METHOD_TRACE_PREFILTER,
            )
        ),
        row_by_id=row_by_id,
        filter_expr=case.filter_expr,
        relevant_ids=relevant_ids,
    )
    semantic_rows = build_rows_from_ids(
        list(
            require_returned_ids(
                methods[retrieval.METHOD_SEMANTIC_ONLY_VECTOR],
                case_id=case.case_id,
                method=retrieval.METHOD_SEMANTIC_ONLY_VECTOR,
            )
        ),
        row_by_id=row_by_id,
        filter_expr=case.filter_expr,
        relevant_ids=relevant_ids,
    )
    weaker_summary = build_mode_summary(
        mode=retrieval.METHOD_SEMANTIC_ONLY_VECTOR,
        label="Semantic only",
        rows=semantic_rows,
        relevant_ids=case.relevant_incident_ids,
        case_limit=case.limit,
        weaker_mode=True,
        trace_mode=False,
    )
    trace_summary = build_mode_summary(
        mode=retrieval.METHOD_TRACE_PREFILTER,
        label="Trace hybrid",
        rows=trace_rows,
        relevant_ids=case.relevant_incident_ids,
        case_limit=case.limit,
        weaker_mode=False,
        trace_mode=True,
    )
    validate_semantic_scope_claim(
        spec=spec,
        case=case,
        weaker_summary=weaker_summary,
        trace_summary=trace_summary,
    )
    return {
        "artifact_id": spec.artifact_id,
        "comparison_type": spec.comparison_type,
        "title": spec.title,
        "retrieval_case_id": case.case_id,
        "query": case.query,
        "operator_task": build_operator_task(case),
        "applied_scope": {
            "sql_filter": case.sql_filter,
            "summary": summarize_scope(case.sql_filter),
        },
        "labeled_positive_ids": list(case.relevant_incident_ids),
        "comparison_table": build_comparison_table_rows(
            [weaker_summary, trace_summary]
        ),
        "modes": {
            "weaker": weaker_summary,
            "trace": trace_summary,
        },
        "operator_handoff_note": build_handoff(
            artifact_id=spec.artifact_id,
            case=case,
            trace_summary=trace_summary,
            weaker_summary=weaker_summary,
        ),
    }


def render_comparison_table(rows: list[dict[str, str]]) -> list[str]:
    lines = [
        "| Mode | Labeled hits in top 5 | Rows in intended scope | What happened |",
        "| --- | ---: | ---: | --- |",
    ]
    for row in rows:
        lines.append(
            f"| {row['mode']} | {row['labeled_hits']} | {row['scope_matches']} | {row['takeaway']} |"
        )
    return lines


def render_top_results_table(rows: list[dict[str, Any]]) -> list[str]:
    lines = [
        "| Rank | Incident ID | City | Document Type | Labeled positive | Scope match |",
        "| ---: | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        scope_text = (
            "n/a"
            if row["matches_scope"] is None
            else ("yes" if row["matches_scope"] else "no")
        )
        hit_text = "yes" if row["is_labeled_positive"] else "no"
        lines.append(
            f"| {row['rank']} | `{row['incident_id']}` | `{row['city_code']}` | "
            f"`{row['doc_type']}` | {hit_text} | {scope_text} |"
        )
    return lines


def render_mode_block(summary: dict[str, Any]) -> list[str]:
    lines = [f"### {summary['label']}", ""]
    lines.extend(render_top_results_table(summary["top_results"]))
    lines.extend(["", f"Mode note: {summary['summary']}", ""])
    return lines


def render_handoff_block(handoff: dict[str, str]) -> list[str]:
    return [
        "Templated operator handoff note:",
        "",
        f"> Goal: {handoff['investigation_goal']}",
        f"> Scope: {handoff['applied_scope']}",
        f"> Primary evidence: {handoff['primary_evidence']}",
        f"> Why Trace wins: {handoff['why_trace_wins']}",
        f"> Why the weaker mode failed: {handoff['why_weaker_mode_failed']}",
        f"> Suggested handoff: {handoff['suggested_handoff']}",
        f"> Boundary: {handoff['boundary']}",
        "",
    ]


def render_markdown(snapshot: dict[str, Any]) -> str:
    def render_section(artifact: dict[str, Any], heading: str) -> list[str]:
        lines = [
            f"## {heading}",
            "",
            f"- Artifact ID: `{artifact['artifact_id']}`",
            f"- Query: `{artifact['query']}`",
            f"- Intended operator task: {artifact['operator_task']}",
            f"- Applied scope: {artifact['applied_scope']['summary']}",
            f"- Displayed rows: Full top {TOP_RESULTS_LIMIT} returned rows per mode for auditability.",
            "",
        ]
        lines.extend(render_comparison_table(artifact["comparison_table"]))
        lines.append("")
        lines.extend(render_mode_block(artifact["modes"]["weaker"]))
        lines.extend(render_mode_block(artifact["modes"]["trace"]))
        lines.extend(render_handoff_block(artifact["operator_handoff_note"]))
        return lines

    lines = [
        "# Proof Of Value",
        "",
        "This committed proof pack packages two selected local comparison artifacts",
        "from the current embedding-backed eval corpus. It is reusable judge-facing",
        "local evidence, not proof of deployed-path equivalence or a broad benchmark.",
        "",
        SELECTION_NOTE,
        "",
    ]
    heading_lookup = {
        "insurance-keyword-gap": "Keyword search missed the right incidents",
        "insurance-scope-gap": "Semantic search needed operational scope",
    }
    for artifact in snapshot["artifacts"]:
        lines.extend(
            render_section(
                artifact,
                heading_lookup.get(artifact["artifact_id"], artifact["title"]),
            )
        )
    return "\n".join(lines).rstrip() + "\n"


def build_snapshot(
    *,
    manifest_path: Path,
    retrieval_report_path: Path,
    cases_path: Path,
    proof_config_path: Path,
) -> dict[str, Any]:
    proof_specs = load_proof_config(proof_config_path)
    manifest = retrieval.load_manifest(manifest_path.expanduser().resolve())
    retrieval.validate_manifest_or_exit(
        manifest,
        manifest_path.expanduser().resolve(),
    )
    retrieval_cases = {
        case.case_id: case
        for case in retrieval.load_cases(cases_path.expanduser().resolve())
    }
    report = load_json_object(retrieval_report_path, label="Retrieval report")
    validate_report_metadata_against_inputs(
        report,
        manifest=manifest,
        manifest_path=manifest_path,
        cases_path=cases_path,
    )
    report_cases = ensure_report_cases(report)
    source_rows = retrieval.load_source_rows(manifest)
    retrieval.validate_cases_against_source_rows_or_exit(
        list(retrieval_cases.values()),
        source_rows,
    )
    row_by_id = row_lookup_by_incident_id(source_rows)

    artifacts: list[dict[str, Any]] = []
    for spec in proof_specs:
        case = retrieval_cases.get(spec.retrieval_case_id)
        if case is None:
            print(
                f"Error: Proof artifact {spec.artifact_id!r} references missing retrieval case "
                f"{spec.retrieval_case_id!r}.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        report_case = report_cases.get(case.case_id)
        if report_case is None:
            print(
                f"Error: Retrieval report {retrieval_report_path} is missing case "
                f"{case.case_id!r} required by proof artifact {spec.artifact_id!r}.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        ensure_report_case_matches_case(report_case, case=case)
        if spec.comparison_type == COMPARISON_KEYWORD_VS_TRACE:
            artifact = build_keyword_vs_trace_artifact(
                spec,
                case=case,
                report_case=report_case,
                row_by_id=row_by_id,
            )
        else:
            artifact = build_semantic_scope_artifact(
                spec,
                case=case,
                report_case=report_case,
                row_by_id=row_by_id,
            )
        artifacts.append(artifact)

    return {
        "version": SNAPSHOT_VERSION,
        "evidence_boundary": LOCAL_EVIDENCE_BOUNDARY,
        "selection_note": SELECTION_NOTE,
        "cases_path": repo_relative_string(cases_path),
        "proof_config_path": repo_relative_string(proof_config_path),
        "displayed_results_per_mode": TOP_RESULTS_LIMIT,
        "dataset_embedding_model": str(manifest.get("embedding_model") or ""),
        "vector_dimension": int(manifest["vector_dimension"]),
        "artifacts": artifacts,
    }


def main() -> int:
    args = parse_args()
    manifest_path = args.manifest_path.expanduser().resolve()
    retrieval_report_path = args.retrieval_report.expanduser().resolve()
    cases_path = args.cases_path.expanduser().resolve()
    proof_config_path = args.proof_config.expanduser().resolve()
    output_json = args.output_json.expanduser().resolve()
    output_markdown = args.output_markdown.expanduser().resolve()

    snapshot = build_snapshot(
        manifest_path=manifest_path,
        retrieval_report_path=retrieval_report_path,
        cases_path=cases_path,
        proof_config_path=proof_config_path,
    )
    markdown = render_markdown(snapshot)
    retrieval.write_json(output_json, snapshot)
    retrieval.write_text(output_markdown, markdown)
    print(f"Proof snapshot: {output_json}")
    print(f"Proof markdown: {output_markdown}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
