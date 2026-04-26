import assert from "node:assert/strict";
import test from "node:test";

import { callSearch, callSearchHttp } from "./search-client.js";
import { SearchRequest } from "./search-types.js";

const request: SearchRequest = {
  query_vector: [0.1, 0.2, 0.3],
  sql_filter: "city_code = 'SF'",
  limit: 3,
  include_text: true,
};

const baseEnv = {
  TRACE_SEARCH_URL: "https://trace.example/search",
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
} satisfies NodeJS.ProcessEnv;

test("callSearch retries once on retriable network errors", async () => {
  let attempts = 0;

  const result = await callSearch(request, {
    env: baseEnv,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("temporary network failure");
      }

      return new Response(
        JSON.stringify({
          ok: true,
          query_dim: 3,
          k: 3,
          took_ms: 7,
          results: [],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    ok: true,
    query_dim: 3,
    k: 3,
    took_ms: 7,
    results: [],
    stub: undefined,
  });
});

test("callSearchHttp surfaces backend error envelopes with request metadata", async () => {
  await assert.rejects(
    () =>
      callSearchHttp("https://trace.example/search", request, 5_000, {
        env: baseEnv,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: {
                message: "Lambda search failed hard",
              },
            }),
            {
              status: 502,
              statusText: "Bad Gateway",
              headers: {
                "content-type": "application/json",
                "x-request-id": "req-search-123",
                "x-amzn-trace-id": "trace-abc",
              },
            }
          ),
      }),
    /Search backend error: Lambda search failed hard Request-Id: req-search-123\. Trace-Id: trace-abc\./
  );
});

test("callSearchHttp rejects malformed non-JSON backend responses", async () => {
  await assert.rejects(
    () =>
      callSearchHttp("https://trace.example/search", request, 5_000, {
        env: baseEnv,
        fetchImpl: async () =>
          new Response("<html>502 upstream exploded</html>", {
            status: 502,
            statusText: "Bad Gateway",
            headers: {
              "content-type": "text/html",
              "x-request-id": "req-search-html",
            },
          }),
      }),
    /Bridge Error: Received an invalid or malformed response from the search backend\. HTTP 502 Bad Gateway\. Request-Id: req-search-html\. Preview: <html>502 upstream exploded<\/html>/
  );
});
