import test from "node:test";
import assert from "node:assert/strict";

import { createAppApiHandler } from "./app-api.js";

const baseEnv = {
  TRACE_SEARCH_URL: "https://trace.example/search",
  OPENAI_API_KEY: "test-key",
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
} satisfies NodeJS.ProcessEnv;

test("GET /api/cases returns the curated case catalog", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-cases",
  });

  const response = await handler({
    rawPath: "/api/cases",
    requestContext: { http: { method: "GET", path: "/api/cases" } },
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    cases: Array<{ id: string }>;
  };
  assert.deepEqual(body.cases.map((entry) => entry.id), [
    "overdue-inspection-audit",
    "nyc-safety-incident",
    "insurance-lapse-coverage-gap",
  ]);
});

test("GET /api/health reports readiness from env configuration", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-health",
  });

  const response = await handler({
    rawPath: "/api/health",
    requestContext: { http: { method: "GET", path: "/api/health" } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    service: "trace-app-api",
    ready: true,
    checks: {
      traceSearchUrl: true,
      embeddingsConfigured: true,
    },
  });
});

test("GET /api/health resolves OPENAI_API_KEY from Secrets Manager metadata", async () => {
  const handler = createAppApiHandler({
    env: {
      TRACE_SEARCH_URL: "https://trace.example/search",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_API_KEY_SECRET_REF: "trace/openai-api-key",
      OPENAI_API_KEY_SECRET_JSON_KEY: "__EMPTY__",
    },
    requestIdFactory: () => "req-health-secret",
    secretClient: {
      async send(command) {
        const input = command.input as { SecretId?: string };
        assert.equal(input.SecretId, "trace/openai-api-key");
        return {
          SecretString: "secret-from-manager",
        };
      },
    },
  });

  const response = await handler({
    rawPath: "/api/health",
    requestContext: { http: { method: "GET", path: "/api/health" } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    service: "trace-app-api",
    ready: true,
    checks: {
      traceSearchUrl: true,
      embeddingsConfigured: true,
    },
  });
});

test("GET /api/health degrades to 503 when runtime secret resolution fails", async () => {
  const handler = createAppApiHandler({
    env: {
      TRACE_SEARCH_URL: "https://trace.example/search",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_API_KEY_SECRET_REF: "trace/openai-api-key",
      OPENAI_API_KEY_SECRET_JSON_KEY: "openaiApiKey",
    },
    requestIdFactory: () => "req-health-secret-failure",
    secretClient: {
      async send() {
        return {
          SecretString: "sk-plaintext",
        };
      },
    },
  });

  const response = await handler({
    rawPath: "/api/health",
    requestContext: { http: { method: "GET", path: "/api/health" } },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    service: "trace-app-api",
    ready: false,
    checks: {
      traceSearchUrl: true,
      embeddingsConfigured: false,
    },
  });
});

test("POST /api/search validates unsupported raw sql_filter input", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-invalid",
  });

  const response = await handler({
    rawPath: "/api/search",
    requestContext: { http: { method: "POST", path: "/api/search" } },
    body: JSON.stringify({
      queryText: "find audits",
      sql_filter: "city_code = 'NYC-TLC'",
    }),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "UNSUPPORTED_FIELD",
      message: "sql_filter is not accepted. Use typed filters instead.",
    },
  });
});

test("POST /api/search rejects unsupported request body fields", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-extra-field",
  });

  const response = await handler({
    rawPath: "/api/search",
    requestContext: { http: { method: "POST", path: "/api/search" } },
    body: JSON.stringify({
      queryText: "find audits",
      caseId: "overdue-inspection-audit",
    }),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "INVALID_REQUEST",
      message: "body.caseId is not supported.",
    },
  });
});

