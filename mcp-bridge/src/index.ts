import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** Known OpenAI embedding models → default output dimensions (must stay aligned with Rust `TRACE_QUERY_VECTOR_DIM`). */
const OPENAI_MODEL_DIMENSIONS: Readonly<Record<string, number>> = {
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
  "text-embedding-3-large": 3072,
};

/** Resolved at startup via [`resolveBridgeEmbeddingConfig`]. */
let resolvedEmbeddingModel = "text-embedding-3-small";
let resolvedExpectedVectorDim = 1536;

/** Inclusive; must match Lambda `MAX_K` / sane client bounds. */
const LIMIT_MIN = 1;
const LIMIT_MAX = 50;

/** Default `limit` when the argument is omitted (matches Lambda `default_k`). */
const DEFAULT_LIMIT = 10;

/** Default outbound `fetch` deadline; override with `MCP_FETCH_TIMEOUT_MS`. */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

function fetchTimeoutMs(): number {
  const raw = process.env.MCP_FETCH_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  return n;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  return false;
}

/** True for transient connection failures (retry once for Lambda); not timeouts. */
function isRetriableNetworkError(err: unknown): boolean {
  if (isAbortError(err)) {
    return false;
  }
  return err instanceof TypeError;
}

function fetchTimedOutError(timeoutMs: number): Error {
  return new Error(
    `Request timed out after ${timeoutMs}ms. The downstream service is unresponsive.`
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

type SearchRequest = {
  query_vector: number[];
  sql_filter: string;
  limit: number;
  include_text: boolean;
};

/** Matches Rust `lambda_engine::search::SearchResponse` JSON (`serde_json`). */
type SearchResponse = {
  ok: true;
  results: unknown[];
  query_dim: number;
  k: number;
  took_ms: number;
  stub?: string;
};

function envBool(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/**
 * When `true`, stderr logs may include extra non-sensitive metadata (for example `content-type`).
 * Does not enable full upstream bodies, unbounded error text, or credentials (previews stay capped).
 */
function logVerboseErrors(): boolean {
  return process.env.LOG_VERBOSE_ERRORS === "true";
}

/** Max characters of upstream-derived text in MCP errors and stderr previews (bounded). */
const SAFE_BODY_PREVIEW_CHARS = 200;

/** Max characters for fatal top-level error messages on stderr (avoids dumping upstream text). */
const FATAL_ERROR_MESSAGE_CHARS = 320;

/** Truncates before building error messages to limit what we retain in strings. */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen);
}

function normalizeForPreview(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Always bounded preview for logs and client-facing errors; never the full upstream payload. */
function safePreview(text: string, maxLen: number = SAFE_BODY_PREVIEW_CHARS): string {
  return truncate(normalizeForPreview(text), maxLen);
}

/**
 * Structured stderr diagnostics: status, IDs, short previews, lengths.
 * `MCP_DEBUG` / `LOG_VERBOSE_ERRORS` do not add full payloads or credential material.
 */
function safeBackendDiagnostics(input: {
  kind: string;
  label?: string;
  res: Response;
  bodyText: string;
  backendMessage?: string;
}): void {
  const payload: Record<string, unknown> = {
    kind: input.kind,
    label: input.label ?? null,
    status: input.res.status,
    statusText: input.res.statusText,
    requestId: requestIdFromResponse(input.res) ?? null,
    traceId: traceIdFromResponse(input.res) ?? null,
    bodyPreview: safePreview(input.bodyText),
    bodyLength: input.bodyText.length,
  };
  if (input.backendMessage !== undefined) {
    payload.backendMessagePreview = safePreview(input.backendMessage);
    payload.backendMessageLength = input.backendMessage.length;
  }
  if (logVerboseErrors()) {
    const ct = input.res.headers.get("content-type");
    if (ct) {
      payload.contentType = ct;
    }
  }
  logBackendError(payload);
}

/** Non-secret debug metadata only (no response body text). */
function mcpDebugSuffix(res: Response, bodyCharLength: number): string {
  if (!envBool("MCP_DEBUG")) {
    return "";
  }
  const parts = [`bodyChars=${bodyCharLength}`];
  const ct = res.headers.get("content-type");
  if (ct) {
    parts.push(`contentType=${ct}`);
  }
  return ` [debug: ${parts.join(", ")}]`;
}

function requestIdFromResponse(res: Response): string | undefined {
  return (
    res.headers.get("x-request-id") ??
    res.headers.get("x-openai-request-id") ??
    res.headers.get("apigw-requestid") ??
    res.headers.get("x-amzn-requestid") ??
    res.headers.get("cf-ray") ??
    undefined
  );
}

function traceIdFromResponse(res: Response): string | undefined {
  return res.headers.get("x-amzn-trace-id") ?? undefined;
}

/** Structured stderr line for CloudWatch Insights (`[Backend Error]` + JSON payload). */
function logBackendError(payload: Record<string, unknown>): void {
  console.error("[Backend Error]", JSON.stringify(payload));
}

/**
 * Logs safe upstream diagnostics to stderr; returns a short MCP-facing message
 * (bounded preview + optional non-secret `MCP_DEBUG` metadata).
 */
function formatUpstreamHttpFailure(opts: {
  label: string;
  res: Response;
  bodyText: string;
}): string {
  safeBackendDiagnostics({
    kind: "upstream_http",
    label: opts.label,
    res: opts.res,
    bodyText: opts.bodyText,
  });

  const rid = requestIdFromResponse(opts.res);
  const tid = traceIdFromResponse(opts.res);
  const preview = safePreview(opts.bodyText);
  let msg = `${opts.label}: HTTP ${opts.res.status} ${opts.res.statusText || ""}.`;
  if (rid) {
    msg += ` Request-Id: ${rid}.`;
  }
  if (tid) {
    msg += ` Trace-Id: ${tid}.`;
  }
  msg += ` Response preview: ${preview}`;
  msg += mcpDebugSuffix(opts.res, opts.bodyText.length);
  return msg;
}

function apiKey(): string | undefined {
  return process.env.TRACE_API_KEY ?? process.env.TRACE_MCP_API_KEY;
}

function resolveDimForModelOrOverride(model: string): number {
  const overrideRaw = process.env.OVERRIDE_VECTOR_DIM?.trim();
  if (overrideRaw) {
    const n = Number.parseInt(overrideRaw, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(
        "CRITICAL: OVERRIDE_VECTOR_DIM must be a positive integer when set."
      );
    }
    return n;
  }
  const dim = OPENAI_MODEL_DIMENSIONS[model];
  if (dim !== undefined) {
    return dim;
  }
  throw new Error(
    `CRITICAL: Unknown OPENAI_EMBEDDING_MODEL "${model}". Set OVERRIDE_VECTOR_DIM to the embedding size, or use a known model (text-embedding-3-small, text-embedding-ada-002, text-embedding-3-large).`
  );
}

/**
 * Resolves embedding model + expected vector size. Call once from [`validateEmbeddingConfig`].
 * If `TRACE_QUERY_VECTOR_DIM` is set, it must match the resolved dimension (same as Lambda env).
 */
function resolveBridgeEmbeddingConfig(): void {
  const model = (
    process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small"
  ).trim();
  if (!model) {
    throw new Error(
      "CRITICAL: OPENAI_EMBEDDING_MODEL must not be empty when set."
    );
  }
  resolvedEmbeddingModel = model;
  resolvedExpectedVectorDim = resolveDimForModelOrOverride(model);

  const traceRaw = process.env.TRACE_QUERY_VECTOR_DIM?.trim();
  if (traceRaw) {
    const n = Number.parseInt(traceRaw, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(
        "CRITICAL: TRACE_QUERY_VECTOR_DIM must be a positive integer when set."
      );
    }
    if (n !== resolvedExpectedVectorDim) {
      throw new Error(
        `CRITICAL: TRACE_QUERY_VECTOR_DIM (${n}) must equal the resolved embedding dimension ${resolvedExpectedVectorDim} for model "${model}". Set TRACE_QUERY_VECTOR_DIM=${resolvedExpectedVectorDim} on the Lambda, or unset TRACE_QUERY_VECTOR_DIM here.`
      );
    }
  }
}

/** Fail fast unless mock embeddings are explicitly enabled. */
function validateEmbeddingConfig(): void {
  resolveBridgeEmbeddingConfig();

  if (envBool("USE_MOCK_EMBEDDINGS")) {
    return;
  }
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "CRITICAL: OPENAI_API_KEY is required for embedding generation."
    );
  }
}

