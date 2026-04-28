"""
Step 4 deployed benchmark runner for Trace.

This script packages direct-Lambda cold/warm measurements and deployed HTTP
latency samples into a reproducible artifact under artifacts/benchmarks/.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from prove_deployed_path import (  # noqa: E402
    EVAL_DATASET_URI,
    EVAL_STACK_NAME,
    DEFAULT_CASES_PATH,
    GoldenCase,
    assert_filter_match,
    load_cases,
)
from trace_runtime import (  # noqa: E402
    RuntimeContext,
    TraceRuntimeError,
    assert_response_query_dim,
    build_http_payload,
    call_search_http,
    ensure_dir,
    make_run_id,
    median,
    percentile,
    resolve_query_vector,
    resolve_runtime_context,
    utc_now,
    write_json,
)


DEFAULT_ARTIFACTS_ROOT = Path("artifacts/benchmarks")
DEFAULT_REGION = "us-east-1"
DEFAULT_LAMBDA_CASE_ID = "unfiltered-demo"
DEFAULT_HTTP_CASE_IDS = ("unfiltered-demo", "filtered-chi-insurance")
DEFAULT_COLD_START_MEASUREMENT_NOTE = (
    "Cold samples are collected by directly invoking freshly published Lambda versions. "
    "Lambda REPORT Init Duration measures Lambda runtime initialization only; it does not "
    "measure API Gateway cold-start latency and should not be treated as full first-invoke latency."
)
DEFAULT_WARM_HTTP_MEASUREMENT_NOTE = (
    "Warm HTTP latency aggregates the configured case mix below across API Gateway HTTP API "
    "requests. Treat the aggregate latency numbers as a mixed-workload statistic, not as a "
    "single-query benchmark."
)
DEFAULT_LAMBDA_REQUEST_PRICE_PER_MILLION = 0.20
DEFAULT_LAMBDA_GB_SECOND_PRICE_BY_ARCH = {
    "x86_64": 0.0000166667,
    "arm64": 0.0000133334,
}
DEFAULT_API_GATEWAY_HTTP_REQUEST_PRICE_PER_MILLION = 1.00
DEFAULT_PRICING_REGION = "us-east-1"
LAMBDA_PRICING_SOURCE_URL = "https://aws.amazon.com/lambda/pricing/"
API_GATEWAY_HTTP_PRICING_SOURCE_URL = "https://aws.amazon.com/api-gateway/pricing/?z=3"
WARM_LAMBDA_MAX_EXTRA_INIT_ATTEMPTS = 10


REPORT_DURATION_RE = re.compile(r"Duration:\s*([0-9.]+)\s*ms", re.IGNORECASE)
REPORT_BILLED_DURATION_RE = re.compile(
    r"Billed Duration:\s*([0-9.]+)\s*ms", re.IGNORECASE
)
REPORT_MEMORY_SIZE_RE = re.compile(
    r"Memory Size:\s*([0-9.]+)\s*MB", re.IGNORECASE
)
REPORT_MAX_MEMORY_RE = re.compile(
    r"Max Memory Used:\s*([0-9.]+)\s*MB", re.IGNORECASE
)
REPORT_INIT_DURATION_RE = re.compile(
    r"Init Duration:\s*([0-9.]+)\s*ms", re.IGNORECASE
)


@dataclass
class PricingConfig:
    lambda_request_price_per_million: float
    lambda_gb_second_price: float
    api_gateway_http_request_price_per_million: float
    lambda_pricing_architecture: str
    lambda_request_price_defaulted: bool
    lambda_gb_second_price_defaulted: bool
    api_gateway_http_request_price_defaulted: bool
    pricing_region: str = DEFAULT_PRICING_REGION
    lambda_request_pricing_tier: str = "on-demand requests"
    lambda_compute_pricing_tier: str = "on-demand first-tier GB-second pricing"
    api_gateway_http_request_pricing_tier: str = (
        "HTTP API first 300M requests/month pricing example"
    )
    lambda_pricing_source_url: str = LAMBDA_PRICING_SOURCE_URL
    api_gateway_http_pricing_source_url: str = API_GATEWAY_HTTP_PRICING_SOURCE_URL
    embedding_cost_included: bool = False
    notes: str = (
        "Estimate includes Lambda request cost, Lambda compute cost, and API Gateway HTTP API "
        "request cost only. It excludes query-embedding cost and outbound data transfer."
    )


@dataclass
class LambdaReportMetrics:
    duration_ms: float
    billed_duration_ms: float
    memory_size_mb: int
    max_memory_used_mb: int
    init_duration_ms: float | None
    report_line: str


@dataclass
class LambdaBenchmarkSample:
    sample_index: int
    case_id: str
    invoke_round_trip_ms: float
    lambda_version: str | None
    response_took_ms: int | None
    returned_count: int
    report: LambdaReportMetrics


@dataclass
class HttpBenchmarkSample:
    sample_index: int
    case_id: str
    client_round_trip_ms: float
    response_took_ms: int | None
    returned_count: int


@dataclass
class BenchmarkSummary:
    cold_init_median_ms: float | None
    cold_init_p95_ms: float | None
    cold_lambda_round_trip_median_ms: float | None
    cold_lambda_round_trip_p95_ms: float | None
    cold_response_took_median_ms: float | None
    cold_response_took_p95_ms: float | None
    cold_start_measurement_note: str
    warm_http_latency_median_ms: float | None
    warm_http_latency_p95_ms: float | None
    warm_http_measurement_note: str
    warm_http_workload_mix: list[dict[str, Any]]
    warm_http_case_summaries: list[dict[str, Any]]
    warm_took_median_ms: float | None
    warm_took_p95_ms: float | None
    warm_lambda_billed_median_ms: float | None
    cold_lambda_billed_median_ms: float | None
    configured_memory_mb: int | None
    max_memory_used_mb: int | None
    estimated_warm_cost_per_query_usd: float | None
    estimated_cold_cost_per_query_usd: float | None
    warm_lambda_discarded_invocations: int


@dataclass
class BenchmarkArtifact:
    run_id: str
    generated_at: str
    runtime_context: dict[str, Any]
    benchmark_cases: list[dict[str, Any]]
    pricing: dict[str, Any]
    cold_lambda_samples: list[dict[str, Any]] = field(default_factory=list)
    warm_lambda_samples: list[dict[str, Any]] = field(default_factory=list)
    warm_http_samples: list[dict[str, Any]] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure deployed Trace benchmark evidence for Step 4 packaging."
    )
    parser.add_argument(
        "--cases",
        type=Path,
        default=DEFAULT_CASES_PATH,
        help=f"Golden-case fixture path (default: {DEFAULT_CASES_PATH}).",
    )
    parser.add_argument(
        "--artifacts-root",
        type=Path,
        default=DEFAULT_ARTIFACTS_ROOT,
        help=f"Benchmark artifact root (default: {DEFAULT_ARTIFACTS_ROOT}).",
    )
    parser.add_argument(
        "--stack-name",
        type=str,
        default=os.getenv("TRACE_STACK_NAME") or EVAL_STACK_NAME,
        help=f"Deployed stack name (default: {EVAL_STACK_NAME}).",
    )
    parser.add_argument(
        "--region",
        type=str,
        default=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or DEFAULT_REGION,
        help=f"AWS region (default: {DEFAULT_REGION}).",
    )
    parser.add_argument(
        "--search-url",
        type=str,
        default=os.getenv("TRACE_SEARCH_URL"),
        help="Optional override for the deployed SearchUrl.",
    )
    parser.add_argument(
        "--dataset-uri",
        type=str,
        default=os.getenv("TRACE_LANCE_S3_URI") or EVAL_DATASET_URI,
        help=f"Expected dataset URI (default: {EVAL_DATASET_URI}).",
    )
    parser.add_argument(
        "--function-arn",
        type=str,
        default=os.getenv("TRACE_SEARCH_FUNCTION_ARN"),
        help="Optional override for the deployed Trace search Lambda ARN.",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        default=os.getenv("TRACE_API_KEY") or os.getenv("TRACE_MCP_API_KEY"),
        help="Optional X-TRACE-API-KEY for warm HTTP sampling.",
    )
    parser.add_argument(
        "--embedding-model",
        type=str,
        default=os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
        help="Embedding model for query vectors.",
    )
    parser.add_argument(
        "--query-dim",
        type=int,
        default=int(os.getenv("TRACE_QUERY_VECTOR_DIM", "1536")),
        help="Expected query vector dimension.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=30,
        help="Per-request timeout for HTTP and Lambda invoke checks.",
    )
    parser.add_argument(
        "--mock-embeddings",
        action="store_true",
        help="Use deterministic mock embeddings instead of calling OpenAI.",
    )
    parser.add_argument(
        "--lambda-case-id",
        type=str,
        default=DEFAULT_LAMBDA_CASE_ID,
        help=f"Case to use for cold/warm direct-Lambda sampling (default: {DEFAULT_LAMBDA_CASE_ID}).",
    )
    parser.add_argument(
        "--http-case-ids",
        type=str,
        default=",".join(DEFAULT_HTTP_CASE_IDS),
        help=(
            "Comma-separated case_ids for warm HTTP sampling "
            f"(default: {','.join(DEFAULT_HTTP_CASE_IDS)})."
        ),
    )
    parser.add_argument(
        "--cold-samples",
        type=int,
        default=3,
        help="Number of cold direct-Lambda samples.",
    )
    parser.add_argument(
        "--warm-lambda-samples",
        type=int,
        default=10,
        help="Number of warm direct-Lambda samples.",
    )
    parser.add_argument(
        "--warm-http-samples",
        type=int,
        default=10,
        help="Number of warm HTTP samples per selected case.",
    )
    parser.add_argument(
        "--keep-published-versions",
        action="store_true",
        help="Keep temporary published Lambda versions created for cold-start sampling.",
    )
    parser.add_argument(
        "--lambda-request-price-per-million",
        type=float,
        default=None,
        help="Optional override for Lambda request price per 1M requests in USD.",
    )
    parser.add_argument(
        "--lambda-gb-second-price",
        type=float,
        default=None,
        help="Optional override for Lambda GB-second price in USD.",
    )
    parser.add_argument(
        "--api-gateway-http-request-price-per-million",
        type=float,
        default=None,
        help="Optional override for API Gateway HTTP API request price per 1M requests in USD.",
    )
    return parser.parse_args()


def _load_lambda_client(region: str):
    try:
        import boto3  # type: ignore[import-untyped]
    except ImportError as exc:
        raise TraceRuntimeError(
            "boto3 is required for deployed benchmarking. Install scripts/requirements.txt first."
        ) from exc
    return boto3.client("lambda", region_name=region)


def parse_report_line(line: str) -> LambdaReportMetrics:
    duration_match = REPORT_DURATION_RE.search(line)
    billed_match = REPORT_BILLED_DURATION_RE.search(line)
    memory_match = REPORT_MEMORY_SIZE_RE.search(line)
    max_memory_match = REPORT_MAX_MEMORY_RE.search(line)
    if (
        duration_match is None
        or billed_match is None
        or memory_match is None
        or max_memory_match is None
    ):
        raise TraceRuntimeError(f"Could not parse Lambda REPORT line: {line!r}")
    init_match = REPORT_INIT_DURATION_RE.search(line)
    return LambdaReportMetrics(
        duration_ms=float(duration_match.group(1)),
        billed_duration_ms=float(billed_match.group(1)),
        memory_size_mb=int(round(float(memory_match.group(1)))),
        max_memory_used_mb=int(round(float(max_memory_match.group(1)))),
        init_duration_ms=float(init_match.group(1)) if init_match is not None else None,
        report_line=line,
    )


def _decode_log_result(log_result: str | None) -> str:
    if not log_result:
        raise TraceRuntimeError("Lambda invoke did not return LogResult; LogType=Tail is required.")
    try:
        return base64.b64decode(log_result).decode("utf-8", errors="replace")
    except Exception as exc:
        raise TraceRuntimeError(f"Failed to decode Lambda LogResult: {exc}") from exc


def _extract_report_line(log_text: str) -> str:
    for line in log_text.splitlines():
        if line.startswith("REPORT RequestId:"):
            return line.strip()
    raise TraceRuntimeError(f"Lambda logs did not contain a REPORT line:\n{log_text}")


def _parse_invoke_response_payload(payload_stream) -> dict[str, Any]:
    raw = payload_stream.read()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise TraceRuntimeError(
            f"Lambda invoke returned a non-JSON payload: {raw[:500]!r}"
        ) from exc
    if not isinstance(payload, dict):
        raise TraceRuntimeError(
            f"Lambda invoke payload must be a JSON object, got {type(payload).__name__}."
        )
    return payload


def _invoke_direct_lambda(
    *,
    lambda_client,
    ctx: RuntimeContext,
    payload: dict[str, Any],
    qualifier: str | None,
) -> tuple[dict[str, Any], LambdaReportMetrics, float]:
    invoke_start = time.perf_counter()
    kwargs: dict[str, Any] = {
        "FunctionName": ctx.function_name or ctx.function_arn,
        "InvocationType": "RequestResponse",
        "LogType": "Tail",
        "Payload": json.dumps(payload).encode("utf-8"),
    }
    if qualifier is not None:
        kwargs["Qualifier"] = qualifier
    response = lambda_client.invoke(**kwargs)
    round_trip_ms = (time.perf_counter() - invoke_start) * 1000.0
    if response.get("FunctionError"):
        body = response.get("Payload").read().decode("utf-8", errors="replace")
        raise TraceRuntimeError(
            f"Lambda invoke returned FunctionError={response['FunctionError']}: {body}"
        )
    parsed_payload = _parse_invoke_response_payload(response["Payload"])
    assert_response_query_dim(parsed_payload, ctx.query_dim)
    log_text = _decode_log_result(response.get("LogResult"))
    report = parse_report_line(_extract_report_line(log_text))
    return parsed_payload, report, round_trip_ms


def _publish_version(lambda_client, ctx: RuntimeContext, description: str) -> str:
    response = lambda_client.publish_version(
        FunctionName=ctx.function_name or ctx.function_arn,
        Description=description,
    )
    version = response.get("Version")
    if not isinstance(version, str) or not version.strip():
        raise TraceRuntimeError(f"publish_version returned no usable Version: {response}")
    return version


def _wait_for_function_update(lambda_client, function_name: str) -> None:
    try:
        waiter = lambda_client.get_waiter("function_updated_v2")
    except Exception:
        return
    waiter.wait(FunctionName=function_name)


def _update_function_description(
    lambda_client,
    *,
    function_name: str,
    description: str,
) -> None:
    lambda_client.update_function_configuration(
        FunctionName=function_name,
        Description=description,
    )
    _wait_for_function_update(lambda_client, function_name)


def _delete_published_version(lambda_client, function_name: str, version: str) -> None:
    lambda_client.delete_function(FunctionName=function_name, Qualifier=version)


def _select_cases_by_id(cases: list[GoldenCase], case_ids: list[str]) -> list[GoldenCase]:
    by_id = {case.case_id: case for case in cases}
    selected: list[GoldenCase] = []
    for case_id in case_ids:
        case = by_id.get(case_id)
        if case is None:
            raise TraceRuntimeError(f"Unknown benchmark case_id: {case_id}")
        selected.append(case)
    return selected


def _resolve_case_vector_map(
    *,
    cases: list[GoldenCase],
    ctx: RuntimeContext,
    mock_embeddings: bool,
) -> dict[str, list[float]]:
    out: dict[str, list[float]] = {}
    for case in cases:
        out[case.case_id] = resolve_query_vector(
            query_text=case.query_text,
            explicit_query_vector=case.query_vector,
            ctx=ctx,
            mock_embeddings=mock_embeddings,
        )
    return out


def _build_case_payload(case: GoldenCase, query_vector: list[float]) -> dict[str, Any]:
    return build_http_payload(
        query_vector=query_vector,
        limit=case.limit,
        sql_filter=case.sql_filter,
        include_text=case.include_text,
    )


def _normalize_lambda_pricing_architecture(function_architectures: tuple[str, ...]) -> tuple[str, bool]:
    for architecture in function_architectures:
        normalized = architecture.strip().lower()
        if normalized in {"arm64", "arm", "aarch64"}:
            return "arm64", False
        if normalized in {"x86_64", "x86", "amd64"}:
            return "x86_64", False
    return "x86_64", True


def resolve_pricing_config(
    args: argparse.Namespace,
    ctx: RuntimeContext,
) -> PricingConfig:
    lambda_architecture, architecture_fallback_used = _normalize_lambda_pricing_architecture(
        ctx.function_architectures
    )
    lambda_request_defaulted = args.lambda_request_price_per_million is None
    lambda_compute_defaulted = args.lambda_gb_second_price is None
    api_gateway_defaulted = args.api_gateway_http_request_price_per_million is None
    lambda_request_price = (
        DEFAULT_LAMBDA_REQUEST_PRICE_PER_MILLION
        if lambda_request_defaulted
        else float(args.lambda_request_price_per_million)
    )
    lambda_gb_second_price = (
        DEFAULT_LAMBDA_GB_SECOND_PRICE_BY_ARCH[lambda_architecture]
        if lambda_compute_defaulted
        else float(args.lambda_gb_second_price)
    )
    api_gateway_http_request_price = (
        DEFAULT_API_GATEWAY_HTTP_REQUEST_PRICE_PER_MILLION
        if api_gateway_defaulted
        else float(args.api_gateway_http_request_price_per_million)
    )
    notes = (
        "Estimate includes Lambda request cost, Lambda compute cost, and API Gateway HTTP API "
        "request cost only. It excludes query-embedding cost and outbound data transfer."
    )
    if architecture_fallback_used:
        notes += (
            " Function architecture was unavailable, so the default Lambda compute price falls "
            "back to x86_64 pricing."
        )
    return PricingConfig(
        lambda_request_price_per_million=lambda_request_price,
        lambda_gb_second_price=lambda_gb_second_price,
        api_gateway_http_request_price_per_million=api_gateway_http_request_price,
        lambda_pricing_architecture=lambda_architecture,
        lambda_request_price_defaulted=lambda_request_defaulted,
        lambda_gb_second_price_defaulted=lambda_compute_defaulted,
        api_gateway_http_request_price_defaulted=api_gateway_defaulted,
        notes=notes,
    )


def assert_benchmark_case_contract(case: GoldenCase, response: dict[str, Any]) -> None:
    if not response.get("ok"):
        raise TraceRuntimeError(f"Case {case.case_id} failed benchmark validation: {response}")

    results = response.get("results")
    if not isinstance(results, list):
        raise TraceRuntimeError(f"Case {case.case_id} returned invalid 'results'.")

    if case.assertions.require_non_empty_results and not results:
        raise TraceRuntimeError(f"Case {case.case_id} returned no results.")

    assert_filter_match(case, results)


def _response_took_ms(response: dict[str, Any]) -> int | None:
    value = response.get("took_ms")
    if isinstance(value, int):
        return value
    return None


def _returned_count(response: dict[str, Any]) -> int:
    results = response.get("results")
    if isinstance(results, list):
        return len(results)
    return 0


def _response_took_values(samples: list[Any]) -> list[float]:
    return [
        float(sample.response_took_ms)
        for sample in samples
        if sample.response_took_ms is not None
    ]


def _summarize_http_case_mix(
    warm_http_samples: list[HttpBenchmarkSample],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    ordered_case_ids: list[str] = []
    samples_by_case: dict[str, list[HttpBenchmarkSample]] = {}
    for sample in warm_http_samples:
        if sample.case_id not in samples_by_case:
            samples_by_case[sample.case_id] = []
            ordered_case_ids.append(sample.case_id)
        samples_by_case[sample.case_id].append(sample)

    workload_mix: list[dict[str, Any]] = []
    case_summaries: list[dict[str, Any]] = []
    for case_id in ordered_case_ids:
        case_samples = samples_by_case[case_id]
        latencies = [sample.client_round_trip_ms for sample in case_samples]
        took_values = _response_took_values(case_samples)
        returned_counts = [float(sample.returned_count) for sample in case_samples]
        workload_mix.append(
            {
                "case_id": case_id,
                "sample_count": len(case_samples),
            }
        )
        case_summaries.append(
            {
                "case_id": case_id,
                "sample_count": len(case_samples),
                "latency_median_ms": median(latencies),
                "latency_p95_ms": percentile(latencies, 95.0),
                "took_median_ms": median(took_values) if took_values else None,
                "took_p95_ms": percentile(took_values, 95.0) if took_values else None,
                "returned_count_median": median(returned_counts) if returned_counts else None,
            }
        )

    return workload_mix, case_summaries


def run_warm_http_samples(
    *,
    ctx: RuntimeContext,
    cases: list[GoldenCase],
    case_vectors: dict[str, list[float]],
    sample_count: int,
    timeout_seconds: int,
) -> list[HttpBenchmarkSample]:
    samples: list[HttpBenchmarkSample] = []
    for case in cases:
        payload = _build_case_payload(case, case_vectors[case.case_id])
        for sample_index in range(1, sample_count + 1):
            started = time.perf_counter()
            response = call_search_http(
                ctx.search_url,
                payload,
                ctx.api_key,
                timeout_seconds,
            )
            round_trip_ms = (time.perf_counter() - started) * 1000.0
            assert_response_query_dim(response, ctx.query_dim)
            assert_benchmark_case_contract(case, response)
            samples.append(
                HttpBenchmarkSample(
                    sample_index=sample_index,
                    case_id=case.case_id,
                    client_round_trip_ms=round_trip_ms,
                    response_took_ms=_response_took_ms(response),
                    returned_count=_returned_count(response),
                )
            )
    return samples


def run_warm_lambda_samples(
    *,
    lambda_client,
    ctx: RuntimeContext,
    case: GoldenCase,
    case_vector: list[float],
    sample_count: int,
    discard_initial_invocation: bool = False,
) -> tuple[list[LambdaBenchmarkSample], int]:
    payload = _build_case_payload(case, case_vector)
    samples: list[LambdaBenchmarkSample] = []
    discarded_invocations = 0
    total_invocations = 0
    if sample_count > 0 and discard_initial_invocation:
        response, _, _ = _invoke_direct_lambda(
            lambda_client=lambda_client,
            ctx=ctx,
            payload=payload,
            qualifier=None,
        )
        total_invocations += 1
        assert_benchmark_case_contract(case, response)
        discarded_invocations = 1
    max_attempts = sample_count + discarded_invocations + WARM_LAMBDA_MAX_EXTRA_INIT_ATTEMPTS
    while len(samples) < sample_count:
        if total_invocations >= max_attempts:
            raise TraceRuntimeError(
                "Unable to collect the requested number of warm Lambda samples without "
                f"Init Duration after {total_invocations} invokes; discarded "
                f"{discarded_invocations} invoke(s)."
            )
        response, report, round_trip_ms = _invoke_direct_lambda(
            lambda_client=lambda_client,
            ctx=ctx,
            payload=payload,
            qualifier=None,
        )
        total_invocations += 1
        assert_benchmark_case_contract(case, response)
        if report.init_duration_ms is not None:
            discarded_invocations += 1
            continue
        samples.append(
            LambdaBenchmarkSample(
                sample_index=len(samples) + 1,
                case_id=case.case_id,
                invoke_round_trip_ms=round_trip_ms,
                lambda_version=None,
                response_took_ms=_response_took_ms(response),
                returned_count=_returned_count(response),
                report=report,
            )
        )
    return samples, discarded_invocations


def run_cold_lambda_samples(
    *,
    lambda_client,
    ctx: RuntimeContext,
    case: GoldenCase,
    case_vector: list[float],
    sample_count: int,
    keep_published_versions: bool,
) -> tuple[list[LambdaBenchmarkSample], list[str]]:
    payload = _build_case_payload(case, case_vector)
    samples: list[LambdaBenchmarkSample] = []
    created_versions: list[str] = []
    function_identifier = ctx.function_name or ctx.function_arn
    original_description = ""
    description_was_updated = False
    failure: Exception | None = None
    cleanup_errors: list[str] = []
    try:
        if function_identifier is not None:
            try:
                cfg = lambda_client.get_function_configuration(
                    FunctionName=function_identifier
                )
                raw_description = cfg.get("Description")
                if isinstance(raw_description, str):
                    original_description = raw_description
            except Exception:
                original_description = ""
        for sample_index in range(1, sample_count + 1):
            if function_identifier is not None:
                _update_function_description(
                    lambda_client,
                    function_name=function_identifier,
                    description=f"trace-step4-cold-benchmark-sample-{sample_index}",
                )
                description_was_updated = True
            version = _publish_version(
                lambda_client,
                ctx,
                description=f"trace-step4-cold-benchmark-{sample_index}",
            )
            created_versions.append(version)
            response, report, round_trip_ms = _invoke_direct_lambda(
                lambda_client=lambda_client,
                ctx=ctx,
                payload=payload,
                qualifier=version,
            )
            assert_benchmark_case_contract(case, response)
            samples.append(
                LambdaBenchmarkSample(
                    sample_index=sample_index,
                    case_id=case.case_id,
                    invoke_round_trip_ms=round_trip_ms,
                    lambda_version=version,
                    response_took_ms=_response_took_ms(response),
                    returned_count=_returned_count(response),
                    report=report,
                )
            )
    except Exception as exc:
        failure = exc
    finally:
        if description_was_updated and function_identifier is not None:
            try:
                _update_function_description(
                    lambda_client,
                    function_name=function_identifier,
                    description=original_description,
                )
            except Exception as exc:
                cleanup_errors.append(f"restore description failed: {exc}")
        if not keep_published_versions and function_identifier is not None:
            for version in created_versions:
                try:
                    _delete_published_version(lambda_client, function_identifier, version)
                except Exception as exc:
                    cleanup_errors.append(f"delete version {version} failed: {exc}")

    if failure is not None:
        if cleanup_errors:
            raise TraceRuntimeError(
                "Cold benchmark sampling failed and cleanup was incomplete: "
                f"{failure}. Cleanup errors: {'; '.join(cleanup_errors)}"
            ) from failure
        if isinstance(failure, TraceRuntimeError):
            raise failure
        raise TraceRuntimeError(f"Cold benchmark sampling failed: {failure}") from failure
    if cleanup_errors:
        raise TraceRuntimeError(
            f"Cold benchmark cleanup was incomplete: {'; '.join(cleanup_errors)}"
        )
    return samples, created_versions


def _cost_per_query_usd(
    *,
    billed_duration_ms: float | None,
    configured_memory_mb: int | None,
    pricing: PricingConfig,
) -> float | None:
    if billed_duration_ms is None or configured_memory_mb is None:
        return None
    lambda_request_cost = pricing.lambda_request_price_per_million / 1_000_000.0
    api_gateway_cost = (
        pricing.api_gateway_http_request_price_per_million / 1_000_000.0
    )
    compute_cost = (
        configured_memory_mb / 1024.0
    ) * (billed_duration_ms / 1000.0) * pricing.lambda_gb_second_price
    return lambda_request_cost + api_gateway_cost + compute_cost


def summarize_samples(
    *,
    cold_lambda_samples: list[LambdaBenchmarkSample],
    warm_lambda_samples: list[LambdaBenchmarkSample],
    warm_http_samples: list[HttpBenchmarkSample],
    configured_memory_mb: int | None,
    pricing: PricingConfig,
    warm_lambda_discarded_invocations: int = 0,
) -> BenchmarkSummary:
    cold_inits = [
        sample.report.init_duration_ms
        for sample in cold_lambda_samples
        if sample.report.init_duration_ms is not None
    ]
    cold_round_trip_values = [sample.invoke_round_trip_ms for sample in cold_lambda_samples]
    cold_took_values = _response_took_values(cold_lambda_samples)
    warm_http_latencies = [sample.client_round_trip_ms for sample in warm_http_samples]
    warm_took_values = _response_took_values(warm_http_samples)
    warm_billed = [sample.report.billed_duration_ms for sample in warm_lambda_samples]
    cold_billed = [sample.report.billed_duration_ms for sample in cold_lambda_samples]
    all_max_memory = [
        sample.report.max_memory_used_mb
        for sample in cold_lambda_samples + warm_lambda_samples
    ]
    warm_http_workload_mix, warm_http_case_summaries = _summarize_http_case_mix(
        warm_http_samples
    )
    effective_memory = configured_memory_mb
    if effective_memory is None:
        memory_sizes = [
            sample.report.memory_size_mb
            for sample in cold_lambda_samples + warm_lambda_samples
        ]
        effective_memory = memory_sizes[0] if memory_sizes else None
    return BenchmarkSummary(
        cold_init_median_ms=median(cold_inits) if cold_inits else None,
        cold_init_p95_ms=percentile(cold_inits, 95.0) if cold_inits else None,
        cold_lambda_round_trip_median_ms=median(cold_round_trip_values)
        if cold_round_trip_values
        else None,
        cold_lambda_round_trip_p95_ms=percentile(cold_round_trip_values, 95.0)
        if cold_round_trip_values
        else None,
        cold_response_took_median_ms=median(cold_took_values)
        if cold_took_values
        else None,
        cold_response_took_p95_ms=percentile(cold_took_values, 95.0)
        if cold_took_values
        else None,
        cold_start_measurement_note=DEFAULT_COLD_START_MEASUREMENT_NOTE,
        warm_http_latency_median_ms=median(warm_http_latencies),
        warm_http_latency_p95_ms=percentile(warm_http_latencies, 95.0),
        warm_http_measurement_note=DEFAULT_WARM_HTTP_MEASUREMENT_NOTE,
        warm_http_workload_mix=warm_http_workload_mix,
        warm_http_case_summaries=warm_http_case_summaries,
        warm_took_median_ms=median(warm_took_values) if warm_took_values else None,
        warm_took_p95_ms=percentile(warm_took_values, 95.0) if warm_took_values else None,
        warm_lambda_billed_median_ms=median(warm_billed) if warm_billed else None,
        cold_lambda_billed_median_ms=median(cold_billed) if cold_billed else None,
        configured_memory_mb=effective_memory,
        max_memory_used_mb=max(all_max_memory) if all_max_memory else None,
        estimated_warm_cost_per_query_usd=_cost_per_query_usd(
            billed_duration_ms=median(warm_billed) if warm_billed else None,
            configured_memory_mb=effective_memory,
            pricing=pricing,
        ),
        estimated_cold_cost_per_query_usd=_cost_per_query_usd(
            billed_duration_ms=median(cold_billed) if cold_billed else None,
            configured_memory_mb=effective_memory,
            pricing=pricing,
        ),
        warm_lambda_discarded_invocations=warm_lambda_discarded_invocations,
    )


def build_summary_markdown(
    *,
    artifact: BenchmarkArtifact,
    summary: BenchmarkSummary,
) -> str:
    lines = [
        "# Deployed Benchmark Summary",
        "",
        f"- Generated at: `{artifact.generated_at}`",
        f"- Stack: `{artifact.runtime_context['stack_name']}`",
        f"- Region: `{artifact.runtime_context['region']}`",
        f"- Search URL: `{artifact.runtime_context['search_url']}`",
        f"- Dataset URI: `{artifact.runtime_context['dataset_uri']}`",
        f"- Function ARN: `{artifact.runtime_context['function_arn']}`",
        f"- Function architecture: `{', '.join(artifact.runtime_context['function_architectures']) or 'unknown'}`",
        "",
        "| Measurement | Value |",
        "| --- | ---: |",
        f"| Cold Lambda init duration median (ms) | {_fmt(summary.cold_init_median_ms)} |",
        f"| Cold Lambda init duration p95 (ms) | {_fmt(summary.cold_init_p95_ms)} |",
        f"| Cold Lambda first-invoke round trip median (ms) | {_fmt(summary.cold_lambda_round_trip_median_ms)} |",
        f"| Cold Lambda first-invoke round trip p95 (ms) | {_fmt(summary.cold_lambda_round_trip_p95_ms)} |",
        f"| Cold Lambda response took_ms median (ms) | {_fmt(summary.cold_response_took_median_ms)} |",
        f"| Cold Lambda response took_ms p95 (ms) | {_fmt(summary.cold_response_took_p95_ms)} |",
        f"| Warm HTTP aggregate latency median (ms) | {_fmt(summary.warm_http_latency_median_ms)} |",
        f"| Warm HTTP aggregate latency p95 (ms) | {_fmt(summary.warm_http_latency_p95_ms)} |",
        f"| Warm took_ms median (ms) | {_fmt(summary.warm_took_median_ms)} |",
        f"| Warm took_ms p95 (ms) | {_fmt(summary.warm_took_p95_ms)} |",
        f"| Configured memory (MB) | {summary.configured_memory_mb if summary.configured_memory_mb is not None else 'n/a'} |",
        f"| Max memory used (MB) | {summary.max_memory_used_mb if summary.max_memory_used_mb is not None else 'n/a'} |",
        f"| Estimated warm cost/query (USD) | {_fmt_usd(summary.estimated_warm_cost_per_query_usd)} |",
        f"| Estimated cold cost/query (USD) | {_fmt_usd(summary.estimated_cold_cost_per_query_usd)} |",
        "",
        "## Measurement Notes",
        "",
        f"- Cold Lambda scope: {summary.cold_start_measurement_note}",
        f"- Warm HTTP scope: {summary.warm_http_measurement_note}",
        f"- Discarded post-mutation warm Lambda invokes: `{summary.warm_lambda_discarded_invocations}`",
        "",
        "## Warm HTTP Workload Mix",
        "",
        "| Case ID | Samples | Median latency (ms) | p95 latency (ms) | Median took_ms (ms) | Median returned count |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for case_summary in summary.warm_http_case_summaries:
        lines.append(
            "| "
            f"{case_summary['case_id']} | "
            f"{case_summary['sample_count']} | "
            f"{_fmt(case_summary['latency_median_ms'])} | "
            f"{_fmt(case_summary['latency_p95_ms'])} | "
            f"{_fmt(case_summary['took_median_ms'])} | "
            f"{_fmt(case_summary['returned_count_median'])} |"
        )
    lines.extend(
        [
            "",
            "## Pricing Assumptions",
            "",
            f"- Lambda request price per 1M: `{artifact.pricing['lambda_request_price_per_million']}`",
            f"- Lambda GB-second price: `{artifact.pricing['lambda_gb_second_price']}`",
            f"- API Gateway HTTP request price per 1M: `{artifact.pricing['api_gateway_http_request_price_per_million']}`",
            f"- Lambda pricing architecture: `{artifact.pricing['lambda_pricing_architecture']}`",
            f"- Lambda pricing source: `{artifact.pricing['lambda_pricing_source_url']}` "
            f"({artifact.pricing['pricing_region']}, {artifact.pricing['lambda_compute_pricing_tier']}; "
            f"defaulted={artifact.pricing['lambda_gb_second_price_defaulted']})",
            f"- API Gateway pricing source: `{artifact.pricing['api_gateway_http_pricing_source_url']}` "
            f"({artifact.pricing['pricing_region']}, {artifact.pricing['api_gateway_http_request_pricing_tier']}; "
            f"defaulted={artifact.pricing['api_gateway_http_request_price_defaulted']})",
            f"- Notes: {artifact.pricing['notes']}",
        ]
    )
    return "\n".join(lines) + "\n"


def _fmt(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.3f}"


def _fmt_usd(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.8f}"


def _case_metadata(case: GoldenCase) -> dict[str, Any]:
    return {
        "case_id": case.case_id,
        "query_text": case.query_text,
        "sql_filter": case.sql_filter,
        "limit": case.limit,
        "include_text": case.include_text,
    }


def _unique_cases_in_order(cases: list[GoldenCase]) -> list[GoldenCase]:
    seen: set[str] = set()
    ordered: list[GoldenCase] = []
    for case in cases:
        if case.case_id in seen:
            continue
        seen.add(case.case_id)
        ordered.append(case)
    return ordered


def main() -> int:
    args = parse_args()
    now = utc_now()
    run_id = make_run_id(now)
    run_dir = ensure_dir(args.artifacts_root / run_id)

    try:
        ctx = resolve_runtime_context(args, require_function_arn=True)
        cases = load_cases(args.cases)
        http_case_ids = [item.strip() for item in args.http_case_ids.split(",") if item.strip()]
        lambda_case = _select_cases_by_id(cases, [args.lambda_case_id])[0]
        http_cases = _select_cases_by_id(cases, http_case_ids)
        vector_cases = {case.case_id: case for case in [lambda_case, *http_cases]}
        case_vectors = _resolve_case_vector_map(
            cases=list(vector_cases.values()),
            ctx=ctx,
            mock_embeddings=bool(args.mock_embeddings),
        )
        lambda_client = _load_lambda_client(ctx.region or DEFAULT_REGION)
        cold_lambda_samples, created_versions = run_cold_lambda_samples(
            lambda_client=lambda_client,
            ctx=ctx,
            case=lambda_case,
            case_vector=case_vectors[lambda_case.case_id],
            sample_count=args.cold_samples,
            keep_published_versions=bool(args.keep_published_versions),
        )
        warm_lambda_samples, warm_lambda_discarded_invocations = run_warm_lambda_samples(
            lambda_client=lambda_client,
            ctx=ctx,
            case=lambda_case,
            case_vector=case_vectors[lambda_case.case_id],
            sample_count=args.warm_lambda_samples,
            discard_initial_invocation=bool(cold_lambda_samples),
        )
        warm_http_samples = run_warm_http_samples(
            ctx=ctx,
            cases=http_cases,
            case_vectors=case_vectors,
            sample_count=args.warm_http_samples,
            timeout_seconds=args.timeout_seconds,
        )
        pricing = resolve_pricing_config(args, ctx)
        summary = summarize_samples(
            cold_lambda_samples=cold_lambda_samples,
            warm_lambda_samples=warm_lambda_samples,
            warm_http_samples=warm_http_samples,
            configured_memory_mb=ctx.function_memory_mb,
            pricing=pricing,
            warm_lambda_discarded_invocations=warm_lambda_discarded_invocations,
        )
        artifact = BenchmarkArtifact(
            run_id=run_id,
            generated_at=now.isoformat(),
            runtime_context={
                "stack_name": ctx.stack_name,
                "region": ctx.region,
                "search_url": ctx.search_url,
                "dataset_uri": ctx.dataset_uri,
                "function_arn": ctx.function_arn,
                "function_name": ctx.function_name,
                "configured_memory_mb": ctx.function_memory_mb,
                "function_architectures": list(ctx.function_architectures),
                "query_dim": ctx.query_dim,
                "embedding_model": ctx.embedding_model,
            },
            benchmark_cases=[
                _case_metadata(case)
                for case in _unique_cases_in_order([lambda_case, *http_cases])
            ],
            pricing=asdict(pricing),
            cold_lambda_samples=[asdict(sample) for sample in cold_lambda_samples],
            warm_lambda_samples=[asdict(sample) for sample in warm_lambda_samples],
            warm_http_samples=[asdict(sample) for sample in warm_http_samples],
            summary=asdict(summary),
        )
        write_json(run_dir / "benchmark.json", asdict(artifact))
        (run_dir / "summary.md").write_text(
            build_summary_markdown(artifact=artifact, summary=summary),
            encoding="utf-8",
        )
        if created_versions and args.keep_published_versions:
            (run_dir / "published_versions.json").write_text(
                json.dumps({"versions": created_versions}, indent=2) + "\n",
                encoding="utf-8",
            )
    except TraceRuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Benchmark run completed. Artifacts: {run_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
