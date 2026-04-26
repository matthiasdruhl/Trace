import { buildWhyThisMatched } from "./explanations.js";
import { loadCuratedCases } from "./cases.js";
import { embedText, resolveEmbeddingConfig } from "./embeddings.js";
import { serializeTypedFilters } from "./filters.js";
import {
  APP_DEFAULT_LIMIT,
  APP_LIMIT_MAX,
  FATAL_ERROR_MESSAGE_CHARS,
  FetchLike,
  HttpError,
  generateRequestId,
  isPlainObject,
  normalizeForPreview,
  safePreview,
  truncate,
} from "./common.js";
import { callSearch } from "./search-client.js";
import {
  AppSearchResponse,
  SearchBackendRow,
  SearchRequest,
} from "./search-types.js";

export type ApiGatewayLikeEvent = {
  version?: string;
  rawPath?: string;
  path?: string;
  routeKey?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
  httpMethod?: string;
};

export type ApiGatewayLikeResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

type AppApiDependencies = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  requestIdFactory?: () => string;
};

type SearchRequestBody = {
  queryText: string;
  filters?: unknown;
  limit?: number;
};

const SEARCH_BODY_KEYS = new Set<keyof SearchRequestBody>([
  "queryText",
  "filters",
  "limit",
]);

function validateObjectKeys(
  label: string,
  raw: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): void {
  for (const key of Object.keys(raw)) {
    if (allowedKeys.has(key)) {
      continue;
    }
    throw new HttpError(400, "INVALID_REQUEST", `${label}.${key} is not supported.`);
  }
}

function jsonResponse(
  statusCode: number,
  requestId: string,
  body: Record<string, unknown>
): ApiGatewayLikeResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
    body: JSON.stringify(body),
  };
}

function errorResponse(error: unknown, requestId: string): ApiGatewayLikeResult {
  if (error instanceof HttpError) {
    return jsonResponse(error.status, requestId, {
      error: {
        code: error.code,
        message: error.expose
          ? safePreview(error.message, 220)
          : "Request failed.",
      },
    });
  }

  const message =
    error instanceof Error
      ? truncate(normalizeForPreview(error.message), FATAL_ERROR_MESSAGE_CHARS)
      : truncate(normalizeForPreview(String(error)), FATAL_ERROR_MESSAGE_CHARS);

  console.error(
    "[App API Error]",
    JSON.stringify({
      kind: "request_failure",
      requestId,
      message,
    })
  );

  return jsonResponse(500, requestId, {
    error: {
      code: "INTERNAL",
      message: "Internal server error.",
    },
  });
}

function requestMethod(event: ApiGatewayLikeEvent): string {
  return (
    event.requestContext?.http?.method ??
    event.httpMethod ??
    event.routeKey?.split(" ", 2)[0] ??
    "GET"
  ).toUpperCase();
}

function requestPath(event: ApiGatewayLikeEvent): string {
  return event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? "/";
}

function parseJsonBody(event: ApiGatewayLikeEvent): unknown {
  if (!event.body) {
    throw new HttpError(400, "EMPTY_BODY", "Request body is required.");
  }
  if (event.isBase64Encoded) {
    throw new HttpError(
      400,
      "INVALID_BODY_ENCODING",
      "Base64-encoded request bodies are not supported."
    );
  }
  try {
    return JSON.parse(event.body) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

function validateSearchBody(raw: unknown): SearchRequestBody {
  if (!isPlainObject(raw)) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must be an object.");
  }

  if ("sql_filter" in raw) {
    throw new HttpError(
      400,
      "UNSUPPORTED_FIELD",
      "sql_filter is not accepted. Use typed filters instead."
    );
  }

  validateObjectKeys("body", raw, SEARCH_BODY_KEYS);

  if (typeof raw.queryText !== "string" || raw.queryText.trim().length === 0) {
    throw new HttpError(
      400,
      "INVALID_QUERY",
      "queryText must be a non-empty string."
    );
  }

  let limit = APP_DEFAULT_LIMIT;
  if ("limit" in raw && raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit)) {
      throw new HttpError(400, "INVALID_LIMIT", "limit must be an integer.");
    }
    limit = raw.limit;
  }
  if (limit < 1 || limit > APP_LIMIT_MAX) {
    throw new HttpError(
      400,
      "INVALID_LIMIT",
      `limit must be between 1 and ${APP_LIMIT_MAX}.`
    );
  }

  return {
    queryText: raw.queryText.trim(),
    filters: raw.filters,
    limit,
  };
}

