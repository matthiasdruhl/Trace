"""
Step 4 evidence packager for Trace.

Combines the latest local retrieval report and a deployed benchmark artifact into
one canonical judge-facing Markdown doc and one machine-readable snapshot.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from prove_deployed_path import EVAL_DATASET_URI, EVAL_STACK_NAME  # noqa: E402
from trace_runtime import TraceRuntimeError, lambda_function_name_from_arn, write_json  # noqa: E402


DEFAULT_DOC_PATH = Path("docs/BENCHMARK_EVIDENCE.md")
DEFAULT_SNAPSHOT_PATH = Path("fixtures/eval/benchmark_evidence_snapshot.json")
DEFAULT_RETRIEVAL_CASES_PATH = Path("fixtures/eval/retrieval_relevance_cases.json")
DEFAULT_LOCAL_VALIDATION_CASES_PATH = Path("fixtures/eval/local_validation_cases.json")
DEFAULT_BENCHMARK_ROOT = Path("artifacts/benchmarks")
DEFAULT_EVALUATION_ROOT = Path("artifacts/evaluations")
REQUIRED_EMBEDDING_MODEL = "text-embedding-3-small"
REQUIRED_RETRIEVAL_METHODS = (
    "trace_prefilter_vector",
    "keyword_only",
    "vector_postfilter",
)
REQUIRED_BENCHMARK_CASE_IDS = (
    "unfiltered-demo",
    "filtered-chi-insurance",
)
EXPECTED_EVAL_FUNCTION_NAME = f"{EVAL_STACK_NAME}-trace-search"
REQUIRED_COST_NOTES_FRAGMENTS = (
    "lambda request cost",
    "lambda compute cost",
    "api gateway http api request cost",
    "excludes query-embedding cost",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Package Step 4 benchmark and evaluation evidence into canonical repo artifacts."
    )
    parser.add_argument(
        "--retrieval-report",
        type=Path,
        default=None,
        help="Path to a retrieval report.json. Defaults to the latest artifacts/evaluations/*/report.json.",
    )
    parser.add_argument(
        "--benchmark-report",
        type=Path,
        default=None,
        help="Path to a benchmark.json. Defaults to the latest artifacts/benchmarks/*/benchmark.json.",
    )
    parser.add_argument(
        "--doc-path",
        type=Path,
        default=DEFAULT_DOC_PATH,
        help=f"Canonical Markdown output path (default: {DEFAULT_DOC_PATH}).",
    )
    parser.add_argument(
        "--snapshot-path",
        type=Path,
        default=DEFAULT_SNAPSHOT_PATH,
        help=f"Machine-readable snapshot output path (default: {DEFAULT_SNAPSHOT_PATH}).",
    )
    return parser.parse_args()


def _latest_artifact_path(root: Path, filename: str) -> Path:
    if not root.is_dir():
        raise TraceRuntimeError(f"Artifact root not found: {root}")
    candidates = [path / filename for path in sorted(root.iterdir(), reverse=True) if (path / filename).is_file()]
    if not candidates:
        raise TraceRuntimeError(f"No {filename} files found under {root}")
    return candidates[0]


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise TraceRuntimeError(f"Expected a JSON object in {path}, got {type(payload).__name__}.")
    return payload


def _require_mapping(value: Any, *, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TraceRuntimeError(f"{label} must be a JSON object, got {type(value).__name__}.")
    return value


def _require_list(value: Any, *, label: str, min_length: int = 0) -> list[Any]:
    if not isinstance(value, list):
        raise TraceRuntimeError(f"{label} must be a JSON array, got {type(value).__name__}.")
    if len(value) < min_length:
        raise TraceRuntimeError(f"{label} must contain at least {min_length} item(s).")
    return value


def _require_string(
    value: Any,
    *,
    label: str,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        raise TraceRuntimeError(f"{label} must be a string, got {type(value).__name__}.")
    if not allow_empty and not value.strip():
        raise TraceRuntimeError(f"{label} must be a non-empty string.")
    return value


def _require_bool(value: Any, *, label: str) -> bool:
    if not isinstance(value, bool):
        raise TraceRuntimeError(f"{label} must be a boolean, got {type(value).__name__}.")
    return value


def _require_path(value: Any, *, label: str) -> Path:
    return Path(_require_string(value, label=label)).expanduser().resolve()


def _require_float(value: Any, *, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TraceRuntimeError(f"{label} must be numeric, got {type(value).__name__}.")
    return float(value)


def _require_int(value: Any, *, label: str, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TraceRuntimeError(f"{label} must be an integer, got {type(value).__name__}.")
    if minimum is not None and value < minimum:
        raise TraceRuntimeError(f"{label} must be >= {minimum}, got {value}.")
    return value


def _resolve_metric(metrics: dict[str, Any], key: str, fallback_key: str | None = None) -> float:
    value = metrics.get(key)
    if value is None and fallback_key is not None:
        value = metrics.get(fallback_key)
    if value is None:
        fallback_note = f" or {fallback_key!r}" if fallback_key is not None else ""
        raise TraceRuntimeError(f"Metric {key!r}{fallback_note} is required.")
    return _require_float(value, label=f"Metric {key!r}")


def _normalize_s3_uri(uri: str) -> str:
    cleaned = uri.strip()
    if not cleaned:
        raise TraceRuntimeError("dataset_uri must be a non-empty string.")
    return cleaned.rstrip("/") + "/"


def _validate_summary_report_link(
    summary: dict[str, Any],
    report: dict[str, Any],
    *,
    label: str,
) -> None:
    for key in (
        "generated_at",
        "report_path",
        "cases_path",
        "passed",
        "case_count",
        "passed_case_count",
        "failed_case_count",
        "embedding_model",
        "dataset_embedding_model",
        "query_embedding_model",
        "vector_dimension",
    ):
        if summary.get(key) != report.get(key):
            raise TraceRuntimeError(
                f"{label} field {key!r} does not match the referenced validation report."
            )


def _validate_retrieval_provenance(report: dict[str, Any]) -> dict[str, Any]:
    manifest_path = _require_path(
        report.get("manifest_path"),
        label="Retrieval report manifest_path",
    )
    manifest = _load_json(manifest_path)
    report_dataset_path = _require_path(
        report.get("lance_dataset_path"),
        label="Retrieval report lance_dataset_path",
    )
    manifest_dataset_path = _require_path(
        manifest.get("lance_dataset_path"),
        label="Retrieval manifest lance_dataset_path",
    )
    if report_dataset_path != manifest_dataset_path:
        raise TraceRuntimeError(
            "Retrieval report lance_dataset_path does not match the referenced manifest."
        )

    report_source_parquet_path = _require_path(
        report.get("source_parquet_path"),
        label="Retrieval report source_parquet_path",
    )
    manifest_source_parquet_path = _require_path(
        manifest.get("source_parquet_path"),
        label="Retrieval manifest source_parquet_path",
    )
    if report_source_parquet_path != manifest_source_parquet_path:
        raise TraceRuntimeError(
            "Retrieval report source_parquet_path does not match the referenced manifest."
        )

    manifest_embedding_model = _require_string(
        manifest.get("embedding_model"),
        label="Retrieval manifest embedding_model",
    )
    report_vector_dimension = _require_int(
        report.get("vector_dimension"),
        label="Retrieval report vector_dimension",
        minimum=1,
    )
    manifest_vector_dimension = _require_int(
        manifest.get("vector_dimension"),
        label="Retrieval manifest vector_dimension",
        minimum=1,
    )
    if report_vector_dimension != manifest_vector_dimension:
        raise TraceRuntimeError(
            "Retrieval report vector_dimension does not match the referenced manifest."
        )

    latest_local_validation = _require_mapping(
        manifest.get("latest_local_validation"),
        label="Retrieval manifest latest_local_validation",
    )
    validation_report_path = _require_path(
        latest_local_validation.get("report_path"),
        label="Retrieval manifest latest_local_validation report_path",
    )
    validation_cases_path = _require_path(
        latest_local_validation.get("cases_path"),
        label="Retrieval manifest latest_local_validation cases_path",
    )
    expected_validation_cases_path = DEFAULT_LOCAL_VALIDATION_CASES_PATH.resolve()
    if validation_cases_path != expected_validation_cases_path:
        raise TraceRuntimeError(
            "Retrieval manifest latest_local_validation cases_path must point to the approved "
            f"current eval corpus validator cases at {expected_validation_cases_path}."
        )
    if not _require_bool(
        latest_local_validation.get("passed"),
        label="Retrieval manifest latest_local_validation passed",
    ):
        raise TraceRuntimeError(
            "Retrieval manifest latest_local_validation must record a passing approval run."
        )

    validation_report = _load_json(validation_report_path)
    _validate_summary_report_link(
        latest_local_validation,
        validation_report,
        label="Retrieval manifest latest_local_validation",
    )
    if not _require_bool(
        validation_report.get("passed"),
        label="Retrieval approval validation report passed",
    ):
        raise TraceRuntimeError(
            "Retrieval approval validation report must record a passing approval run."
        )
    validation_manifest_path = _require_path(
        validation_report.get("manifest_path"),
        label="Retrieval approval validation report manifest_path",
    )
    if validation_manifest_path != manifest_path:
        raise TraceRuntimeError(
            "Retrieval approval validation report manifest_path does not match the retrieval report manifest_path."
        )
    validation_dataset_path = _require_path(
        validation_report.get("lance_dataset_path"),
        label="Retrieval approval validation report lance_dataset_path",
    )
    if validation_dataset_path != report_dataset_path:
        raise TraceRuntimeError(
            "Retrieval approval validation report lance_dataset_path does not match the retrieval report."
        )
    for key in ("embedding_model", "dataset_embedding_model", "query_embedding_model"):
        validation_model = _require_string(
            validation_report.get(key),
            label=f"Retrieval approval validation report {key}",
        )
        if validation_model != manifest_embedding_model:
            raise TraceRuntimeError(
                f"Retrieval approval validation report field {key!r} must equal "
                f"{manifest_embedding_model!r}, got {validation_model!r}."
            )
    validation_vector_dimension = _require_int(
        validation_report.get("vector_dimension"),
        label="Retrieval approval validation report vector_dimension",
        minimum=1,
    )
    if validation_vector_dimension != manifest_vector_dimension:
        raise TraceRuntimeError(
            "Retrieval approval validation report vector_dimension does not match the referenced manifest."
        )

    return {
        "manifest_path": str(manifest_path),
        "source_parquet_path": str(report_source_parquet_path),
        "validation_report_path": str(validation_report_path),
        "validation_cases_path": str(validation_cases_path),
        "validation_generated_at": _require_string(
            validation_report.get("generated_at"),
            label="Retrieval approval validation report generated_at",
        ),
    }


def _validate_retrieval_cases(report: dict[str, Any], *, case_count: int) -> None:
    raw_cases = _require_list(report.get("cases"), label="Retrieval report cases", min_length=1)
    if len(raw_cases) != case_count:
        raise TraceRuntimeError(
            f"Retrieval report case_count={case_count} does not match cases length {len(raw_cases)}."
        )


def _validate_retrieval_methods(report: dict[str, Any]) -> None:
    methods = _require_list(report.get("methods"), label="Retrieval report methods", min_length=1)
    method_names = {
        item
        for item in methods
        if isinstance(item, str) and item.strip()
    }
    missing = [name for name in REQUIRED_RETRIEVAL_METHODS if name not in method_names]
    if missing:
        raise TraceRuntimeError(
            f"Retrieval report methods is missing required method(s): {missing!r}."
        )


def _validate_cost_scope(pricing: dict[str, Any]) -> dict[str, Any]:
    notes = _require_string(pricing.get("notes"), label="Benchmark pricing notes")
    notes_lc = notes.lower()
    missing_notes = [fragment for fragment in REQUIRED_COST_NOTES_FRAGMENTS if fragment not in notes_lc]
    if missing_notes:
        raise TraceRuntimeError(
            "Benchmark pricing notes must document the judge-facing cost scope. "
            f"Missing fragment(s): {missing_notes!r}."
        )
    if _require_bool(
        pricing.get("embedding_cost_included"),
        label="Benchmark pricing embedding_cost_included",
    ):
        raise TraceRuntimeError(
            "Judge-facing benchmark packaging requires embedding_cost_included=false."
        )
    return {
        "lambda_request_price_per_million": _require_float(
            pricing.get("lambda_request_price_per_million"),
            label="Benchmark pricing lambda_request_price_per_million",
        ),
        "lambda_gb_second_price": _require_float(
            pricing.get("lambda_gb_second_price"),
            label="Benchmark pricing lambda_gb_second_price",
        ),
        "api_gateway_http_request_price_per_million": _require_float(
            pricing.get("api_gateway_http_request_price_per_million"),
            label="Benchmark pricing api_gateway_http_request_price_per_million",
        ),
        "embedding_cost_included": False,
        "notes": notes,
    }


def _validate_search_url(search_url: str, *, region: str) -> str:
    parsed = urlparse(search_url)
    if parsed.scheme != "https":
        raise TraceRuntimeError(
            f"Benchmark runtime_context search_url must use https, got {search_url!r}."
        )
    if not parsed.netloc:
        raise TraceRuntimeError("Benchmark runtime_context search_url must include a hostname.")
    if not parsed.path.endswith("/search"):
        raise TraceRuntimeError(
            "Benchmark runtime_context search_url must end with '/search' for the deployed HTTP API."
        )
    if parsed.query or parsed.fragment:
        raise TraceRuntimeError(
            "Benchmark runtime_context search_url must not include a query string or fragment."
        )
    expected_host_fragment = f".execute-api.{region}.amazonaws.com"
    if expected_host_fragment not in parsed.netloc:
        raise TraceRuntimeError(
            f"Benchmark runtime_context search_url host must match region {region!r}, got {parsed.netloc!r}."
        )
    return search_url.rstrip("/")


def _validate_runtime_context(
    runtime_context: dict[str, Any],
    *,
    report: dict[str, Any],
) -> dict[str, Any]:
    stack_name = _require_string(
        runtime_context.get("stack_name"),
        label="Benchmark runtime_context stack_name",
    )
    if stack_name != EVAL_STACK_NAME:
        raise TraceRuntimeError(
            f"Judge-facing benchmark packaging requires stack_name {EVAL_STACK_NAME!r}, got {stack_name!r}."
        )

    dataset_uri = _normalize_s3_uri(
        _require_string(
            runtime_context.get("dataset_uri"),
            label="Benchmark runtime_context dataset_uri",
        )
    )
    if dataset_uri != EVAL_DATASET_URI:
        raise TraceRuntimeError(
            f"Judge-facing benchmark packaging requires dataset_uri {EVAL_DATASET_URI!r}, got {dataset_uri!r}."
        )

    region = _require_string(
        runtime_context.get("region"),
        label="Benchmark runtime_context region",
    )
    search_url = _validate_search_url(
        _require_string(
            runtime_context.get("search_url"),
            label="Benchmark runtime_context search_url",
        ),
        region=region,
    )
    function_arn = _require_string(
        runtime_context.get("function_arn"),
        label="Benchmark runtime_context function_arn",
    )
    function_name = _require_string(
        runtime_context.get("function_name"),
        label="Benchmark runtime_context function_name",
    )
    derived_function_name = lambda_function_name_from_arn(function_arn)
    if function_name != derived_function_name:
        raise TraceRuntimeError(
            "Benchmark runtime_context function_name must match the function_arn suffix; "
            f"got {function_name!r} vs {derived_function_name!r}."
        )
    if function_name != EXPECTED_EVAL_FUNCTION_NAME:
        raise TraceRuntimeError(
            "Judge-facing benchmark packaging requires the eval search Lambda. "
            f"Expected {EXPECTED_EVAL_FUNCTION_NAME!r}, got {function_name!r}."
        )
    arn_parts = function_arn.split(":")
    if len(arn_parts) < 7 or arn_parts[0] != "arn" or arn_parts[2] != "lambda":
        raise TraceRuntimeError(f"Benchmark runtime_context function_arn is invalid: {function_arn!r}.")
    arn_region = arn_parts[3]
    if arn_region != region:
        raise TraceRuntimeError(
            f"Benchmark runtime_context function_arn region {arn_region!r} does not match region {region!r}."
        )

    stack_outputs = report.get("stack_outputs")
    if stack_outputs is not None:
        stack_outputs = _require_mapping(stack_outputs, label="Benchmark stack_outputs")
        stack_search_url = _require_string(
            stack_outputs.get("SearchUrl"),
            label="Benchmark stack_outputs SearchUrl",
        ).rstrip("/")
        stack_function_arn = _require_string(
            stack_outputs.get("TraceSearchFunctionArn"),
            label="Benchmark stack_outputs TraceSearchFunctionArn",
        )
        if stack_search_url != search_url:
            raise TraceRuntimeError(
                "Benchmark runtime_context search_url does not match stack_outputs SearchUrl. "
                "Judge-facing packaging cannot certify an overridden HTTP endpoint."
            )
        if stack_function_arn != function_arn:
            raise TraceRuntimeError(
                "Benchmark runtime_context function_arn does not match stack_outputs TraceSearchFunctionArn. "
                "Judge-facing packaging cannot certify an overridden Lambda target."
            )

    configured_memory_mb = _require_int(
        runtime_context.get("configured_memory_mb"),
        label="Benchmark runtime_context configured_memory_mb",
        minimum=1,
    )
    architectures = _require_list(
        runtime_context.get("function_architectures"),
        label="Benchmark runtime_context function_architectures",
        min_length=1,
    )
    for idx, architecture in enumerate(architectures):
        _require_string(
            architecture,
            label=f"Benchmark runtime_context function_architectures[{idx}]",
        )

    embedding_model = _require_string(
        runtime_context.get("embedding_model"),
        label="Benchmark runtime_context embedding_model",
    )
    if embedding_model != REQUIRED_EMBEDDING_MODEL:
        raise TraceRuntimeError(
            f"Benchmark runtime_context embedding_model must equal {REQUIRED_EMBEDDING_MODEL!r}, got {embedding_model!r}."
        )

    return {
        **runtime_context,
        "stack_name": stack_name,
        "dataset_uri": dataset_uri,
        "region": region,
        "search_url": search_url,
        "function_arn": function_arn,
        "function_name": function_name,
        "configured_memory_mb": configured_memory_mb,
        "function_architectures": architectures,
        "embedding_model": embedding_model,
    }


def _validate_direct_lambda_cold_samples(report: dict[str, Any]) -> None:
    samples = _require_list(
        report.get("cold_lambda_samples"),
        label="Benchmark cold_lambda_samples",
        min_length=1,
    )
    versions_seen: set[str] = set()
    for index, sample in enumerate(samples, start=1):
        sample_obj = _require_mapping(sample, label=f"Benchmark cold_lambda_samples[{index}]")
        version = _require_string(
            sample_obj.get("lambda_version"),
            label=f"Benchmark cold_lambda_samples[{index}] lambda_version",
        )
        if version in versions_seen:
            raise TraceRuntimeError(
                f"Benchmark cold_lambda_samples reuses lambda_version {version!r}; "
                "judge-facing cold-start evidence requires freshly published versions."
            )
        versions_seen.add(version)
        report_obj = _require_mapping(
            sample_obj.get("report"),
            label=f"Benchmark cold_lambda_samples[{index}] report",
        )
        _require_float(
            report_obj.get("init_duration_ms"),
            label=f"Benchmark cold_lambda_samples[{index}] report.init_duration_ms",
        )
        _require_float(
            report_obj.get("billed_duration_ms"),
            label=f"Benchmark cold_lambda_samples[{index}] report.billed_duration_ms",
        )
        report_line = _require_string(
            report_obj.get("report_line"),
            label=f"Benchmark cold_lambda_samples[{index}] report.report_line",
        )
        if "Init Duration:" not in report_line:
            raise TraceRuntimeError(
                "Benchmark cold_lambda_samples report.report_line must include 'Init Duration:' "
                "to prove direct-Lambda cold-start evidence."
            )


def _validate_summary(
    summary: dict[str, Any],
    *,
    runtime_context: dict[str, Any],
) -> dict[str, Any]:
    normalized = {
        "cold_init_median_ms": _require_float(
            summary.get("cold_init_median_ms"),
            label="Benchmark summary cold_init_median_ms",
        ),
        "cold_init_p95_ms": _require_float(
            summary.get("cold_init_p95_ms"),
            label="Benchmark summary cold_init_p95_ms",
        ),
        "cold_lambda_billed_median_ms": _require_float(
            summary.get("cold_lambda_billed_median_ms"),
            label="Benchmark summary cold_lambda_billed_median_ms",
        ),
        "warm_http_latency_median_ms": _require_float(
            summary.get("warm_http_latency_median_ms"),
            label="Benchmark summary warm_http_latency_median_ms",
        ),
        "warm_http_latency_p95_ms": _require_float(
            summary.get("warm_http_latency_p95_ms"),
            label="Benchmark summary warm_http_latency_p95_ms",
        ),
        "warm_took_median_ms": _require_float(
            summary.get("warm_took_median_ms"),
            label="Benchmark summary warm_took_median_ms",
        ),
        "warm_took_p95_ms": _require_float(
            summary.get("warm_took_p95_ms"),
            label="Benchmark summary warm_took_p95_ms",
        ),
        "warm_lambda_billed_median_ms": _require_float(
            summary.get("warm_lambda_billed_median_ms"),
            label="Benchmark summary warm_lambda_billed_median_ms",
        ),
        "configured_memory_mb": _require_int(
            summary.get("configured_memory_mb"),
            label="Benchmark summary configured_memory_mb",
            minimum=1,
        ),
        "max_memory_used_mb": _require_int(
            summary.get("max_memory_used_mb"),
            label="Benchmark summary max_memory_used_mb",
            minimum=1,
        ),
        "estimated_warm_cost_per_query_usd": _require_float(
            summary.get("estimated_warm_cost_per_query_usd"),
            label="Benchmark summary estimated_warm_cost_per_query_usd",
        ),
        "estimated_cold_cost_per_query_usd": _require_float(
            summary.get("estimated_cold_cost_per_query_usd"),
            label="Benchmark summary estimated_cold_cost_per_query_usd",
        ),
    }
    if normalized["configured_memory_mb"] != runtime_context["configured_memory_mb"]:
        raise TraceRuntimeError(
            "Benchmark summary configured_memory_mb must match runtime_context configured_memory_mb."
        )
    if normalized["max_memory_used_mb"] > normalized["configured_memory_mb"]:
        raise TraceRuntimeError(
            "Benchmark summary max_memory_used_mb cannot exceed configured_memory_mb."
        )
    return normalized


def _validate_benchmark_case_ids(benchmark_cases: list[Any]) -> list[str]:
    case_ids = [
        item.get("case_id")
        for item in benchmark_cases
        if isinstance(item, dict) and isinstance(item.get("case_id"), str)
    ]
    for required_case_id in REQUIRED_BENCHMARK_CASE_IDS:
        if required_case_id not in case_ids:
            raise TraceRuntimeError(
                f"Benchmark report must include case_id {required_case_id!r}; got {case_ids!r}."
            )
    return case_ids


def validate_retrieval_report(report: dict[str, Any], report_path: Path) -> dict[str, Any]:
    _require_string(report.get("run_id"), label="Retrieval report run_id")
    _require_string(report.get("generated_at"), label="Retrieval report generated_at")
    cases_path = _require_path(report.get("cases_path"), label="Retrieval report cases_path")
    expected_cases_path = DEFAULT_RETRIEVAL_CASES_PATH.resolve()
    if cases_path != expected_cases_path:
        raise TraceRuntimeError(
            f"Retrieval report must use {expected_cases_path}, got {cases_path}."
        )
    provenance = _validate_retrieval_provenance(report)
    for key in ("embedding_model", "dataset_embedding_model", "query_embedding_model"):
        if str(report.get(key)) != REQUIRED_EMBEDDING_MODEL:
            raise TraceRuntimeError(
                f"Retrieval report field {key!r} must equal {REQUIRED_EMBEDDING_MODEL!r}, "
                f"got {report.get(key)!r} in {report_path}."
            )
    aggregate_metrics = report.get("aggregate_metrics")
    aggregate_metrics = _require_mapping(aggregate_metrics, label="Retrieval report aggregate_metrics")
    trace_metrics = _require_mapping(
        aggregate_metrics.get("trace_prefilter_vector"),
        label="Retrieval report aggregate_metrics.trace_prefilter_vector",
    )
    keyword_metrics = _require_mapping(
        aggregate_metrics.get("keyword_only"),
        label="Retrieval report aggregate_metrics.keyword_only",
    )
    vector_postfilter_metrics = _require_mapping(
        aggregate_metrics.get("vector_postfilter"),
        label="Retrieval report aggregate_metrics.vector_postfilter",
    )
    case_count = _require_int(report.get("case_count"), label="Retrieval report case_count", minimum=1)
    _validate_retrieval_cases(report, case_count=case_count)
    _validate_retrieval_methods(report)
    if not isinstance(trace_metrics, dict) or not isinstance(keyword_metrics, dict):
        raise TraceRuntimeError(
            "Retrieval report must include aggregate metrics for trace_prefilter_vector and keyword_only."
        )
    return {
        "report_path": str(report_path),
        "run_id": report.get("run_id"),
        "generated_at": report.get("generated_at"),
        "case_count": case_count,
        "embedding_model": report.get("embedding_model"),
        "dataset_path": report.get("lance_dataset_path"),
        "provenance": provenance,
        "evaluation_config": report.get("evaluation_config") or {},
        "trace": {
            "average_recall_at_k": _resolve_metric(trace_metrics, "average_recall_at_k"),
            "average_precision_at_k": _resolve_metric(trace_metrics, "average_precision_at_k"),
            "filtered_query_strict_accuracy": _resolve_metric(
                trace_metrics,
                "filtered_query_strict_accuracy",
                fallback_key="filtered_query_accuracy",
            ),
        },
        "keyword_only": {
            "average_recall_at_k": _resolve_metric(keyword_metrics, "average_recall_at_k"),
            "average_precision_at_k": _resolve_metric(keyword_metrics, "average_precision_at_k"),
            "filtered_query_strict_accuracy": _resolve_metric(
                keyword_metrics,
                "filtered_query_strict_accuracy",
                fallback_key="filtered_query_accuracy",
            ),
        },
        "vector_postfilter": {
            "average_recall_at_k": _resolve_metric(
                vector_postfilter_metrics, "average_recall_at_k"
            ),
            "average_precision_at_k": _resolve_metric(
                vector_postfilter_metrics, "average_precision_at_k"
            ),
            "filtered_query_strict_accuracy": _resolve_metric(
                vector_postfilter_metrics,
                "filtered_query_strict_accuracy",
                fallback_key="filtered_query_accuracy",
            ),
        },
    }


def validate_benchmark_report(report: dict[str, Any], report_path: Path) -> dict[str, Any]:
    _require_string(report.get("run_id"), label="Benchmark report run_id")
    _require_string(report.get("generated_at"), label="Benchmark report generated_at")
    runtime_context = _validate_runtime_context(
        _require_mapping(report.get("runtime_context"), label="Benchmark runtime_context"),
        report=report,
    )
    pricing = _validate_cost_scope(
        _require_mapping(report.get("pricing"), label="Benchmark pricing")
    )
    summary = _validate_summary(
        _require_mapping(report.get("summary"), label="Benchmark summary"),
        runtime_context=runtime_context,
    )
    benchmark_cases = _require_list(
        report.get("benchmark_cases"),
        label="Benchmark benchmark_cases",
        min_length=1,
    )
    _validate_direct_lambda_cold_samples(report)
    _require_list(report.get("warm_http_samples"), label="Benchmark warm_http_samples", min_length=1)
    _require_list(report.get("warm_lambda_samples"), label="Benchmark warm_lambda_samples", min_length=1)
    return {
        "report_path": str(report_path),
        "run_id": report.get("run_id"),
        "generated_at": report.get("generated_at"),
        "runtime_context": runtime_context,
        "pricing": pricing,
        "benchmark_case_ids": _validate_benchmark_case_ids(benchmark_cases),
        "summary": summary,
    }


def build_snapshot(
    *,
    retrieval: dict[str, Any],
    benchmark: dict[str, Any],
) -> dict[str, Any]:
    headline_claims = [
        (
            f"Trace reached `{retrieval['trace']['average_recall_at_k']:.3f}` average `Recall@k` "
            f"and `{retrieval['trace']['filtered_query_strict_accuracy']:.3f}` filtered strict "
            "accuracy on the current labeled eval corpus."
        ),
        (
            f"`keyword_only` lagged at `{retrieval['keyword_only']['average_recall_at_k']:.3f}` "
            f"average `Recall@k`, `{retrieval['keyword_only']['average_precision_at_k']:.3f}` "
            f"average `Precision@k`, and "
            f"`{retrieval['keyword_only']['filtered_query_strict_accuracy']:.3f}` filtered strict "
            "accuracy on that same corpus."
        ),
    ]
    benchmark_summary_line = (
        f"On the deployed `{benchmark['runtime_context']['stack_name']}` eval stack, warm HTTP "
        f"median latency was `{benchmark['summary']['warm_http_latency_median_ms']:.3f}` ms, "
        f"the search path reported median `took_ms` of `{benchmark['summary']['warm_took_median_ms']:.3f}` ms, "
        f"and direct-Lambda cold samples recorded median `Init Duration` of "
        f"`{benchmark['summary']['cold_init_median_ms']:.3f}` ms plus median billed duration of "
        f"`{benchmark['summary']['cold_lambda_billed_median_ms']:.3f}` ms."
    )
    return {
        "version": 1,
        "headline_claims": headline_claims,
        "benchmark_summary_line": benchmark_summary_line,
        "retrieval_evidence": retrieval,
        "deployed_benchmark_evidence": benchmark,
        "notes": {
            "vector_postfilter": (
                "vector_postfilter matched trace_prefilter_vector on the current corpus, "
                "but that tie is candidate-window-sensitive and is not promoted as the main "
                "judge-facing claim."
            ),
            "scope_boundary": (
                "Retrieval metrics are local evidence on the current labeled eval corpus. "
                "Benchmark metrics are deployed infra measurements on the eval stack. "
                "Neither should be described as broad benchmark superiority."
            ),
        },
        "source_artifacts": [
            retrieval["report_path"],
            benchmark["report_path"],
        ],
    }


def render_markdown(snapshot: dict[str, Any]) -> str:
    retrieval = snapshot["retrieval_evidence"]
    benchmark = snapshot["deployed_benchmark_evidence"]
    lines = [
        "# Benchmark Evidence",
        "",
        "## Headline Claims",
        "",
        f"- {snapshot['headline_claims'][0]}",
        f"- {snapshot['headline_claims'][1]}",
        f"- {snapshot['benchmark_summary_line']}",
        "",
        "## What We Measured",
        "",
        "- Local retrieval quality on the current labeled eval corpus using the committed retrieval harness.",
        "- Direct-Lambda cold-sample evidence plus deployed warm-path runtime behavior on the `trace-eval` stack.",
        "- Search-runtime cost estimates derived from measured billed duration and explicit pricing assumptions.",
        "",
        "## Current Numbers Table",
        "",
        "### Retrieval Evidence",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
        f"| Corpus | `current labeled eval corpus` |",
        f"| Approved corpus validation | `passed via {retrieval['provenance']['validation_cases_path']}` |",
        f"| Case count | `{retrieval['case_count']}` |",
        f"| Trace average Recall@k | `{retrieval['trace']['average_recall_at_k']:.3f}` |",
        f"| Trace average Precision@k | `{retrieval['trace']['average_precision_at_k']:.3f}` |",
        f"| Trace filtered strict accuracy | `{retrieval['trace']['filtered_query_strict_accuracy']:.3f}` |",
        f"| Keyword average Recall@k | `{retrieval['keyword_only']['average_recall_at_k']:.3f}` |",
        f"| Keyword average Precision@k | `{retrieval['keyword_only']['average_precision_at_k']:.3f}` |",
        f"| Keyword filtered strict accuracy | `{retrieval['keyword_only']['filtered_query_strict_accuracy']:.3f}` |",
        "",
        "### Deployed Benchmark Evidence",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
        f"| Cold Lambda init median (ms) | `{benchmark['summary']['cold_init_median_ms']:.3f}` |",
        f"| Cold Lambda init p95 (ms) | `{benchmark['summary']['cold_init_p95_ms']:.3f}` |",
        f"| Cold Lambda billed median (ms) | `{benchmark['summary']['cold_lambda_billed_median_ms']:.3f}` |",
        f"| Warm HTTP latency median (ms) | `{benchmark['summary']['warm_http_latency_median_ms']:.3f}` |",
        f"| Warm HTTP latency p95 (ms) | `{benchmark['summary']['warm_http_latency_p95_ms']:.3f}` |",
        f"| Warm took_ms median (ms) | `{benchmark['summary']['warm_took_median_ms']:.3f}` |",
        f"| Warm took_ms p95 (ms) | `{benchmark['summary']['warm_took_p95_ms']:.3f}` |",
        f"| Warm Lambda billed median (ms) | `{benchmark['summary']['warm_lambda_billed_median_ms']:.3f}` |",
        f"| Configured memory (MB) | `{benchmark['summary']['configured_memory_mb']}` |",
        f"| Max memory used (MB) | `{benchmark['summary']['max_memory_used_mb']}` |",
        f"| Estimated warm cost/query (USD) | `{benchmark['summary']['estimated_warm_cost_per_query_usd']:.8f}` |",
        f"| Estimated cold cost/query (USD) | `{benchmark['summary']['estimated_cold_cost_per_query_usd']:.8f}` |",
        "",
        "## What The Numbers Mean",
        "",
        "- Trace's main retrieval claim is that the current local eval corpus preserves full labeled recall while the lexical baseline does not.",
        "- The deployed benchmark numbers show that the eval stack stays within a bounded warm-path latency and memory envelope under the current Lambda configuration.",
        "- The cold Lambda `Init Duration` numbers describe Lambda runtime initialization only, so they should be paired with billed duration when describing first-hit behavior.",
        "- The cost estimate is intentionally scoped to Lambda request cost, Lambda compute cost, and API Gateway HTTP API request cost only; it should be quoted as an estimate, not a billing export.",
        "",
        "## Boundaries And Methodology",
        "",
        "- Retrieval metrics are local evidence on the current small labeled eval corpus, not proof of broad retrieval superiority.",
        "- The retrieval report is only packaged when its manifest and latest passing local-validation artifact certify the same eval corpus.",
        "- `vector_postfilter` matched `trace_prefilter_vector` on the current corpus, but that tie is candidate-window-sensitive and is not the main headline claim.",
        "- Cold-start evidence comes from direct Lambda invokes of freshly published versions and should be described as direct-Lambda cold-start evidence, not API Gateway cold-start evidence.",
        "- Warm latency comes from repeated deployed HTTP requests, while `took_ms` reflects the search path's reported internal timing.",
        "- Search-runtime cost excludes query-embedding spend because that cost depends on token volume rather than Lambda billed duration.",
        "",
        "## Source Artifacts Used",
        "",
        f"- Retrieval report: `{retrieval['report_path']}`",
        f"- Retrieval manifest: `{retrieval['provenance']['manifest_path']}`",
        f"- Retrieval approval validation report: `{retrieval['provenance']['validation_report_path']}`",
        f"- Benchmark report: `{benchmark['report_path']}`",
        f"- Snapshot: `{DEFAULT_SNAPSHOT_PATH}`",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    try:
        retrieval_report_path = (
            args.retrieval_report
            if args.retrieval_report is not None
            else _latest_artifact_path(DEFAULT_EVALUATION_ROOT, "report.json")
        )
        benchmark_report_path = (
            args.benchmark_report
            if args.benchmark_report is not None
            else _latest_artifact_path(DEFAULT_BENCHMARK_ROOT, "benchmark.json")
        )
        retrieval = validate_retrieval_report(
            _load_json(retrieval_report_path),
            retrieval_report_path,
        )
        benchmark = validate_benchmark_report(
            _load_json(benchmark_report_path),
            benchmark_report_path,
        )
        snapshot = build_snapshot(retrieval=retrieval, benchmark=benchmark)
        markdown = render_markdown(snapshot)
        args.doc_path.parent.mkdir(parents=True, exist_ok=True)
        args.snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        args.doc_path.write_text(markdown, encoding="utf-8")
        write_json(args.snapshot_path, snapshot)
    except TraceRuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Benchmark evidence written to {args.doc_path} and {args.snapshot_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