async function embedQuery(text: string): Promise<number[]> {
  if (envBool("USE_MOCK_EMBEDDINGS")) {
    console.warn(
      "trace-mcp-bridge: USE_MOCK_EMBEDDINGS=true; using zero vector (testing only)"
    );
    return new Array<number>(resolvedExpectedVectorDim).fill(0);
  }

  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "CRITICAL: OPENAI_API_KEY is required for embedding generation."
    );
  }

  const model = resolvedEmbeddingModel;
  const expectedDim = resolvedExpectedVectorDim;

  const timeoutMs = fetchTimeoutMs();
  let res: Response;
  try {
    res = await fetchWithTimeout(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: text,
        }),
      },
      timeoutMs
    );
  } catch (err) {
    if (isAbortError(err)) {
      throw fetchTimedOutError(timeoutMs);
    }
    throw err;
  }

  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(
      formatUpstreamHttpFailure({
        label: "OpenAI embeddings failed",
        res,
        bodyText,
      })
    );
  }

  const data = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = data.data?.[0]?.embedding;
  const got = embedding?.length ?? 0;
  if (!embedding || got !== expectedDim) {
    throw new Error(
      `Model ${model} returned ${got} dimensions, but ${expectedDim} were expected.`
    );
  }
  return embedding;
}

