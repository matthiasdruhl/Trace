import test from "node:test";
import assert from "node:assert/strict";

import { createAppApiHandler } from "./app-api.js";
import { APP_INTERPRET_SCOPE_QUERY_MAX_CHARS } from "./common.js";

const baseEnv = {
  TRACE_SEARCH_URL: "https://trace.example/search",
  OPENAI_API_KEY: "test-key",
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
} satisfies NodeJS.ProcessEnv;

function createResponsesApiJsonResponse(payload: unknown): Response {
  const serialized = JSON.stringify(payload);
  return new Response(
    JSON.stringify({
      id: "resp_step7",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: serialized,
            },
          ],
        },
      ],
      output_text: serialized,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

function createResponsesApiRefusalResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp_step7_refusal",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "refusal",
              refusal: message,
            },
          ],
        },
      ],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

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
  assert.deepEqual(
    body.cases.map((entry) => entry.id).sort(),
    ["narrow-slice-zero-results", "nyc-safety-incident", "overdue-inspection-audit"].sort()
  );
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
  const body = JSON.parse(response.body) as {
    ok: boolean;
    service: string;
    ready: boolean;
    checks: { traceSearchUrl: boolean; embeddingsConfigured: boolean };
    capabilities?: { scopeInterpretation?: boolean };
  };
  assert.equal(body.ok, true);
  assert.equal(body.service, "trace-app-api");
  assert.equal(body.ready, true);
  assert.equal(body.checks.traceSearchUrl, true);
  assert.equal(body.checks.embeddingsConfigured, true);
  assert.equal(body.capabilities?.scopeInterpretation, true);
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
  const body = JSON.parse(response.body) as {
    ok: boolean;
    service: string;
    ready: boolean;
    checks: { traceSearchUrl: boolean; embeddingsConfigured: boolean };
    capabilities?: { scopeInterpretation?: boolean };
  };
  assert.equal(body.ok, true);
  assert.equal(body.service, "trace-app-api");
  assert.equal(body.ready, true);
  assert.equal(body.checks.traceSearchUrl, true);
  assert.equal(body.checks.embeddingsConfigured, true);
  assert.equal(body.capabilities?.scopeInterpretation, true);
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
  const body = JSON.parse(response.body) as {
    ok: boolean;
    service: string;
    ready: boolean;
    checks: { traceSearchUrl: boolean; embeddingsConfigured: boolean };
    capabilities?: { scopeInterpretation?: boolean };
  };
  assert.equal(body.ok, false);
  assert.equal(body.service, "trace-app-api");
  assert.equal(body.ready, false);
  assert.equal(body.checks.traceSearchUrl, true);
  assert.equal(body.checks.embeddingsConfigured, false);
  assert.equal(body.capabilities?.scopeInterpretation, false);
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
    appliedFilter: {
      summary: string;
      filters?: { cityCode?: string; docType?: string };
    };
    results: Array<{
      why_this_matched: string;
      sourceRecordId: string;
      sourceCollection: string;
      sourceExcerpt: string;
      dataClassification: string;
      redactionStatus: string;
      provenanceSource: string;
      provenance: {
        usedFallback: boolean;
        fallbackFields: string[];
      };
    }>;
    meta: {
      tookMs: number;
      resultCount: number;
      queryMode: string;
      rankingStrategy: string;
      topLeadIncidentId?: string;
      datasetLabel: string;
      datasetKind: string;
      hasFallbackProvenance: boolean;
      handoffReadiness: string;
      confidenceReasoning: string[];
      resultQuality: {
        status: string;
        summary: string;
        suggestions: string[];
      };
    };
  };

  assert.equal(body.queryText, "safety incident reports in New York with supporting narrative");
  assert.equal(body.appliedFilter.summary, "Filtered by city NYC-TLC, document type Safety_Incident_Log.");
  assert.deepEqual(body.appliedFilter.filters, {
    cityCode: "NYC-TLC",
    docType: "Safety_Incident_Log",
  });
  assert.equal(body.meta.tookMs, 12);
  assert.equal(body.meta.resultCount, 1);
  assert.equal(body.meta.queryMode, "scoped_hybrid");
  assert.equal(body.meta.rankingStrategy, "score_desc");
  assert.equal(body.meta.topLeadIncidentId, "incident-1");
  assert.equal(body.meta.datasetLabel, "Trace Regulatory Demo Archive");
  assert.equal(body.meta.datasetKind, "regulatory_archive");
  assert.equal(body.meta.hasFallbackProvenance, true);
  assert.equal(body.meta.handoffReadiness, "review_only");
  assert.ok(
    body.meta.confidenceReasoning.some((entry) =>
      /temporary demo adapter/i.test(entry)
    )
  );
  assert.ok(
    body.meta.confidenceReasoning.some((entry) =>
      /explicitly flagged with fallback provenance fields/i.test(entry)
    )
  );
  assert.equal(body.meta.resultQuality.status, "review");
  assert.match(body.meta.resultQuality.summary, /keeping this run in review/i);
  assert.deepEqual(body.meta.resultQuality.suggestions, [
    "Review the lead manually and tighten the scope further if the excerpt does not clearly support the ask.",
    "Treat this as exploratory evidence rather than a final handoff.",
  ]);
  assert.match(body.results[0].why_this_matched, /Search filters: city NYC-TLC, document type Safety_Incident_Log/);
  assert.equal(body.results[0].sourceRecordId, "incident-1");
  assert.equal(body.results[0].sourceCollection, "trace-demo-regulatory-archive");
  assert.match(body.results[0].sourceExcerpt, /Safety team reviewed a route deviation incident/i);
  assert.equal(body.results[0].dataClassification, "unknown");
  assert.equal(body.results[0].redactionStatus, "unknown");
  assert.equal(body.results[0].provenanceSource, "synthesized");
  assert.deepEqual(body.results[0].provenance, {
    usedFallback: true,
    fallbackFields: [
      "sourceRecordId",
      "sourceCollection",
      "sourceExcerpt",
      "dataClassification",
      "redactionStatus",
    ],
  });

  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(fetchCalls[1].body, {
    query_vector: new Array<number>(1536).fill(0.25),
    sql_filter: "city_code = 'NYC-TLC' AND doc_type = 'Safety_Incident_Log'",
    limit: 5,
    include_text: true,
    columns: [
      "incident_id",
      "timestamp",
      "city_code",
      "doc_type",
      "text_content",
      "source_record_id",
      "source_collection",
      "source_excerpt",
      "data_classification",
      "redaction_status",
      "dataset_label",
      "dataset_kind",
    ],
  });
});