test("POST /api/search rejects ambiguous filter timestamps before downstream calls", async () => {
  let fetchCalled = false;
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-bad-filter",
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    },
  });

  const response = await handler({
    rawPath: "/api/search",
    requestContext: { http: { method: "POST", path: "/api/search" } },
    body: JSON.stringify({
      queryText: "find audits",
      filters: {
        startTimestamp: "2025-01-01",
      },
    }),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(fetchCalled, false);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "INVALID_FILTER",
      message:
        "filters.startTimestamp must be an ISO 8601 timestamp with an explicit timezone, like 2025-01-01T00:00:00.000Z.",
    },
  });
});

test("POST /api/search rejects unsupported filter keys before downstream calls", async () => {
  let fetchCalled = false;
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-bad-filter-key",
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    },
  });

  const response = await handler({
    rawPath: "/api/search",
    requestContext: { http: { method: "POST", path: "/api/search" } },
    body: JSON.stringify({
      queryText: "find audits",
      filters: {
        incidentId: "case-123",
      },
    }),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(fetchCalled, false);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "INVALID_FILTER",
      message: "filters.incidentId is not supported.",
    },
  });
});

test("POST /api/search returns a controlled 500 when runtime secret resolution fails", async () => {
  const handler = createAppApiHandler({
    env: {
      TRACE_SEARCH_URL: "https://trace.example/search",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_API_KEY_SECRET_REF: "trace/openai-api-key",
      OPENAI_API_KEY_SECRET_JSON_KEY: "openaiApiKey",
    },
    requestIdFactory: () => "req-search-secret-failure",
    secretClient: {
      async send() {
        return {
          SecretString: "sk-plaintext",
        };
      },
    },
  });

  const response = await handler({
    rawPath: "/api/search",
    requestContext: { http: { method: "POST", path: "/api/search" } },
    body: JSON.stringify({
      queryText: "find audits",
    }),
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "INTERNAL",
      message: "Internal server error.",
    },
  });
});

test("POST /api/search returns shaped results with explanations", async () => {
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-search",
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      fetchCalls.push({ url, body });

      if (url === "https://api.openai.com/v1/embeddings") {
        return new Response(
          JSON.stringify({
            data: [{ embedding: new Array<number>(1536).fill(0.25) }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      if (url === "https://trace.example/search") {
        return new Response(
          JSON.stringify({
            ok: true,
            query_dim: 1536,
            k: 5,
            took_ms: 12,
            results: [
              {
                incident_id: "incident-1",
                timestamp: "2025-01-02T03:04:05Z",
                city_code: "NYC-TLC",
                doc_type: "Safety_Incident_Log",
                text_content:
                  "Safety team reviewed a route deviation incident and requested supporting narrative from the driver.",
                score: 0.12,
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const response = await handler({
    rawPath: "/api/search",
    requestContext: { http: { method: "POST", path: "/api/search" } },
    body: JSON.stringify({
      queryText: "safety incident reports in New York with supporting narrative",
      filters: {
        cityCode: "NYC-TLC",
        docType: "Safety_Incident_Log",
      },
    }),
  });

  assert.equal(response.statusCode, 200);

  const body = JSON.parse(response.body) as {
    queryText: string;
    appliedFilter: { sqlFilter: string; summary: string };
    results: Array<{ why_this_matched: string }>;
    meta: { tookMs: number; resultCount: number; queryMode: string };
  };

  assert.equal(body.queryText, "safety incident reports in New York with supporting narrative");
  assert.equal(
    body.appliedFilter.sqlFilter,
    "city_code = 'NYC-TLC' AND doc_type = 'Safety_Incident_Log'"
  );
  assert.equal(body.meta.tookMs, 12);
  assert.equal(body.meta.resultCount, 1);
  assert.equal(body.meta.queryMode, "live");
  assert.match(body.results[0].why_this_matched, /Search filters: city NYC-TLC, document type Safety_Incident_Log/);

  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(fetchCalls[1].body, {
    query_vector: new Array<number>(1536).fill(0.25),
    sql_filter: "city_code = 'NYC-TLC' AND doc_type = 'Safety_Incident_Log'",
    limit: 5,
    include_text: true,
  });
});