function mockSearchResponse(req: SearchRequest): SearchResponse {
  return {
    ok: true,
    results: [],
    query_dim: resolvedExpectedVectorDim,
    k: req.limit,
    took_ms: 0,
    stub: `mock response for query with limit=${req.limit} (no Lambda call)`,
  };
}

/** If the HTTP client hit API Gateway HTTP API v2, unwrap the JSON `body` string. */
function unwrapPossibleApigwEnvelope(parsed: unknown): unknown {
  if (!isPlainObject(parsed)) {
    return parsed;
  }
  const sc = parsed.statusCode;
  const b = parsed.body;
  if (typeof sc === "number" && typeof b === "string") {
    try {
      const inner: unknown = JSON.parse(b);
      return inner;
    } catch {
      return parsed;
    }
  }
  return parsed;
}

function extractBackendFailureMessage(body: Record<string, unknown>): string {
  const e = body.error;
  if (isPlainObject(e)) {
    if (typeof e.message === "string") {
      return e.message;
    }
    if (typeof e.code === "string") {
      return e.code;
    }
  }
  if (typeof body.message === "string") {
    return body.message;
  }
  return "Unknown error from search backend.";
}

/**
 * Validates Lambda / bridge JSON after `JSON.parse`. No `as SearchResponse` until checks pass.
 * Matches the Lambda success envelope: `results` and `took_ms` (accepts `latency_ms` as an alias for `took_ms`).
 */
