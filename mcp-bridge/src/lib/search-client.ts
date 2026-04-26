import {
  FetchLike,
  envBool,
  fetchTimedOutError,
  fetchTimeoutMs,
  fetchWithTimeout,
  formatUpstreamHttpFailure,
  isAbortError,
  isPlainObject,
  isRetriableNetworkError,
  mcpDebugSuffix,
  requestIdFromResponse,
  safeBackendDiagnostics,
  safePreview,
  traceIdFromResponse,
} from "./common.js";
import { resolveEmbeddingConfig } from "./embeddings.js";
import { SearchRequest, SearchResponse } from "./search-types.js";

export function apiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.TRACE_API_KEY ?? env.TRACE_MCP_API_KEY;
}

export function mockSearchResponse(
  req: SearchRequest,
  env: NodeJS.ProcessEnv = process.env
): SearchResponse {
  const { expectedVectorDim } = resolveEmbeddingConfig(env);
  return {
    ok: true,
    results: [],
    query_dim: expectedVectorDim,
    k: req.limit,
    took_ms: 0,
    stub: `mock response for query with limit=${req.limit} (no Lambda call)`,
  };
}

export function unwrapPossibleApigwEnvelope(parsed: unknown): unknown {
  if (!isPlainObject(parsed)) {
    return parsed;
  }
  const statusCode = parsed.statusCode;
  const body = parsed.body;
  if (typeof statusCode === "number" && typeof body === "string") {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return parsed;
    }
  }
  return parsed;
}

export function extractBackendFailureMessage(body: Record<string, unknown>): string {
  const error = body.error;
  if (isPlainObject(error)) {
    if (typeof error.message === "string") {
      return error.message;
    }
    if (typeof error.code === "string") {
      return error.code;
    }
  }
  if (typeof body.message === "string") {
    return body.message;
  }
  return "Unknown error from search backend.";
}

export function validateSearchResponseBody(body: unknown): SearchResponse {
  if (!isPlainObject(body)) {
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  if ("ok" in body && body.ok !== undefined && typeof body.ok !== "boolean") {
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  if (body.ok === false) {
    throw new Error(
      `Search backend error: ${safePreview(extractBackendFailureMessage(body))}`
    );
  }

  if (body.ok !== true) {
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  if (!Array.isArray(body.results)) {
    if ("error" in body || typeof body.message === "string") {
      throw new Error(
        `Search backend error: ${safePreview(extractBackendFailureMessage(body))}`
      );
    }
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  const tookMs =
    typeof body.took_ms === "number" && Number.isFinite(body.took_ms)
      ? body.took_ms
      : typeof body.latency_ms === "number" && Number.isFinite(body.latency_ms)
        ? body.latency_ms
        : undefined;

  if (tookMs === undefined) {
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  if (typeof body.query_dim !== "number" || !Number.isFinite(body.query_dim)) {
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  if (typeof body.k !== "number" || !Number.isFinite(body.k)) {
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  return {
    ok: true,
    results: body.results as Record<string, unknown>[],
    query_dim: body.query_dim,
    k: body.k,
    took_ms: tookMs,
    stub: typeof body.stub === "string" ? body.stub : undefined,
  };
}

export async function callSearchHttp(
  url: string,
  req: SearchRequest,
  timeoutMs: number,
  options?: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
  }
): Promise<SearchResponse> {
  const env = options?.env ?? process.env;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const key = apiKey(env);
  if (key) {
    headers["x-trace-api-key"] = key;
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(req),
      },
      timeoutMs
    );
  } catch (err) {
    if (isAbortError(err)) {
      throw fetchTimedOutError(timeoutMs);
    }
    throw err;
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    safeBackendDiagnostics({
      kind: "search_non_json",
      res,
      bodyText: text,
      env,
    });
    const requestId = requestIdFromResponse(res);
    const traceId = traceIdFromResponse(res);
    let message =
      `Bridge Error: Received an invalid or malformed response from the search backend. ` +
      `HTTP ${res.status} ${res.statusText || ""}.`;
    if (requestId) {
      message += ` Request-Id: ${requestId}.`;
    }
    if (traceId) {
      message += ` Trace-Id: ${traceId}.`;
    }
    message += ` Preview: ${safePreview(text)}`;
    message += mcpDebugSuffix(res, text.length, env);
    throw new Error(message);
  }

  const inner = unwrapPossibleApigwEnvelope(parsed);
  if (!res.ok) {
    if (isPlainObject(inner) && inner.ok === false) {
      const rawMessage = extractBackendFailureMessage(inner);
      safeBackendDiagnostics({
        kind: "search_error_envelope",
        res,
        bodyText: text,
        backendMessage: rawMessage,
        env,
      });
      const requestId = requestIdFromResponse(res);
      const traceId = traceIdFromResponse(res);
      let message = `Search backend error: ${safePreview(rawMessage)}`;
      if (requestId) {
        message += ` Request-Id: ${requestId}.`;
      }
      if (traceId) {
        message += ` Trace-Id: ${traceId}.`;
      }
      message += mcpDebugSuffix(res, text.length, env);
      throw new Error(message);
    }

    throw new Error(
      formatUpstreamHttpFailure({
        label: "Search request failed",
        res,
        bodyText: text,
        env,
      })
    );
  }

  return validateSearchResponseBody(inner);
}

export async function callSearch(
  req: SearchRequest,
  options?: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
    timeoutEnvName?: string;
  }
): Promise<SearchResponse> {
  const env = options?.env ?? process.env;
  if (envBool("TRACE_MCP_MOCK", env)) {
    return mockSearchResponse(req, env);
  }

  const url = env.TRACE_SEARCH_URL;
  if (!url) {
    throw new Error("TRACE_SEARCH_URL is required unless TRACE_MCP_MOCK=1");
  }

  const timeoutMs = fetchTimeoutMs(env, options?.timeoutEnvName);
  try {
    return await callSearchHttp(url, req, timeoutMs, {
      env,
      fetchImpl: options?.fetchImpl,
    });
  } catch (firstError) {
    if (isAbortError(firstError) || !isRetriableNetworkError(firstError)) {
      throw firstError;
    }
    return callSearchHttp(url, req, timeoutMs, {
      env,
      fetchImpl: options?.fetchImpl,
    });
  }
}