function mapSearchResultRow(
  row: SearchBackendRow,
  queryText: string,
  filters: ReturnType<typeof serializeTypedFilters>["filters"]
) {
  const incidentId = row.incident_id;
  const timestamp = row.timestamp;
  const cityCode = row.city_code;
  const docType = row.doc_type;
  const score = row.score;
  const textContent = row.text_content;

  if (
    typeof incidentId !== "string" ||
    typeof timestamp !== "string" ||
    typeof cityCode !== "string" ||
    typeof docType !== "string" ||
    typeof score !== "number" ||
    !Number.isFinite(score)
  ) {
    throw new HttpError(
      502,
      "INVALID_BACKEND_RESPONSE",
      "Search backend returned an invalid result row.",
      { expose: false }
    );
  }

  if (textContent !== undefined && typeof textContent !== "string") {
    throw new HttpError(
      502,
      "INVALID_BACKEND_RESPONSE",
      "Search backend returned an invalid text payload.",
      { expose: false }
    );
  }

  return {
    incident_id: incidentId,
    timestamp,
    city_code: cityCode,
    doc_type: docType,
    text_content: textContent,
    score,
    why_this_matched: buildWhyThisMatched({
      queryText,
      filters,
      row: {
        incident_id: incidentId,
        timestamp,
        city_code: cityCode,
        doc_type: docType,
        text_content: textContent,
      },
    }),
  };
}

function buildHealthPayload(env: NodeJS.ProcessEnv): {
  ok: boolean;
  service: string;
  ready: boolean;
  checks: Record<string, boolean>;
} {
  const hasSearchUrl = Boolean(env.TRACE_SEARCH_URL?.trim()) || Boolean(env.TRACE_MCP_MOCK);
  let embeddingsConfigured = false;
  try {
    const embeddingConfig = resolveEmbeddingConfig(env);
    embeddingsConfigured =
      embeddingConfig.useMockEmbeddings || Boolean(env.OPENAI_API_KEY?.trim());
  } catch {
    embeddingsConfigured = false;
  }

  const ready = hasSearchUrl && embeddingsConfigured;
  return {
    ok: ready,
    service: "trace-app-api",
    ready,
    checks: {
      traceSearchUrl: hasSearchUrl,
      embeddingsConfigured,
    },
  };
}

async function handleSearch(
  event: ApiGatewayLikeEvent,
  deps: AppApiDependencies,
  requestId: string
): Promise<ApiGatewayLikeResult> {
  const body = validateSearchBody(parseJsonBody(event));
  const appliedFilter = serializeTypedFilters(body.filters);

  const queryVector = await embedText(body.queryText, {
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const searchRequest: SearchRequest = {
    query_vector: queryVector,
    sql_filter: appliedFilter.sqlFilter,
    limit: body.limit ?? APP_DEFAULT_LIMIT,
    include_text: true,
  };

  const searchResponse = await callSearch(searchRequest, {
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const responseBody: AppSearchResponse = {
    queryText: body.queryText,
    appliedFilter: {
      sqlFilter: appliedFilter.sqlFilter,
      summary: appliedFilter.summary,
    },
    results: searchResponse.results.map((row) =>
      mapSearchResultRow(row, body.queryText, appliedFilter.filters)
    ),
    meta: {
      tookMs: searchResponse.took_ms,
      resultCount: searchResponse.results.length,
      queryMode: "live",
    },
  };

  console.info(
    "[App API]",
    JSON.stringify({
      kind: "search_success",
      requestId,
      resultCount: responseBody.meta.resultCount,
      tookMs: responseBody.meta.tookMs,
      sqlFilter: responseBody.appliedFilter.sqlFilter,
    })
  );

  return jsonResponse(200, requestId, responseBody as unknown as Record<string, unknown>);
}

export function createAppApiHandler(deps: AppApiDependencies = {}) {
  const env = deps.env ?? process.env;
  return async function handler(
    event: ApiGatewayLikeEvent
  ): Promise<ApiGatewayLikeResult> {
    const requestId = (deps.requestIdFactory ?? generateRequestId)();
    try {
      const method = requestMethod(event);
      const path = requestPath(event);

      if (method === "GET" && path === "/api/health") {
        const payload = buildHealthPayload(env);
        return jsonResponse(payload.ready ? 200 : 503, requestId, payload);
      }

      if (method === "GET" && path === "/api/cases") {
        return jsonResponse(200, requestId, {
          cases: loadCuratedCases(),
        });
      }

      if (method === "POST" && path === "/api/search") {
        return await handleSearch(event, { ...deps, env }, requestId);
      }

      if (path === "/api/search" || path === "/api/cases" || path === "/api/health") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      }

      throw new HttpError(404, "NOT_FOUND", "Route not found.");
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}
