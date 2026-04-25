import assert from "node:assert/strict";
import test from "node:test";

import { embedText } from "./embeddings.js";

const baseEnv = {
  OPENAI_API_KEY: "test-key",
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
} satisfies NodeJS.ProcessEnv;

test("embedText formats upstream OpenAI HTTP failures with request ids", async () => {
  await assert.rejects(
    () =>
      embedText("find archived reports", {
        env: baseEnv,
        fetchImpl: async () =>
          new Response("rate limited by upstream", {
            status: 429,
            statusText: "Too Many Requests",
            headers: {
              "x-request-id": "req-openai-123",
            },
          }),
      }),
    /OpenAI embeddings failed: HTTP 429 Too Many Requests\. Request-Id: req-openai-123\. Response preview: rate limited by upstream/
  );
});

test("embedText rejects embeddings with the wrong dimension", async () => {
  await assert.rejects(
    () =>
      embedText("find archived reports", {
        env: baseEnv,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.2, 0.3] }],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            }
          ),
      }),
    /Model text-embedding-3-small returned 3 dimensions, but 1536 were expected\./
  );
});