test("POST /api/search rejects invalid retrievalStrategy", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-invalid-strategy",
  });

  const response = await handler({
    rawPath: "/api/search",
    requestContext: { http: { method: "POST", path: "/api/search" } },
    body: JSON.stringify({
      queryText: "find audits",
      retrievalStrategy: "hybrid",
    }),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "INVALID_RETRIEVAL_STRATEGY",
      message: 'retrievalStrategy must be omitted or set to "semantic_only".',
    },
  });
});

test("POST /api/search honors retrievalStrategy semantic_only for explicit open-scope retrieval", async () => {
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-search-semantic",
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      fetchCalls.push({ url, body });

      if (url === "https://api.openai.com/v1/embeddings") {
        return new Response(
          JSON.stringify({
            data: [{ embedding: new Array<number>(1536).fill(0.33) }],
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
            took_ms: 8,
            results: [],
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
      queryText: "insurance lapse",
      filters: {
        cityCode: "NYC-TLC",
        docType: "Safety_Incident_Log",
      },
      retrievalStrategy: "semantic_only",
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as { meta: { queryMode: string }; appliedFilter: { summary: string } };
  assert.equal(body.meta.queryMode, "semantic_only");
  assert.equal(body.appliedFilter.summary, "No metadata filters applied.");
  assert.deepEqual(fetchCalls[1].body, {
    query_vector: new Array<number>(1536).fill(0.33),
    sql_filter: "",
    limit: 5,
    include_text: true,
    columns: [
      "incident_id",
      "timestamp",
      "city_code",
      "doc_type",
      "text_content",
      "source_record_id",
      "source_collection",
      "source_excerpt",
      "data_classification",
      "redaction_status",
      "dataset_label",
      "dataset_kind",
    ],
  });
});

test("POST /api/search preserves backend provenance when trust fields are present", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-search-provenance",
    fetchImpl: async (input) => {
      const url = String(input);

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
            took_ms: 9,
            results: [
              {
                incident_id: "incident-2",
                timestamp: "2025-01-05T08:00:00Z",
                city_code: "NYC-TLC",
                doc_type: "Safety_Incident_Log",
                text_content: "Driver narrative retained for review.",
                score: 0.91,
                source_record_id: "record-4471",
                source_collection: "nyc_tlc_incident_log",
                source_excerpt: "Driver narrative retained for review with witness follow-up.",
                data_classification: "confidential",
                redaction_status: "partial",
                dataset_label: "NYC TLC Incident Archive",
                dataset_kind: "regulatory_archive",
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
    results: Array<{
      sourceRecordId: string;
      sourceCollection: string;
      sourceExcerpt: string;
      dataClassification: string;
      redactionStatus: string;
      provenanceSource: string;
      provenance: {
        usedFallback: boolean;
        fallbackFields: string[];
      };
    }>;
    meta: {
      datasetLabel: string;
      datasetKind: string;
      hasFallbackProvenance: boolean;
      handoffReadiness: string;
      confidenceReasoning: string[];
      resultQuality: { status: string };
    };
  };

  assert.equal(body.results[0].sourceRecordId, "record-4471");
  assert.equal(body.results[0].sourceCollection, "nyc_tlc_incident_log");
  assert.equal(
    body.results[0].sourceExcerpt,
    "Driver narrative retained for review with witness follow-up."
  );
  assert.equal(body.results[0].dataClassification, "confidential");
  assert.equal(body.results[0].redactionStatus, "partial");
  assert.equal(body.results[0].provenanceSource, "backend");
  assert.deepEqual(body.results[0].provenance, {
    usedFallback: false,
    fallbackFields: [],
  });
  assert.equal(body.meta.datasetLabel, "NYC TLC Incident Archive");
  assert.equal(body.meta.datasetKind, "regulatory_archive");
  assert.equal(body.meta.hasFallbackProvenance, false);
  assert.equal(body.meta.handoffReadiness, "review_only");
  assert.equal(body.meta.resultQuality.status, "strong");
  assert.ok(
    body.meta.confidenceReasoning.some((entry) =>
      /withholding handoff readiness/i.test(entry)
    )
  );
});

test("POST /api/search reaches ready when full-scope trusted metadata is present", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-search-ready",
    fetchImpl: async (input) => {
      const url = String(input);

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
            took_ms: 9,
            results: [
              {
                incident_id: "incident-ready-1",
                timestamp: "2025-01-05T08:00:00Z",
                city_code: "NYC-TLC",
                doc_type: "Safety_Incident_Log",
                text_content:
                  "Safety team reviewed a route deviation incident and retained the supporting narrative for audit follow-up.",
                score: 0.91,
                source_record_id: "record-ready-1",
                source_collection: "nyc_tlc_incident_log",
                source_excerpt:
                  "Safety team reviewed a route deviation incident and retained the supporting narrative for audit follow-up.",
                data_classification: "internal",
                redaction_status: "none",
                dataset_label: "NYC TLC Incident Archive",
                dataset_kind: "regulatory_archive",
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
    meta: {
      hasFallbackProvenance: boolean;
      handoffReadiness: string;
      confidenceReasoning: string[];
      resultQuality: { status: string };
    };
  };

  assert.equal(body.meta.hasFallbackProvenance, false);
  assert.equal(body.meta.resultQuality.status, "strong");
  assert.equal(body.meta.handoffReadiness, "ready");
  assert.ok(
    body.meta.confidenceReasoning.some((entry) =>
      /ready for workflow handoff/i.test(entry)
    )
  );
});

test("POST /api/search keeps demo-seeded metadata in review even when explicit trust fields are present", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-search-demo-seeded-review",
    fetchImpl: async (input) => {
      const url = String(input);

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
            took_ms: 9,
            results: [
              {
                incident_id: "incident-demo-seeded-1",
                timestamp: "2025-01-05T08:00:00Z",
                city_code: "NYC-TLC",
                doc_type: "Safety_Incident_Log",
                text_content:
                  "Safety team reviewed a route deviation incident and retained the supporting narrative for audit follow-up.",
                score: 0.91,
                source_record_id: "incident-demo-seeded-1",
                source_collection: "trace-demo-regulatory-archive",
                source_excerpt:
                  "Safety team reviewed a route deviation incident and retained the supporting narrative for audit follow-up.",
                data_classification: "internal",
                redaction_status: "none",
                dataset_label: "Trace Regulatory Demo Archive",
                dataset_kind: "regulatory_archive",
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
    meta: {
      hasFallbackProvenance: boolean;
      handoffReadiness: string;
      confidenceReasoning: string[];
      resultQuality: { status: string };
    };
  };

  assert.equal(body.meta.hasFallbackProvenance, false);
  assert.equal(body.meta.resultQuality.status, "strong");
  assert.equal(body.meta.handoffReadiness, "review_only");
  assert.ok(
    body.meta.confidenceReasoning.some((entry) =>
      /demo-seeded archive labels/i.test(entry)
    )
  );
});

test("POST /api/search keeps partially scoped runs in review instead of auto-promoting them to strong", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-search-partial-scope",
    fetchImpl: async (input) => {
      const url = String(input);

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
            took_ms: 11,
            results: [
              {
                incident_id: "incident-3",
                timestamp: "2025-01-06T10:00:00Z",
                city_code: "NYC-TLC",
                doc_type: "Safety_Incident_Log",
                text_content:
                  "Safety incident review notes reference the requested narrative.",
                score: 0.88,
                source_record_id: "record-88",
                source_collection: "nyc_tlc_incident_log",
                source_excerpt:
                  "Safety incident review notes reference the requested narrative.",
                data_classification: "internal",
                redaction_status: "none",
                dataset_label: "NYC TLC Incident Archive",
                dataset_kind: "regulatory_archive",
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
      },
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    meta: {
      handoffReadiness: string;
      confidenceReasoning: string[];
      resultQuality: { status: string; summary: string };
    };
  };

  assert.equal(body.meta.resultQuality.status, "review");
  assert.match(body.meta.resultQuality.summary, /keeping this run in review/i);
  assert.equal(body.meta.handoffReadiness, "review_only");
  assert.ok(
    body.meta.confidenceReasoning.some((entry) =>
      /withholding handoff readiness/i.test(entry)
    )
  );
});

test("POST /api/search treats zero-result runs as no-material and not trustworthy for handoff", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-search-zero-results",
    fetchImpl: async (input) => {
      const url = String(input);

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
            took_ms: 7,
            results: [],
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
    results: unknown[];
    meta: {
      resultCount: number;
      handoffReadiness: string;
      confidenceReasoning: string[];
      resultQuality: { status: string; summary: string };
    };
  };

  assert.deepEqual(body.results, []);
  assert.equal(body.meta.resultCount, 0);
  assert.equal(body.meta.resultQuality.status, "low_confidence");
  assert.match(body.meta.resultQuality.summary, /produced no material/i);
  assert.equal(body.meta.handoffReadiness, "not_trustworthy");
  assert.ok(
    body.meta.confidenceReasoning.some((entry) =>
      /no evidence material/i.test(entry)
    )
  );
});

test("GET /api/health reports scope interpretation capability when configured", async () => {
  const handler = createAppApiHandler({
    env: {
      ...baseEnv,
      OPENAI_SCOPE_INTERPRET_MODEL: "gpt-4.1-mini",
    },
    requestIdFactory: () => "req-health-scope-capability",
  });

  const response = await handler({
    rawPath: "/api/health",
    requestContext: { http: { method: "GET", path: "/api/health" } },
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    capabilities?: { scopeInterpretation?: boolean };
  };
  assert.equal(body.capabilities?.scopeInterpretation, true);
});

test("POST /api/interpret-scope degrades to a 200 fallback when runtime secret resolution fails", async () => {
  const handler = createAppApiHandler({
    env: {
      TRACE_SEARCH_URL: "https://trace.example/search",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_SCOPE_INTERPRET_MODEL: "gpt-4.1-mini",
      OPENAI_API_KEY_SECRET_REF: "trace/openai-api-key",
      OPENAI_API_KEY_SECRET_JSON_KEY: "openaiApiKey",
    },
    requestIdFactory: () => "req-interpret-secret-failure",
    secretClient: {
      async send() {
        return {
          SecretString: "sk-plaintext",
        };
      },
    },
  });

  const response = await handler({
    rawPath: "/api/interpret-scope",
    requestContext: { http: { method: "POST", path: "/api/interpret-scope" } },
    body: JSON.stringify({
      queryText: "Chicago insurance lapse cases in March 2026",
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    suggestedFilters: Record<string, unknown>;
    warnings: string[];
  };
  assert.deepEqual(body.suggestedFilters, {});
  assert.ok(body.warnings.length > 0, "expected at least one warning when key is unavailable");
});

test("POST /api/interpret-scope returns a suggestion for Chicago insurance lapse cases in March 2026", async () => {
  const fetchCalls: string[] = [];
  const handler = createAppApiHandler({
    env: {
      ...baseEnv,
      OPENAI_SCOPE_INTERPRET_MODEL: "gpt-4.1-mini",
    },
    requestIdFactory: () => "req-interpret-success",
    fetchImpl: async (input) => {
      const url = String(input);
      fetchCalls.push(url);

      if (
        url === "https://api.openai.com/v1/responses" ||
        url === "https://api.openai.com/v1/chat/completions"
      ) {
        return createResponsesApiJsonResponse({
          queryText: "Chicago insurance lapse cases in March 2026",
          suggestedFilters: {
            cityCode: "CHI-BACP",
            docType: "Insurance_Lapse_Report",
            startDate: "2026-03-01",
            endDate: "2026-03-31",
          },
          summary: "Chicago insurance lapse cases narrowed to March 2026.",
          appliedSignals: [
            {
              field: "cityCode",
              sourceText: "Chicago",
              normalizedValue: "CHI-BACP",
              rationale: "Mapped the city reference to the canonical Trace city code.",
            },
            {
              field: "docType",
              sourceText: "insurance lapse",
              normalizedValue: "Insurance_Lapse_Report",
              rationale: "Matched the document phrase to the supported document taxonomy.",
            },
            {
              field: "startDate",
              sourceText: "March 2026",
              normalizedValue: "2026-03-01",
              rationale: "Expanded the month reference to its first day.",
            },
            {
              field: "endDate",
              sourceText: "March 2026",
              normalizedValue: "2026-03-31",
              rationale: "Expanded the month reference to its last day.",
            },
          ],
          unresolvedSignals: [],
          warnings: [],
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const response = await handler({
    rawPath: "/api/interpret-scope",
    requestContext: { http: { method: "POST", path: "/api/interpret-scope" } },
    body: JSON.stringify({
      queryText: "Chicago insurance lapse cases in March 2026",
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    queryText: string;
    suggestedFilters: Record<string, string | undefined>;
    summary: string;
    appliedSignals: Array<{ field: string }>;
    unresolvedSignals: string[];
    warnings: string[];
  };
  assert.equal(body.queryText, "Chicago insurance lapse cases in March 2026");
  assert.deepEqual(body.suggestedFilters, {
    cityCode: "CHI-BACP",
    docType: "Insurance_Lapse_Report",
    startDate: "2026-03-01",
    endDate: "2026-03-31",
  });
  assert.match(body.summary, /Chicago/i);
  assert.deepEqual(
    body.appliedSignals.map((signal) => signal.field),
    ["cityCode", "docType", "startDate", "endDate"]
  );
  assert.deepEqual(body.unresolvedSignals, []);
  assert.deepEqual(body.warnings, []);
  assert.equal(fetchCalls.length, 1);
});

test("POST /api/interpret-scope returns unresolved signals when no safe scope can be extracted", async () => {
  const handler = createAppApiHandler({
    env: {
      ...baseEnv,
      OPENAI_SCOPE_INTERPRET_MODEL: "gpt-4.1-mini",
    },
    requestIdFactory: () => "req-interpret-ambiguous",
    fetchImpl: async (input) => {
      const url = String(input);
      if (
        url === "https://api.openai.com/v1/responses" ||
        url === "https://api.openai.com/v1/chat/completions"
      ) {
        return createResponsesApiJsonResponse({
          queryText: "Find fraud concerns",
          suggestedFilters: {},
          summary: "No safe structured scope could be extracted.",
          appliedSignals: [],
          unresolvedSignals: ["fraud concerns"],
          warnings: [],
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const response = await handler({
    rawPath: "/api/interpret-scope",
    requestContext: { http: { method: "POST", path: "/api/interpret-scope" } },
    body: JSON.stringify({
      queryText: "Find fraud concerns",
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    suggestedFilters: Record<string, string | undefined>;
    unresolvedSignals: string[];
    warnings: string[];
  };
  assert.deepEqual(body.suggestedFilters, {});
  assert.deepEqual(body.warnings, []);
  assert.deepEqual(body.unresolvedSignals, ["fraud concerns"]);
});

test("POST /api/interpret-scope sanitizes invalid model output into warnings instead of applying unsafe filters", async () => {
  const handler = createAppApiHandler({
    env: {
      ...baseEnv,
      OPENAI_SCOPE_INTERPRET_MODEL: "gpt-4.1-mini",
    },
    requestIdFactory: () => "req-interpret-invalid-output",
    fetchImpl: async (input) => {
      const url = String(input);
      if (
        url === "https://api.openai.com/v1/responses" ||
        url === "https://api.openai.com/v1/chat/completions"
      ) {
        return createResponsesApiJsonResponse({
          queryText: "Show New York safety incidents from April 2026",
          suggestedFilters: {
            cityCode: "NYC-TLC",
            docType: "Unsupported_Report",
            startDate: "2026-04-30",
            endDate: "2026-04-01",
          },
          summary: "Unsafe scope suggestion.",
          appliedSignals: [
            {
              field: "cityCode",
              sourceText: "New York",
              normalizedValue: "NYC-TLC",
              rationale: "Mapped the city phrase.",
            },
            {
              field: "docType",
              sourceText: "safety incidents",
              normalizedValue: "Unsupported_Report",
              rationale: "Incorrectly mapped the document phrase.",
            },
          ],
          unresolvedSignals: [],
          warnings: [],
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const response = await handler({
    rawPath: "/api/interpret-scope",
    requestContext: { http: { method: "POST", path: "/api/interpret-scope" } },
    body: JSON.stringify({
      queryText: "Show New York safety incidents from April 2026",
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    suggestedFilters: Record<string, string | undefined>;
    warnings: string[];
  };
  assert.deepEqual(body.suggestedFilters, {});
  assert.ok(body.warnings.length > 0);
});

test("POST /api/interpret-scope returns a controlled fallback when the model refuses the request", async () => {
  const handler = createAppApiHandler({
    env: {
      ...baseEnv,
      OPENAI_SCOPE_INTERPRET_MODEL: "gpt-4.1-mini",
    },
    requestIdFactory: () => "req-interpret-refusal",
    fetchImpl: async (input) => {
      const url = String(input);
      if (
        url === "https://api.openai.com/v1/responses" ||
        url === "https://api.openai.com/v1/chat/completions"
      ) {
        return createResponsesApiRefusalResponse(
          "I can't safely derive structured filters from that request."
        );
      }

      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const response = await handler({
    rawPath: "/api/interpret-scope",
    requestContext: { http: { method: "POST", path: "/api/interpret-scope" } },
    body: JSON.stringify({
      queryText: "Show me whatever seems suspicious",
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    suggestedFilters: Record<string, string | undefined>;
    warnings: string[];
  };
  assert.deepEqual(body.suggestedFilters, {});
  assert.deepEqual(body.warnings, [
    "Scope interpretation did not return a safe suggestion for this request.",
  ]);
});

test("POST /api/interpret-scope returns a controlled fallback on upstream failure", async () => {
  const handler = createAppApiHandler({
    env: {
      ...baseEnv,
      OPENAI_SCOPE_INTERPRET_MODEL: "gpt-4.1-mini",
    },
    requestIdFactory: () => "req-interpret-upstream-failure",
    fetchImpl: async () =>
      new Response("temporarily overloaded", {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "x-request-id": "req-openai-scope-429",
        },
      }),
  });

  const response = await handler({
    rawPath: "/api/interpret-scope",
    requestContext: { http: { method: "POST", path: "/api/interpret-scope" } },
    body: JSON.stringify({
      queryText: "Chicago insurance lapse cases in March 2026",
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    suggestedFilters: Record<string, string | undefined>;
    warnings: string[];
  };
  assert.deepEqual(body.suggestedFilters, {});
  assert.deepEqual(body.warnings, [
    "Scope interpretation is temporarily unavailable. You can still set filters manually.",
  ]);
});

test("POST /api/interpret-scope returns a controlled fallback when the scope model setting is empty", async () => {
  const handler = createAppApiHandler({
    env: {
      ...baseEnv,
      OPENAI_SCOPE_INTERPRET_MODEL: "   ",
    },
    requestIdFactory: () => "req-interpret-empty-model",
  });

  const response = await handler({
    rawPath: "/api/interpret-scope",
    requestContext: { http: { method: "POST", path: "/api/interpret-scope" } },
    body: JSON.stringify({
      queryText: "Chicago insurance lapse cases in March 2026",
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    suggestedFilters: Record<string, unknown>;
    warnings: string[];
  };
  assert.deepEqual(body.suggestedFilters, {});
  assert.deepEqual(body.warnings, [
    "Scope interpretation is unavailable due to invalid model configuration. You can still set filters manually.",
  ]);
});

test("POST /api/interpret-scope rejects unsupported request body fields", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-interpret-extra-field",
  });

  const response = await handler({
    rawPath: "/api/interpret-scope",
    requestContext: { http: { method: "POST", path: "/api/interpret-scope" } },
    body: JSON.stringify({
      queryText: "Chicago insurance lapse cases",
      filters: {
        cityCode: "CHI-BACP",
      },
    }),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "INVALID_REQUEST",
      message: "body.filters is not supported.",
    },
  });
});

test("POST /api/search returns low_confidence for unsupported city Boston", async () => {
  // Mirrors UNSUPPORTED_DEMO_CITY_RULES in mcp-bridge/src/shared/demo-unsupported-cities.ts
  // (client guardrails import the same module via compileUnsupportedDemoCityRules).
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-boston-guardrail",
    fetchImpl: async (input) => {
      const url = String(input);

      if (url === "https://api.openai.com/v1/embeddings") {
        return new Response(
          JSON.stringify({
            data: [{ embedding: new Array<number>(1536).fill(0.1) }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url === "https://trace.example/search") {
        return new Response(
          JSON.stringify({
            ok: true,
            query_dim: 1536,
            k: 5,
            took_ms: 8,
            results: [
              {
                incident_id: "incident-boston-1",
                timestamp: "2025-03-01T10:00:00Z",
                city_code: "NYC-TLC",
                doc_type: "Safety_Incident_Log",
                text_content: "A safety incident was logged.",
                score: 0.7,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const response = await handler({
    rawPath: "/api/search",
    requestContext: { http: { method: "POST", path: "/api/search" } },
    body: JSON.stringify({
      queryText: "safety incident reports in Boston last quarter",
    }),
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as {
    meta: { resultQuality: { status: string; summary: string } };
  };
  assert.equal(body.meta.resultQuality.status, "low_confidence");
  assert.match(body.meta.resultQuality.summary, /boston/i);
});

test("POST /api/interpret-scope rejects queryText exceeding max length", async () => {
  const handler = createAppApiHandler({
    env: baseEnv,
    requestIdFactory: () => "req-interpret-too-long",
  });

  const longQuery = "x".repeat(APP_INTERPRET_SCOPE_QUERY_MAX_CHARS + 1);

  const response = await handler({
    rawPath: "/api/interpret-scope",
    requestContext: { http: { method: "POST", path: "/api/interpret-scope" } },
    body: JSON.stringify({
      queryText: longQuery,
    }),
  });

  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "INVALID_QUERY");
  assert.match(body.error.message, /8192/);
});