function validateSearchResponseBody(body: unknown): SearchResponse {
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

  const list: unknown[] | null = Array.isArray(body.results)
    ? body.results
    : null;

  if (list === null) {
    if (
      "error" in body ||
      (typeof body.message === "string" && !Array.isArray(body.results))
    ) {
      throw new Error(
        `Search backend error: ${safePreview(extractBackendFailureMessage(body))}`
      );
    }
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  const tookRaw = body.took_ms;
  const latRaw = body.latency_ms;
  const took_ms =
    typeof tookRaw === "number" && Number.isFinite(tookRaw)
      ? tookRaw
      : typeof latRaw === "number" && Number.isFinite(latRaw)
        ? latRaw
        : undefined;

  if (took_ms === undefined) {
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  const query_dim = body.query_dim;
  const k = body.k;
  if (typeof query_dim !== "number" || !Number.isFinite(query_dim)) {
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }
  if (typeof k !== "number" || !Number.isFinite(k)) {
    throw new Error(
      "Bridge Error: Received an invalid or malformed response from the search backend."
    );
  }

  const out: SearchResponse = {
    ok: true,
    results: list,
    query_dim,
    k,
    took_ms,
  };
  if (typeof body.stub === "string") {
    out.stub = body.stub;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toolError(text: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

type ValidatedSearchToolArgs = {
  query_text: string;
  sql_filter: string;
  limit: number;
  include_text: boolean;
};

/** Strict validation — no `String`/`Number`/`Boolean` coercion on MCP inputs. */
function validateSearchToolArgs(
  raw: unknown
):
  | { ok: true; args: ValidatedSearchToolArgs }
  | { ok: false; message: string } {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: "Invalid argument: arguments must be a plain object.",
    };
  }

  if (!("query_text" in raw) || typeof raw.query_text !== "string") {
    return {
      ok: false,
      message: "Invalid argument: query_text must be a string.",
    };
  }
  if (raw.query_text.trim().length === 0) {
    return {
      ok: false,
      message: "Invalid argument: query_text must be a non-empty string.",
    };
  }

  let sql_filter = "";
  if ("sql_filter" in raw && raw.sql_filter !== undefined) {
    if (typeof raw.sql_filter !== "string") {
      return {
        ok: false,
        message: "Invalid argument: sql_filter must be a string.",
      };
    }
    sql_filter = raw.sql_filter;
  }

  let limit: number;
  if (!("limit" in raw) || raw.limit === undefined) {
    limit = DEFAULT_LIMIT;
  } else {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit)) {
      return {
        ok: false,
        message: "Invalid argument: limit must be an integer.",
      };
    }
    limit = raw.limit;
  }

  if (limit < LIMIT_MIN || limit > LIMIT_MAX) {
    return {
      ok: false,
      message: `Invalid argument: limit must be between ${LIMIT_MIN} and ${LIMIT_MAX} (inclusive).`,
    };
  }

  let include_text = false;
  if ("include_text" in raw && raw.include_text !== undefined) {
    if (typeof raw.include_text !== "boolean") {
      return {
        ok: false,
        message: "Invalid argument: include_text must be a boolean.",
      };
    }
    include_text = raw.include_text;
  }

  return {
    ok: true,
    args: { query_text: raw.query_text, sql_filter, limit, include_text },
  };
}

async function callSearchHttp(
  url: string,
  req: SearchRequest,
  timeoutMs: number
): Promise<SearchResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const key = apiKey();
  if (key) headers["x-trace-api-key"] = key;

  let res: Response;
  try {
    res = await fetchWithTimeout(
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
    });
    const rid = requestIdFromResponse(res);
    const tid = traceIdFromResponse(res);
    let msg = `Bridge Error: Received an invalid or malformed response from the search backend. HTTP ${res.status} ${res.statusText || ""}.`;
    if (rid) {
      msg += ` Request-Id: ${rid}.`;
    }
    if (tid) {
      msg += ` Trace-Id: ${tid}.`;
    }
    msg += ` Preview: ${safePreview(text)}`;
    msg += mcpDebugSuffix(res, text.length);
    throw new Error(msg);
  }

  const inner = unwrapPossibleApigwEnvelope(parsed);

  if (!res.ok) {
    if (isPlainObject(inner) && inner.ok === false) {
      const rawMsg = extractBackendFailureMessage(inner);
      safeBackendDiagnostics({
        kind: "search_error_envelope",
        res,
        bodyText: text,
        backendMessage: rawMsg,
      });
      const rid = requestIdFromResponse(res);
      const tid = traceIdFromResponse(res);
      const messageSummary = safePreview(rawMsg);
      let m = `Search backend error: ${messageSummary}`;
      if (rid) {
        m += ` Request-Id: ${rid}.`;
      }
      if (tid) {
        m += ` Trace-Id: ${tid}.`;
      }
      m += mcpDebugSuffix(res, text.length);
      throw new Error(m);
    }
    throw new Error(
      formatUpstreamHttpFailure({
        label: "Search request failed",
        res,
        bodyText: text,
      })
    );
  }

  return validateSearchResponseBody(inner);
}

