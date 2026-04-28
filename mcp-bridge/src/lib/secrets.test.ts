import assert from "node:assert/strict";
import test from "node:test";

import {
  clearSecretCacheForTests,
  hydrateRuntimeSecrets,
  resolveSecretValue,
  type SecretClientLike,
} from "./secrets.js";

type SecretRequest = {
  secretId: string;
};

function mockSecretClient(
  lookup: Record<string, { SecretString?: string }>
): SecretClientLike & { requests: SecretRequest[] } {
  const requests: SecretRequest[] = [];
  return {
    requests,
    async send(command) {
      const input = command.input as { SecretId?: string };
      const secretId = input.SecretId ?? "";
      requests.push({ secretId });
      const secret = lookup[secretId];
      if (!secret) {
        throw new Error(`Unexpected secret request for ${secretId}`);
      }
      return secret;
    },
  };
}

test("resolveSecretValue returns a plaintext SecretString", async () => {
  clearSecretCacheForTests();
  const secretClient = mockSecretClient({
    "trace/openai-api-key": { SecretString: "sk-plaintext" },
  });

  const value = await resolveSecretValue("trace/openai-api-key", undefined, {
    secretClient,
  });

  assert.equal(value, "sk-plaintext");
  assert.deepEqual(secretClient.requests, [
    { secretId: "trace/openai-api-key" },
  ]);
});

test("resolveSecretValue extracts a JSON field when requested", async () => {
  clearSecretCacheForTests();
  const secretClient = mockSecretClient({
    "trace/api-key": {
      SecretString: JSON.stringify({ traceApiKey: "trace-secret" }),
    },
  });

  const value = await resolveSecretValue("trace/api-key", "traceApiKey", {
    secretClient,
  });

  assert.equal(value, "trace-secret");
});

test("resolveSecretValue caches repeat lookups for the same secret and key", async () => {
  clearSecretCacheForTests();
  const secretClient = mockSecretClient({
    "trace/openai-api-key": { SecretString: "sk-plaintext" },
  });

  const first = await resolveSecretValue("trace/openai-api-key", undefined, {
    secretClient,
  });
  const second = await resolveSecretValue("trace/openai-api-key", undefined, {
    secretClient,
  });

  assert.equal(first, "sk-plaintext");
  assert.equal(second, "sk-plaintext");
  assert.deepEqual(secretClient.requests, [
    { secretId: "trace/openai-api-key" },
  ]);
});

test("resolveSecretValue rejects invalid JSON when a json key is requested", async () => {
  clearSecretCacheForTests();
  const secretClient = mockSecretClient({
    "trace/api-key": {
      SecretString: "sk-plaintext",
    },
  });

  await assert.rejects(
    resolveSecretValue("trace/api-key", "traceApiKey", {
      secretClient,
    }),
    /must contain valid JSON to read key "traceApiKey"/
  );
});

test("resolveSecretValue rejects missing json keys", async () => {
  clearSecretCacheForTests();
  const secretClient = mockSecretClient({
    "trace/api-key": {
      SecretString: JSON.stringify({ anotherKey: "trace-secret" }),
    },
  });

  await assert.rejects(
    resolveSecretValue("trace/api-key", "traceApiKey", {
      secretClient,
    }),
    /missing a non-empty string at key "traceApiKey"/
  );
});

test("resolveSecretValue rejects secrets without SecretString", async () => {
  clearSecretCacheForTests();
  const secretClient = mockSecretClient({
    "trace/api-key": {},
  });

  await assert.rejects(
    resolveSecretValue("trace/api-key", undefined, {
      secretClient,
    }),
    /does not contain a SecretString value/
  );
});

test("hydrateRuntimeSecrets fills API keys from secret refs and preserves direct env values", async () => {
  clearSecretCacheForTests();
  const secretClient = mockSecretClient({
    "trace/openai-api-key": { SecretString: "sk-from-secret" },
    "trace/search-api-key": {
      SecretString: JSON.stringify({ traceApiKey: "trace-from-secret" }),
    },
  });

  const env = await hydrateRuntimeSecrets(
    {
      OPENAI_API_KEY_SECRET_REF: "trace/openai-api-key",
      OPENAI_API_KEY_SECRET_JSON_KEY: "__EMPTY__",
      TRACE_API_KEY_SECRET_REF: "trace/search-api-key",
      TRACE_API_KEY_SECRET_JSON_KEY: "traceApiKey",
      TRACE_SEARCH_URL: "https://trace.example/search",
    },
    { secretClient }
  );

  assert.equal(env.OPENAI_API_KEY, "sk-from-secret");
  assert.equal(env.TRACE_API_KEY, "trace-from-secret");
  assert.deepEqual(secretClient.requests, [
    { secretId: "trace/openai-api-key" },
    { secretId: "trace/search-api-key" },
  ]);
});
