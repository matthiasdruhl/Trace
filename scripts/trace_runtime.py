from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_QUERY_VECTOR_DIM = 1536


class TraceRuntimeError(RuntimeError):
    """Raised when shared Trace runtime helpers cannot complete safely."""


@dataclass
class RuntimeContext:
    stack_name: str | None
    region: str | None
    search_url: str
    dataset_uri: str | None
    api_key: str | None
    embedding_model: str | None
    query_dim: int
    api_auth_mode: str
    local_api_key_supplied: bool
    function_arn: str | None = None
    function_name: str | None = None
    function_memory_mb: int | None = None
    function_architectures: tuple[str, ...] = ()


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
        raise TraceRuntimeError(
            "boto3 is required for --stack-name resolution. "
            "Install scripts/requirements.txt or set explicit runtime URLs."
        ) from exc

    cf = boto3.client("cloudformation", region_name=region)
    try:
        resp = cf.describe_stacks(StackName=stack_name)
    except Exception as exc:
        raise TraceRuntimeError(
            f"Failed to describe CloudFormation stack {stack_name!r} in {region}: {exc}"
        ) from exc
    stacks = resp.get("Stacks") or []
    if not stacks:
        raise TraceRuntimeError(f"Stack not found: {stack_name}")
    return stacks[0]


def _stack_output(stack: dict[str, Any], key: str) -> str | None:
    for output in stack.get("Outputs") or []:
        if output.get("OutputKey") == key:
            value = output.get("OutputValue")
            return str(value).strip() if value else None
    return None


def _stack_parameters(stack: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for param in stack.get("Parameters") or []:
        key = param.get("ParameterKey")
        value = param.get("ParameterValue")
        if isinstance(key, str) and value is not None:
            out[key] = str(value)
    return out


def _dataset_uri_from_parameters(params: dict[str, str]) -> str | None:
    bucket = params.get("TraceDataBucketName")
    prefix = params.get("TraceLancePrefix")
    if bucket and prefix:
        return f"s3://{bucket}/{prefix}"
    return None


def deployed_api_auth_mode_from_stack_parameters(params: dict[str, str]) -> str:
    ref = (params.get("TraceApiKeySecretRef") or "").strip()
    if not ref:
        return "iam_only_or_public"
    return "api_key"


def lambda_function_name_from_arn(arn: str) -> str:
    return arn.rsplit(":", 1)[-1]


def _load_lambda_function_configuration(
    function_name_or_arn: str,
    region: str,
) -> dict[str, Any] | None:
    try:
        import boto3  # type: ignore[import-untyped]
    except ImportError:
        return None

    client = boto3.client("lambda", region_name=region)
    try:
        return client.get_function_configuration(FunctionName=function_name_or_arn)
    except Exception:
        return None


def _query_dim_from_function_configuration(cfg: dict[str, Any] | None) -> int | None:
    if cfg is None:
        return None
    env = (cfg.get("Environment") or {}).get("Variables") or {}
    raw = env.get("TRACE_QUERY_VECTOR_DIM")
    if not raw:
        return DEFAULT_QUERY_VECTOR_DIM
    try:
        return int(str(raw).strip())
    except ValueError:
        return None


def resolve_runtime_context(
    args: argparse.Namespace,
    *,
    require_function_arn: bool = False,
) -> RuntimeContext:
    stack_name = (getattr(args, "stack_name", None) or "").strip() or None
    region = (getattr(args, "region", None) or "").strip() or None
    search_url = (getattr(args, "search_url", None) or "").strip() or None
    dataset_uri = (getattr(args, "dataset_uri", None) or "").strip() or None
    api_key = (getattr(args, "api_key", None) or "").strip() or None
    local_api_key_supplied = api_key is not None
    embedding_model = (getattr(args, "embedding_model", None) or "").strip() or None
    query_dim = int(getattr(args, "query_dim", DEFAULT_QUERY_VECTOR_DIM))
    function_arn = (getattr(args, "function_arn", None) or "").strip() or None

    stack_detail: dict[str, Any] | None = None
    stack_params: dict[str, str] = {}
    if stack_name:
        if not region:
            raise TraceRuntimeError(
                "AWS region is required when using --stack-name "
                "(pass --region or set AWS_REGION / AWS_DEFAULT_REGION)."
            )
        stack_detail = _describe_stack(stack_name, region)
        stack_params = _stack_parameters(stack_detail)
        resolved_search_url = _stack_output(stack_detail, "SearchUrl")
        if not search_url:
            if not resolved_search_url:
                raise TraceRuntimeError(
                    f"Stack {stack_name!r} has no SearchUrl output. "
                    "Pass --search-url or deploy a stack that exposes SearchUrl."
                )
            search_url = resolved_search_url
        elif resolved_search_url and resolved_search_url.rstrip("/") != search_url.rstrip("/"):
            raise TraceRuntimeError(
                f"Explicit --search-url {search_url!r} does not match stack output "
                f"SearchUrl {resolved_search_url!r} for {stack_name!r}. "
                "Use the deployed stack output or omit --stack-name if you intentionally "
                "want to benchmark a different endpoint."
            )
        if not dataset_uri:
            dataset_uri = _dataset_uri_from_parameters(stack_params)
        resolved_function_arn = _stack_output(stack_detail, "TraceSearchFunctionArn")
        if not function_arn:
            function_arn = resolved_function_arn
        elif (
            resolved_function_arn
            and resolved_function_arn.strip() != function_arn.strip()
        ):
            raise TraceRuntimeError(
                f"Explicit --function-arn {function_arn!r} does not match stack output "
                f"TraceSearchFunctionArn {resolved_function_arn!r} for {stack_name!r}. "
                "Use the deployed stack output or omit --stack-name if you intentionally "
                "want to benchmark a different function."
            )

    if not search_url:
        raise TraceRuntimeError(
            "Search URL is required: pass --search-url, set TRACE_SEARCH_URL, "
            "or use --stack-name with a stack that outputs SearchUrl."
        )

    if not dataset_uri:
        raise TraceRuntimeError(
            "Dataset URI is required: pass --dataset-uri, set TRACE_LANCE_S3_URI, "
            "or use --stack-name so TraceDataBucketName/TraceLancePrefix can be read."
        )

    if require_function_arn and not function_arn:
        raise TraceRuntimeError(
            "Function ARN is required for direct Lambda benchmarking. "
            "Pass --function-arn or use --stack-name with a stack that outputs TraceSearchFunctionArn."
        )

    if stack_detail is not None:
        api_auth_mode = deployed_api_auth_mode_from_stack_parameters(stack_params)
    else:
        api_auth_mode = "unknown"

    function_name = (
        lambda_function_name_from_arn(function_arn) if function_arn is not None else None
    )
    function_cfg = (
        _load_lambda_function_configuration(function_arn, region)
        if function_arn is not None and region is not None
        else None
    )
    resolved_dim = _query_dim_from_function_configuration(function_cfg)
    if resolved_dim is not None:
        query_dim = resolved_dim

    memory_mb: int | None = None
    architectures: tuple[str, ...] = ()
    if function_cfg is not None:
        raw_memory = function_cfg.get("MemorySize")
        if isinstance(raw_memory, int):
            memory_mb = raw_memory
        raw_architectures = function_cfg.get("Architectures")
        if isinstance(raw_architectures, list):
            architectures = tuple(
                arch for arch in raw_architectures if isinstance(arch, str)
            )

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
        function_arn=function_arn,
        function_name=function_name,
        function_memory_mb=memory_mb,
        function_architectures=architectures,
    )