async function callSearch(req: SearchRequest): Promise<SearchResponse> {
  if (envBool("TRACE_MCP_MOCK")) {
    return mockSearchResponse(req);
  }

  const url = process.env.TRACE_SEARCH_URL;
  if (!url) {
    throw new Error("TRACE_SEARCH_URL is required unless TRACE_MCP_MOCK=1");
  }

  const timeoutMs = fetchTimeoutMs();

  try {
    return await callSearchHttp(url, req, timeoutMs);
  } catch (first) {
    if (isAbortError(first) || !isRetriableNetworkError(first)) {
      throw first;
    }
    return await callSearchHttp(url, req, timeoutMs);
  }
}

async function main(): Promise<void> {
  validateEmbeddingConfig();

  const server = new Server(
    {
      name: "trace-mcp-bridge",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_cold_archive",
        description: `Semantic search over the cold Lance archive on S3 (Trace). limit is ${LIMIT_MIN}–${LIMIT_MAX} rows.`,
        inputSchema: {
          type: "object",
          properties: {
            query_text: {
              type: "string",
              description:
                "Natural language query (embedded via OpenAI unless USE_MOCK_EMBEDDINGS=true).",
            },
            sql_filter: {
              type: "string",
              description: "Optional metadata filter expression forwarded to the Lambda.",
            },
            limit: {
              type: "integer",
              minimum: LIMIT_MIN,
              maximum: LIMIT_MAX,
              description: `Result count (${LIMIT_MIN}–${LIMIT_MAX}); omit to use default ${DEFAULT_LIMIT}.`,
            },
            include_text: {
              type: "boolean",
              description:
                "When true, include text fields in result rows (forwarded to Lambda).",
            },
          },
          required: ["query_text"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "search_cold_archive") {
      return toolError(
        `Invalid argument: tool must be search_cold_archive (got ${request.params.name}).`
      );
    }

    const validated = validateSearchToolArgs(request.params.arguments);
    if (!validated.ok) {
      return toolError(validated.message);
    }

    const { query_text, sql_filter, limit, include_text } = validated.args;

    let vector: number[];
    try {
      vector = await embedQuery(query_text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `${err}`;
      return toolError(`Embedding generation failed (internal): ${msg}`);
    }

    const payload: SearchRequest = {
      query_vector: vector,
      sql_filter,
      limit,
      include_text,
    };

    try {
      const result = await callSearch(payload);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : `${err}`;
      return toolError(`Search request failed: ${msg}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  const payload: Record<string, unknown> = {
    kind: "fatal",
    name: err instanceof Error ? err.name : "non_error_thrown",
    message:
      err instanceof Error
        ? truncate(normalizeForPreview(err.message), FATAL_ERROR_MESSAGE_CHARS)
        : truncate(normalizeForPreview(String(err)), FATAL_ERROR_MESSAGE_CHARS),
  };
  if (envBool("MCP_DEBUG") && err instanceof Error && err.stack) {
    payload.stack = truncate(err.stack, 8000);
  }
  console.error("[Fatal]", JSON.stringify(payload));
  process.exit(1);
});
