"""
End-to-end deployed validation of Trace: direct HTTP POST /search and MCP search_cold_archive.

See docs/deployed-proof-runbook.md for operator steps.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Local imports (scripts/ is not a package; add sibling modules).
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from proof_mcp_stdio import (  # noqa: E402
    McpStdioError,
    default_bridge_entry,
    run_search_cold_archive,
)
from trace_runtime import (  # noqa: E402
    DEFAULT_QUERY_VECTOR_DIM,
    RuntimeContext,
    TraceRuntimeError,
    _describe_stack,
    _maybe_int,
    _stack_output,
    assert_response_query_dim as shared_assert_response_query_dim,
    build_http_payload as shared_build_http_payload,
    call_search_http as shared_call_search_http,
    deployed_api_auth_mode_from_stack_parameters,
    ensure_dir,
    make_run_id,
    repo_root_from_args,
    resolve_query_vector,
    resolve_runtime_context,
    utc_now,
    write_json as shared_write_json,
)


DEFAULT_CASES_PATH = Path("fixtures/deployed/golden_cases.json")
DEFAULT_ARTIFACTS_ROOT = Path("artifacts/validation-runs")
DEFAULT_TIMEOUT_SECONDS = 30
STABLE_FIXTURES_DIR = Path("fixtures/deployed/examples")
SCRUBBED_URL_PLACEHOLDER = "https://search.example.invalid/search"
EVAL_STACK_NAME = "trace-eval"
EVAL_DATASET_URI = "s3://trace-vault/trace/eval/lance/"
ProofPathError = TraceRuntimeError


def validate_run_flags(args: argparse.Namespace) -> None:
    """Reject incompatible flag combinations before creating artifacts or calling AWS."""
    if not args.write_stable_fixtures:
        return
    if args.skip_mcp:
        raise ProofPathError(
            "--write-stable-fixtures requires MCP response artifacts; "
            "remove --skip-mcp or omit --write-stable-fixtures."
        )
    if args.dry_run:
        raise ProofPathError(
            "--write-stable-fixtures requires a full run that produces HTTP and MCP artifacts; "
            "remove --dry-run or omit --write-stable-fixtures."
        )
    if not (args.stable_fixture_cases or "").strip():
        raise ProofPathError(
            "--write-stable-fixtures requires explicit --stable-fixture-cases. "
            "Pass a comma-separated list of case_ids to promote so fixture selection does not "
            "depend on golden_cases.json ordering."
        )


def _normalize_s3_uri(uri: str | None) -> str | None:
    if uri is None:
        return None
    cleaned = uri.strip()
    if not cleaned:
        return None
    return cleaned.rstrip("/") + "/"


def _eval_stable_fixture_context_mismatches(ctx: "RuntimeContext") -> list[str]:
    problems: list[str] = []
    dataset_uri = _normalize_s3_uri(ctx.dataset_uri)
    expected_dataset_uri = _normalize_s3_uri(EVAL_DATASET_URI)

    if dataset_uri != expected_dataset_uri:
        actual_dataset = ctx.dataset_uri or "<unset>"
        problems.append(
            f"dataset_uri must be {EVAL_DATASET_URI!r}, got {actual_dataset!r}"
        )

    if ctx.stack_name is not None and ctx.stack_name != EVAL_STACK_NAME:
        problems.append(
            f"stack_name must be {EVAL_STACK_NAME!r} when provided, got {ctx.stack_name!r}"
        )

    return problems


def assert_stable_fixture_promotion_context(
    ctx: "RuntimeContext",
    *,
    allow_non_eval_stable_fixtures: bool,
) -> None:
    problems = _eval_stable_fixture_context_mismatches(ctx)
    if not problems or allow_non_eval_stable_fixtures:
        return

    raise ProofPathError(
        "--write-stable-fixtures is blocked because this run is not in the trusted eval "
        "context. Stable fixtures must come from the eval deployment context. "
        f"Context check failed: {'; '.join(problems)}. "
        "If you intentionally need to promote from a different deployed source, rerun with "
        "--allow-non-eval-stable-fixtures."
    )


def _parse_expected_ids(case_id: str, raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ProofPathError(
            f"Case {case_id} 'expected_ids' must be a JSON array of strings, not {type(raw).__name__}."
        )
    out: list[str] = []
    for i, item in enumerate(raw):
        if not isinstance(item, str):
            raise ProofPathError(
                f"Case {case_id} expected_ids[{i}] must be a string, not {type(item).__name__}."
            )
        out.append(item)
    return out


def redact_http_request_for_stable_fixture(req: dict[str, Any]) -> dict[str, Any]:
    """Copy a POST /search body for committed examples: omit raw embedding values, keep shape."""
    out = dict(req)
    qv = out.get("query_vector")
    if isinstance(qv, list):
        out["query_vector"] = {
            "_redacted": True,
            "dim": len(qv),
        }
    elif "query_vector" in out:
        out["query_vector"] = {
            "_redacted": True,
            "note": "omitted in stable fixtures (non-list value)",
        }
    return out


@dataclass
class CaseAssertions:
    require_non_empty_results: bool = True
    require_filter_match: bool = False


@dataclass
class GoldenCase:
    case_id: str
    query_text: str
    sql_filter: str = ""
    limit: int = 5
    include_text: bool = True
    expected_ids: list[str] = field(default_factory=list)
    assertions: CaseAssertions = field(default_factory=CaseAssertions)
    query_vector: list[float] | None = None


@dataclass
class CaseResult:
    case_id: str
    http_ok: bool = False
    mcp_ok: bool = False
    notes: list[str] = field(default_factory=list)


@dataclass
class RunManifest:
    run_id: str
    executed_at: str
    stack_name: str | None
    region: str | None
    search_url: str
    dataset_uri: str | None
    api_auth_mode: str
    local_api_key_supplied: bool
    embedding_model: str | None
    query_dim: int
    cases: list[dict[str, Any]] = field(default_factory=list)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate the deployed Trace path and persist proof artifacts."
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
        help=f"Artifact root directory (default: {DEFAULT_ARTIFACTS_ROOT}).",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path.cwd(),
        help="Repository root (used to locate mcp-bridge/dist). Default: cwd.",
    )
    parser.add_argument(
        "--stack-name",
        type=str,
        default=os.getenv("TRACE_STACK_NAME"),
        help="Deployed SAM/CloudFormation stack name.",
    )
    parser.add_argument(
        "--region",
        type=str,
        default=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
        help="AWS region for stack resolution.",
    )
    parser.add_argument(
        "--search-url",
        type=str,
        default=os.getenv("TRACE_SEARCH_URL"),
        help="Override deployed Trace search URL (otherwise resolved from stack or env).",
    )
    parser.add_argument(
        "--dataset-uri",
        type=str,
        default=os.getenv("TRACE_LANCE_S3_URI"),
        help="Dataset URI for the manifest (otherwise from stack parameters or env).",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        default=os.getenv("TRACE_API_KEY") or os.getenv("TRACE_MCP_API_KEY"),
        help="Optional X-TRACE-API-KEY for direct HTTP and MCP bridge.",
    )
    parser.add_argument(
        "--embedding-model",
        type=str,
        default=os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
        help="Embedding model for HTTP-side embeddings (default: text-embedding-3-small).",
    )
    parser.add_argument(
        "--query-dim",
        type=int,
        default=_maybe_int(os.getenv("TRACE_QUERY_VECTOR_DIM")) or DEFAULT_QUERY_VECTOR_DIM,
        help=f"Expected query vector dimension (default {DEFAULT_QUERY_VECTOR_DIM} or TRACE_QUERY_VECTOR_DIM).",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"Per-request HTTP timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS}).",
    )
    parser.add_argument(
        "--mcp-timeout-seconds",
        type=int,
        default=120,
        help="Timeout for each MCP stdio session (embedding + search).",
    )
    parser.add_argument(
        "--mock-embeddings",
        action="store_true",
        help=(
            "Use deterministic pseudo-random vectors from query text (no OpenAI). "
            "For structural checks only; use real embeddings to validate retrieval quality."
        ),
    )
    parser.add_argument(
        "--allow-missing-vectors",
        action="store_true",
        help="Skip HTTP execution when query_vector cannot be resolved (scaffold / CI).",
    )
    parser.add_argument(
        "--skip-mcp",
        action="store_true",
        help="Skip MCP validation (direct HTTP only).",
    )
    parser.add_argument(
        "--write-stable-fixtures",
        action="store_true",
        help="After a successful run, write scrubbed examples under fixtures/deployed/examples/.",
    )
    parser.add_argument(
        "--allow-non-eval-stable-fixtures",
        action="store_true",
        help=(
            "Override the stable-fixture safety guard and allow promotion outside the trusted "
            "eval stack / dataset context."
        ),
    )
    parser.add_argument(
        "--stable-fixture-cases",
        type=str,
        default="",
        help=(
            "Comma-separated case_ids to promote. Required with --write-stable-fixtures so "
            "fixture selection is explicit and not derived from case ordering."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Resolve context and load cases only; do not call HTTP or MCP.",
    )
    return parser.parse_args()


def _maybe_int(value: str | None) -> int | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    return int(value)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def make_run_id(now: datetime) -> str:
    return now.strftime("%Y%m%dT%H%M%SZ")


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def repo_root_from_args(path: Path) -> Path:
    return path.resolve()


def _describe_stack(stack_name: str, region: str) -> dict[str, Any]:
    try:
        import boto3  # type: ignore[import-untyped]
    except ImportError as exc:
        raise ProofPathError(
            "boto3 is required for --stack-name resolution. "
            "Install scripts/requirements.txt or set --search-url explicitly."
        ) from exc

    cf = boto3.client("cloudformation", region_name=region)
    try:
        resp = cf.describe_stacks(StackName=stack_name)
    except Exception as exc:
        raise ProofPathError(
            f"Failed to describe CloudFormation stack {stack_name!r} in {region}: {exc}"
        ) from exc
    stacks = resp.get("Stacks") or []
    if not stacks:
        raise ProofPathError(f"Stack not found: {stack_name}")
    return stacks[0]


def _stack_output(stack: dict[str, Any], key: str) -> str | None:
    for o in stack.get("Outputs") or []:
        if o.get("OutputKey") == key:
            v = o.get("OutputValue")
            return str(v).strip() if v else None
    return None


def _stack_parameters(stack: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for p in stack.get("Parameters") or []:
        k = p.get("ParameterKey")
        v = p.get("ParameterValue")
        if isinstance(k, str) and v is not None:
            out[k] = str(v)
    return out


def _dataset_uri_from_parameters(params: dict[str, str]) -> str | None:
    bucket = params.get("TraceDataBucketName")
    prefix = params.get("TraceLancePrefix")
    if bucket and prefix:
        return f"s3://{bucket}/{prefix}"
    return None


def deployed_api_auth_mode_from_stack_parameters(params: dict[str, str]) -> str:
    """
    Resolve how the deployed HTTP API authenticates from SAM stack Parameters.

    Empty TraceApiKeySecretRef → IAM-only / public API Gateway access (no API key check).
    Non-empty → Lambda receives TRACE_API_KEY_SECRET and the HTTP layer requires X-TRACE-API-KEY.
    """
    ref = (params.get("TraceApiKeySecretRef") or "").strip()
    if not ref:
        return "iam_only_or_public"
    return "api_key"


def _lambda_function_name_from_arn(arn: str) -> str:
    return arn.rsplit(":", 1)[-1]


def _query_dim_from_lambda(function_arn: str, region: str) -> int | None:
    try:
        import boto3  # type: ignore[import-untyped]
    except ImportError:
        return None
    name = _lambda_function_name_from_arn(function_arn)
    lmb = boto3.client("lambda", region_name=region)
    try:
        cfg = lmb.get_function_configuration(FunctionName=name)
    except Exception:
        return None
    env = (cfg.get("Environment") or {}).get("Variables") or {}
    raw = env.get("TRACE_QUERY_VECTOR_DIM")
    if not raw:
        return DEFAULT_QUERY_VECTOR_DIM
    try:
        return int(str(raw).strip())
    except ValueError:
        return None


def resolve_runtime_context(args: argparse.Namespace) -> RuntimeContext:
    stack_name = (args.stack_name or "").strip() or None
    region = (args.region or "").strip() or None
    search_url = (args.search_url or "").strip() or None
    dataset_uri = (args.dataset_uri or "").strip() or None
    api_key = (args.api_key or "").strip() or None
    local_api_key_supplied = api_key is not None
    embedding_model = (args.embedding_model or "").strip() or None
    query_dim = int(args.query_dim)

    stack_detail: dict[str, Any] | None = None
    if stack_name:
        if not region:
            raise ProofPathError(
                "AWS region is required when using --stack-name "
                "(pass --region or set AWS_REGION / AWS_DEFAULT_REGION)."
            )
        stack_detail = _describe_stack(stack_name, region)
        out_search = _stack_output(stack_detail, "SearchUrl")
        if not search_url:
            if not out_search:
                raise ProofPathError(
                    f"Stack {stack_name!r} has no SearchUrl output. "
                    "Pass --search-url or deploy a stack that exposes SearchUrl."
                )
            search_url = out_search
        elif out_search and out_search.rstrip("/") != search_url.rstrip("/"):
            # Operator may intentionally override; keep explicit URL.
            pass

        if not dataset_uri:
            dataset_uri = _dataset_uri_from_parameters(_stack_parameters(stack_detail))

        fn_arn = _stack_output(stack_detail, "TraceSearchFunctionArn")
        if fn_arn and region:
            dim = _query_dim_from_lambda(fn_arn, region)
            if dim is not None:
                query_dim = dim

    if not search_url:
        raise ProofPathError(
            "Search URL is required: pass --search-url, set TRACE_SEARCH_URL, "
            "or use --stack-name with a stack that outputs SearchUrl."
        )

    if not dataset_uri:
        raise ProofPathError(
            "Dataset URI is required for the manifest: pass --dataset-uri, set TRACE_LANCE_S3_URI, "
            "or use --stack-name so TraceDataBucketName/TraceLancePrefix can be read."
        )

    if stack_detail is not None:
        api_auth_mode = deployed_api_auth_mode_from_stack_parameters(
            _stack_parameters(stack_detail)
        )
    else:
        # No stack metadata: cannot infer deployed auth; do not substitute local --api-key.
        api_auth_mode = "unknown"

    return RuntimeContext(
        stack_name=stack_name,
        region=region,
        search_url=search_url,
        dataset_uri=dataset_uri,
        api_key=api_key,
        embedding_model=embedding_model,
        query_dim=query_dim,
        api_auth_mode=api_auth_mode,
        local_api_key_supplied=local_api_key_supplied,
    )


def load_cases(path: Path) -> list[GoldenCase]:
    if not path.exists():
        raise ProofPathError(f"Cases file not found: {path}")

    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("version") != 1:
        raise ProofPathError("Golden-case fixture version must be 1.")

    raw_cases = payload.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ProofPathError("Golden-case fixture must contain a non-empty 'cases' list.")

    cases: list[GoldenCase] = []
    seen_ids: set[str] = set()
    for item in raw_cases:
        if not isinstance(item, dict):
            raise ProofPathError("Each case must be a JSON object.")
        case_id = item.get("case_id")
        query_text = item.get("query_text")
        if not isinstance(case_id, str) or not case_id.strip():
            raise ProofPathError("Each case must include a non-empty string 'case_id'.")
        if case_id in seen_ids:
            raise ProofPathError(f"Duplicate case_id detected: {case_id}")
        if not isinstance(query_text, str) or not query_text.strip():
            raise ProofPathError(f"Case {case_id} must include a non-empty 'query_text'.")

        raw_assertions = item.get("assertions") or {}
        if not isinstance(raw_assertions, dict):
            raise ProofPathError(f"Case {case_id} has invalid 'assertions'.")

        qv = item.get("query_vector")
        if qv is not None:
            if not isinstance(qv, list) or not all(isinstance(x, (int, float)) for x in qv):
                raise ProofPathError(f"Case {case_id} query_vector must be a list of numbers.")

        case = GoldenCase(
            case_id=case_id,
            query_text=query_text,
            sql_filter=str(item.get("sql_filter", "")),
            limit=int(item.get("limit", 5)),
            include_text=bool(item.get("include_text", True)),
            expected_ids=_parse_expected_ids(case_id, item.get("expected_ids", [])),
            assertions=CaseAssertions(
                require_non_empty_results=bool(
                    raw_assertions.get("require_non_empty_results", True)
                ),
                require_filter_match=bool(
                    raw_assertions.get("require_filter_match", False)
                ),
            ),
            query_vector=qv,
        )
        if case.limit < 1 or case.limit > 50:
            raise ProofPathError(f"Case {case_id} has invalid limit {case.limit}; expected 1..50.")
        cases.append(case)
        seen_ids.add(case_id)

    return cases


def _mock_query_vector(text: str, dim: int) -> list[float]:
    """Deterministic unit-ish vector for --mock-embeddings (structural smoke only)."""
    seed = hashlib.sha256(text.encode("utf-8")).digest()
    out: list[float] = []
    for i in range(dim):
        b0 = seed[i % len(seed)]
        b1 = seed[(i + 1) % len(seed)]
        # map to small float in [-1, 1]
        x = ((b0 << 8) | b1) / 65535.0 * 2.0 - 1.0
        out.append(x)
    norm = math.sqrt(sum(v * v for v in out)) or 1.0
    return [v / norm for v in out]


def embed_query_text(
    text: str,
    *,
    model: str,
    dim: int,
    mock: bool,
) -> list[float]:
    if mock:
        return _mock_query_vector(text, dim)

    key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not key:
        raise ProofPathError(
            "OPENAI_API_KEY is required for real embeddings (or pass --mock-embeddings)."
        )

    body = json.dumps({"model": model, "input": text}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise ProofPathError(f"OpenAI embeddings HTTP {exc.code}: {raw[:500]}") from exc
    except urllib.error.URLError as exc:
        raise ProofPathError(f"OpenAI embeddings request failed: {exc}") from exc

    data = payload.get("data")
    if not isinstance(data, list) or not data:
        raise ProofPathError("OpenAI embeddings response missing data[].")
    emb = data[0].get("embedding") if isinstance(data[0], dict) else None
    if not isinstance(emb, list) or not all(isinstance(x, (int, float)) for x in emb):
        raise ProofPathError("OpenAI embeddings response missing embedding vector.")
    if len(emb) != dim:
        raise ProofPathError(
            f"Embedding length {len(emb)} does not match expected dimension {dim}. "
            "Align OPENAI_EMBEDDING_MODEL / TRACE_QUERY_VECTOR_DIM with the deployed Lambda."
        )
    return [float(x) for x in emb]


def resolve_case_vector(
    case: GoldenCase,
    ctx: RuntimeContext,
    *,
    mock_embeddings: bool,
) -> list[float] | None:
    return resolve_query_vector(
        query_text=case.query_text,
        explicit_query_vector=case.query_vector,
        ctx=ctx,
        mock_embeddings=mock_embeddings,
    )


def build_http_payload(case: GoldenCase, query_vector: list[float]) -> dict[str, Any]:
    return shared_build_http_payload(
        query_vector=query_vector,
        limit=case.limit,
        sql_filter=case.sql_filter,
        include_text=case.include_text,
    )


def call_search_http(
    search_url: str,
    payload: dict[str, Any],
    api_key: str | None,
    timeout_seconds: int,
) -> dict[str, Any]:
    return shared_call_search_http(search_url, payload, api_key, timeout_seconds)


def _extract_eq_filters(sql_filter: str) -> dict[str, list[str]]:
    """Best-effort parse for proof-level filter checks (city_code / doc_type equalities)."""
    found: dict[str, list[str]] = {"city_code": [], "doc_type": []}
    for field in ("city_code", "doc_type"):
        for m in re.finditer(
            rf"{field}\s*=\s*'((?:[^']|'')*)'",
            sql_filter,
            flags=re.IGNORECASE,
        ):
            val = m.group(1).replace("''", "'")
            found[field].append(val)
    return found


def assert_filter_match(case: GoldenCase, results: list[Any]) -> None:
    if not case.assertions.require_filter_match:
        return
    if not str(case.sql_filter).strip():
        return
    filters = _extract_eq_filters(case.sql_filter)
    for row in results:
        if not isinstance(row, dict):
            raise ProofPathError(
                f"Case {case.case_id}: expected result rows to be objects for filter checks."
            )
        for field, vals in filters.items():
            if not vals:
                continue
            actual = row.get(field)
            if actual not in vals:
                raise ProofPathError(
                    f"Case {case.case_id}: result row {row.get('incident_id')} has {field}={actual!r} "
                    f"not matching filter literals {vals!r}."
                )


def assert_http_case(case: GoldenCase, response: dict[str, Any]) -> None:
    if not response.get("ok"):
        raise ProofPathError(f"Case {case.case_id} failed HTTP validation: {response}")

    results = response.get("results")
    if not isinstance(results, list):
        raise ProofPathError(f"Case {case.case_id} returned invalid 'results'.")

    if case.assertions.require_non_empty_results and not results:
        raise ProofPathError(f"Case {case.case_id} returned no results.")

    assert_filter_match(case, results)

    if case.expected_ids:
        actual_ids = [
            item.get("incident_id")
            for item in results
            if isinstance(item, dict) and item.get("incident_id") is not None
        ]
        missing = [item for item in case.expected_ids if item not in actual_ids]
        if missing:
            raise ProofPathError(
                f"Case {case.case_id} is missing expected incident ids: {missing}"
            )


def assert_response_query_dim(response: dict[str, Any], expected: int) -> None:
    shared_assert_response_query_dim(response, expected)


def stable_response_view(response: dict[str, Any]) -> dict[str, Any]:
    clone = json.loads(json.dumps(response))
    clone.pop("took_ms", None)
    clone.pop("stub", None)
    return clone


def scrub_value(obj: Any, *, scrub_urls: bool) -> Any:
    """Recursively scrub volatile or environment-specific fields for committed fixtures."""
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            lk = k.lower()
            if lk in (
                "took_ms",
                "latency_ms",
                "requestid",
                "x-request-id",
                "apigw-requestid",
            ):
                continue
            if lk in ("executed_at", "run_id"):
                continue
            if scrub_urls and lk.endswith("url") and isinstance(v, str) and v.startswith("http"):
                out[k] = SCRUBBED_URL_PLACEHOLDER
                continue
            out[k] = scrub_value(v, scrub_urls=scrub_urls)
        return out
    if isinstance(obj, list):
        return [scrub_value(x, scrub_urls=scrub_urls) for x in obj]
    return obj


def write_json(path: Path, payload: Any) -> None:
    shared_write_json(path, payload)


def write_case_artifacts(
    run_dir: Path,
    case: GoldenCase,
    http_request: dict[str, Any] | None,
    http_response: dict[str, Any] | None,
    mcp_request: dict[str, Any] | None,
    mcp_response: dict[str, Any] | None,
) -> None:
    http_dir = ensure_dir(run_dir / "http")
    mcp_dir = ensure_dir(run_dir / "mcp")

    if http_request is not None:
        write_json(http_dir / f"{case.case_id}.request.json", http_request)
    if http_response is not None:
        write_json(http_dir / f"{case.case_id}.response.json", http_response)
    if mcp_request is not None:
        write_json(mcp_dir / f"{case.case_id}.request.json", mcp_request)
    if mcp_response is not None:
        write_json(mcp_dir / f"{case.case_id}.response.json", mcp_response)


def mcp_tool_args_for_case(case: GoldenCase) -> dict[str, Any]:
    args: dict[str, Any] = {
        "query_text": case.query_text,
        "limit": case.limit,
        "include_text": case.include_text,
    }
    if case.sql_filter.strip():
        args["sql_filter"] = case.sql_filter
    else:
        args["sql_filter"] = ""
    return args


def call_search_mcp_bridge(
    *,
    repo_root: Path,
    case: GoldenCase,
    ctx: RuntimeContext,
    timeout_seconds: int,
    mock_embeddings: bool,
) -> dict[str, Any]:
    env: dict[str, str] = {}
    for key in (
        "TRACE_SEARCH_URL",
        "TRACE_API_KEY",
        "TRACE_MCP_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_EMBEDDING_MODEL",
        "TRACE_QUERY_VECTOR_DIM",
        "USE_MOCK_EMBEDDINGS",
        "TRACE_MCP_MOCK",
        "MCP_FETCH_TIMEOUT_MS",
        "OVERRIDE_VECTOR_DIM",
    ):
        v = os.environ.get(key)
        if v is not None:
            env[key] = v
    env["TRACE_SEARCH_URL"] = ctx.search_url
    if ctx.api_key:
        env["TRACE_API_KEY"] = ctx.api_key
    env["TRACE_QUERY_VECTOR_DIM"] = str(ctx.query_dim)
    if ctx.embedding_model:
        env["OPENAI_EMBEDDING_MODEL"] = ctx.embedding_model
    if mock_embeddings:
        env["USE_MOCK_EMBEDDINGS"] = "1"

    tool_args = mcp_tool_args_for_case(case)
    return run_search_cold_archive(
        repo_root=repo_root,
        env=env,
        tool_arguments=tool_args,
        bridge_entry=default_bridge_entry(repo_root),
        timeout_seconds=timeout_seconds,
    )


def run_case(
    case: GoldenCase,
    ctx: RuntimeContext,
    repo_root: Path,
    run_dir: Path,
    *,
    timeout_seconds: int,
    mcp_timeout_seconds: int,
    mock_embeddings: bool,
    allow_missing_vectors: bool,
    skip_mcp: bool,
    dry_run: bool,
) -> CaseResult:
    result = CaseResult(case_id=case.case_id)
    http_request = None
    http_response = None
    mcp_request = mcp_tool_args_for_case(case)
    mcp_response = None

    if dry_run:
        result.notes.append("Dry run: skipped HTTP, MCP, and embedding calls.")
        write_case_artifacts(run_dir, case, None, None, mcp_request, None)
        return result

    vector: list[float] | None = None
    try:
        vector = resolve_case_vector(case, ctx, mock_embeddings=mock_embeddings)
    except ProofPathError:
        if not allow_missing_vectors:
            raise
        result.notes.append("Skipped embedding (set OPENAI_API_KEY or use --mock-embeddings).")

    if vector is None:
        if not allow_missing_vectors:
            raise ProofPathError(
                f"Case {case.case_id}: could not resolve query vector (embedding failed or missing)."
            )
        result.notes.append("Skipped HTTP search (no query vector).")
    else:
        http_request = build_http_payload(case, vector)
        http_response = call_search_http(
            ctx.search_url,
            http_request,
            ctx.api_key,
            timeout_seconds,
        )
        assert_response_query_dim(http_response, ctx.query_dim)
        assert_http_case(case, http_response)
        result.http_ok = True

    if skip_mcp:
        result.notes.append("Skipped MCP validation because --skip-mcp was set.")
    else:
        try:
            mcp_response = call_search_mcp_bridge(
                repo_root=repo_root,
                case=case,
                ctx=ctx,
                timeout_seconds=mcp_timeout_seconds,
                mock_embeddings=mock_embeddings,
            )
        except McpStdioError as exc:
            raise ProofPathError(f"MCP path failed for {case.case_id}: {exc}") from exc
        assert_response_query_dim(mcp_response, ctx.query_dim)
        assert_http_case(case, mcp_response)
        result.mcp_ok = True

    write_case_artifacts(
        run_dir, case, http_request, http_response, mcp_request, mcp_response
    )
    return result


def append_case_to_manifest(manifest: RunManifest, case_result: CaseResult) -> None:
    manifest.cases.append(asdict(case_result))


def _missing_validation_steps(case_result: CaseResult) -> list[str]:
    missing: list[str] = []
    if not case_result.http_ok:
        missing.append("HTTP")
    if not case_result.mcp_ok:
        missing.append("MCP")
    return missing


def ensure_complete_proof_run(
    case_results: list[CaseResult],
    *,
    dry_run: bool,
    skip_mcp: bool,
    allow_missing_vectors: bool,
) -> None:
    incomplete: list[str] = []
    for case_result in case_results:
        missing = _missing_validation_steps(case_result)
        if missing:
            incomplete.append(f"{case_result.case_id} ({' and '.join(missing)} missing)")

    if not incomplete:
        return

    mode_notes: list[str] = []
    if dry_run:
        mode_notes.append("dry-run mode skips live validation")
    if skip_mcp:
        mode_notes.append("--skip-mcp skips MCP validation")
    if allow_missing_vectors:
        mode_notes.append(
            "--allow-missing-vectors may skip HTTP validation when no query vector is available"
        )

    detail = "; ".join(mode_notes)
    if detail:
        detail = f" ({detail})"

    raise ProofPathError(
        "Incomplete proof run: Step 3 requires both HTTP and MCP validation for every case"
        f"{detail}. Incomplete cases: {', '.join(incomplete)}."
    )


def manifest_for_run(run_id: str, now: datetime, ctx: RuntimeContext) -> RunManifest:
    return RunManifest(
        run_id=run_id,
        executed_at=now.isoformat(),
        stack_name=ctx.stack_name,
        region=ctx.region,
        search_url=ctx.search_url,
        dataset_uri=ctx.dataset_uri,
        api_auth_mode=ctx.api_auth_mode,
        local_api_key_supplied=ctx.local_api_key_supplied,
        embedding_model=ctx.embedding_model,
        query_dim=ctx.query_dim,
    )


def write_manifest(run_dir: Path, manifest: RunManifest) -> None:
    write_json(run_dir / "manifest.json", asdict(manifest))


def _load_required_stable_fixture_artifact(path: Path, *, case_id: str, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise ProofPathError(
            f"Missing {label} artifact for {case_id}: {path}. Stable fixture promotion requires "
            "both request and response artifacts for HTTP and MCP."
        )
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ProofPathError(
            f"Invalid {label} artifact for {case_id}: expected a JSON object in {path}, "
            f"got {type(payload).__name__}."
        )
    return payload


def promote_stable_fixtures(
    run_dir: Path,
    cases: list[GoldenCase],
    stable_case_ids: list[str],
    dest_dir: Path,
) -> None:
    ensure_dir(dest_dir)
    case_ids = {c.case_id for c in cases}
    for cid in stable_case_ids:
        if cid not in case_ids:
            raise ProofPathError(f"Unknown stable fixture case_id: {cid}")
        http_resp_path = run_dir / "http" / f"{cid}.response.json"
        mcp_resp_path = run_dir / "mcp" / f"{cid}.response.json"
        http_req_path = run_dir / "http" / f"{cid}.request.json"
        mcp_req_path = run_dir / "mcp" / f"{cid}.request.json"
        http_req = _load_required_stable_fixture_artifact(
            http_req_path, case_id=cid, label="HTTP request"
        )
        http_resp = _load_required_stable_fixture_artifact(
            http_resp_path, case_id=cid, label="HTTP response"
        )
        mcp_req = _load_required_stable_fixture_artifact(
            mcp_req_path, case_id=cid, label="MCP request"
        )
        mcp_resp = _load_required_stable_fixture_artifact(
            mcp_resp_path, case_id=cid, label="MCP response"
        )

        http_req_stable = scrub_value(
            redact_http_request_for_stable_fixture(http_req), scrub_urls=True
        )
        http_bundle = {
            "case_id": cid,
            "channel": "http",
            "request": http_req_stable,
            "response": scrub_value(stable_response_view(http_resp), scrub_urls=True),
        }
        mcp_bundle = {
            "case_id": cid,
            "channel": "mcp",
            "request": scrub_value(mcp_req, scrub_urls=True),
            "response": scrub_value(stable_response_view(mcp_resp), scrub_urls=True),
        }
        write_json(dest_dir / f"http_{cid}.json", http_bundle)
        write_json(dest_dir / f"mcp_{cid}.json", mcp_bundle)


def main() -> int:
    args = parse_args()
    try:
        validate_run_flags(args)
    except ProofPathError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    now = utc_now()
    run_id = make_run_id(now)
    run_dir = ensure_dir(args.artifacts_root / run_id)
    repo_root = repo_root_from_args(args.repo_root)

    try:
        cases = load_cases(args.cases)
        ctx = resolve_runtime_context(args)
        manifest = manifest_for_run(run_id, now, ctx)
        case_results: list[CaseResult] = []

        dry_run = bool(args.dry_run)
        mock_embeddings = bool(args.mock_embeddings)

        for case in cases:
            case_result = run_case(
                case,
                ctx,
                repo_root,
                run_dir,
                timeout_seconds=args.timeout_seconds,
                mcp_timeout_seconds=args.mcp_timeout_seconds,
                mock_embeddings=mock_embeddings,
                allow_missing_vectors=args.allow_missing_vectors,
                skip_mcp=args.skip_mcp,
                dry_run=dry_run,
            )
            case_results.append(case_result)
            append_case_to_manifest(manifest, case_result)

        write_manifest(run_dir, manifest)
        ensure_complete_proof_run(
            case_results,
            dry_run=dry_run,
            skip_mcp=bool(args.skip_mcp),
            allow_missing_vectors=bool(args.allow_missing_vectors),
        )

        if args.write_stable_fixtures and not dry_run:
            assert_stable_fixture_promotion_context(
                ctx,
                allow_non_eval_stable_fixtures=bool(args.allow_non_eval_stable_fixtures),
            )
            raw = (args.stable_fixture_cases or "").strip()
            ids = [x.strip() for x in raw.split(",") if x.strip()]
            if not ids:
                raise ProofPathError("No cases selected for stable fixture promotion.")
            promote_stable_fixtures(run_dir, cases, ids, STABLE_FIXTURES_DIR)

    except ProofPathError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except McpStdioError as exc:
        print(f"MCP error: {exc}", file=sys.stderr)
        return 1

    print(f"Proof path completed. Artifacts: {run_dir}")
    if args.write_stable_fixtures:
        print(f"Stable fixtures written under {STABLE_FIXTURES_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