def _mock_query_vector(text: str, dim: int) -> list[float]:
    seed = hashlib.sha256(text.encode("utf-8")).digest()
    out: list[float] = []
    for i in range(dim):
        b0 = seed[i % len(seed)]
        b1 = seed[(i + 1) % len(seed)]
        value = ((b0 << 8) | b1) / 65535.0 * 2.0 - 1.0
        out.append(value)
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
        raise TraceRuntimeError(
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
        raise TraceRuntimeError(f"OpenAI embeddings HTTP {exc.code}: {raw[:500]}") from exc
    except urllib.error.URLError as exc:
        raise TraceRuntimeError(f"OpenAI embeddings request failed: {exc}") from exc

    data = payload.get("data")
    if not isinstance(data, list) or not data:
        raise TraceRuntimeError("OpenAI embeddings response missing data[].")
    embedding = data[0].get("embedding") if isinstance(data[0], dict) else None
    if not isinstance(embedding, list) or not all(
        isinstance(item, (int, float)) for item in embedding
    ):
        raise TraceRuntimeError("OpenAI embeddings response missing embedding vector.")
    if len(embedding) != dim:
        raise TraceRuntimeError(
            f"Embedding length {len(embedding)} does not match expected dimension {dim}. "
            "Align OPENAI_EMBEDDING_MODEL / TRACE_QUERY_VECTOR_DIM with the deployed Lambda."
        )
    return [float(item) for item in embedding]


def resolve_query_vector(
    *,
    query_text: str,
    explicit_query_vector: list[float] | None,
    ctx: RuntimeContext,
    mock_embeddings: bool,
) -> list[float]:
    if explicit_query_vector is not None:
        if len(explicit_query_vector) != ctx.query_dim:
            raise TraceRuntimeError(
                f"Provided query_vector length {len(explicit_query_vector)} does not match expected "
                f"dimension {ctx.query_dim}."
            )
        return [float(item) for item in explicit_query_vector]

    return embed_query_text(
        query_text,
        model=ctx.embedding_model or "text-embedding-3-small",
        dim=ctx.query_dim,
        mock=mock_embeddings,
    )


def build_http_payload(
    *,
    query_vector: list[float],
    limit: int,
    sql_filter: str,
    include_text: bool,
) -> dict[str, Any]:
    return {
        "query_vector": query_vector,
        "limit": limit,
        "sql_filter": sql_filter,
        "include_text": include_text,
    }


def call_search_http(
    search_url: str,
    payload: dict[str, Any],
    api_key: str | None,
    timeout_seconds: int,
) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        search_url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    if api_key:
        req.add_header("X-TRACE-API-KEY", api_key)

    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as err:
            raise TraceRuntimeError(
                f"HTTP search failed with status {exc.code} and a non-JSON body: {err}"
            ) from exc
    except urllib.error.URLError as exc:
        raise TraceRuntimeError(f"HTTP search failed: {exc}") from exc


def assert_response_query_dim(response: dict[str, Any], expected: int) -> None:
    if response.get("ok") is not True:
        return
    if "query_dim" not in response:
        raise TraceRuntimeError(
            "Successful response is missing required field 'query_dim' "
            f"(expected integer {expected}; see docs/API_CONTRACT.md)."
        )
    query_dim = response["query_dim"]
    if isinstance(query_dim, bool) or not isinstance(query_dim, int):
        raise TraceRuntimeError(
            "Successful response field 'query_dim' must be a JSON integer "
            f"(expected {expected}), got {type(query_dim).__name__} with value {query_dim!r}."
        )
    if query_dim != expected:
        raise TraceRuntimeError(
            f"Response query_dim={query_dim} does not match expected runtime dimension {expected}."
        )


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    if len(values) == 1:
        return float(values[0])
    ordered = sorted(float(value) for value in values)
    rank = (len(ordered) - 1) * (pct / 100.0)
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    weight = rank - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def median(values: list[float]) -> float | None:
    return percentile(values, 50.0)
