import {
  FetchLike,
  OPENAI_MODEL_DIMENSIONS,
  envBool,
  fetchTimedOutError,
  fetchTimeoutMs,
  fetchWithTimeout,
  formatUpstreamHttpFailure,
  isAbortError,
} from "./common.js";

export type ResolvedEmbeddingConfig = {
  model: string;
  expectedVectorDim: number;
  useMockEmbeddings: boolean;
};

export function resolveDimForModelOrOverride(
  model: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  const overrideRaw = env.OVERRIDE_VECTOR_DIM?.trim();
  if (overrideRaw) {
    const parsed = Number.parseInt(overrideRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(
        "CRITICAL: OVERRIDE_VECTOR_DIM must be a positive integer when set."
      );
    }
    return parsed;
  }

  const dim = OPENAI_MODEL_DIMENSIONS[model];
  if (dim !== undefined) {
    return dim;
  }

  throw new Error(
    `CRITICAL: Unknown OPENAI_EMBEDDING_MODEL "${model}". Set OVERRIDE_VECTOR_DIM to the embedding size, or use a known model (text-embedding-3-small, text-embedding-ada-002, text-embedding-3-large).`
  );
}

export function resolveEmbeddingConfig(
  env: NodeJS.ProcessEnv = process.env
): ResolvedEmbeddingConfig {
  const model = (env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small").trim();
  if (!model) {
    throw new Error("CRITICAL: OPENAI_EMBEDDING_MODEL must not be empty when set.");
  }

  const expectedVectorDim = resolveDimForModelOrOverride(model, env);
  const traceVectorDimRaw = env.TRACE_QUERY_VECTOR_DIM?.trim();
  if (traceVectorDimRaw) {
    const parsed = Number.parseInt(traceVectorDimRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(
        "CRITICAL: TRACE_QUERY_VECTOR_DIM must be a positive integer when set."
      );
    }
    if (parsed !== expectedVectorDim) {
      throw new Error(
        `CRITICAL: TRACE_QUERY_VECTOR_DIM (${parsed}) must equal the resolved embedding dimension ${expectedVectorDim} for model "${model}". Set TRACE_QUERY_VECTOR_DIM=${expectedVectorDim} on the Lambda, or unset TRACE_QUERY_VECTOR_DIM here.`
      );
    }
  }

  return {
    model,
    expectedVectorDim,
    useMockEmbeddings: envBool("USE_MOCK_EMBEDDINGS", env),
  };
}

export function validateEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): void {
  const config = resolveEmbeddingConfig(env);
  if (config.useMockEmbeddings) {
    return;
  }
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("CRITICAL: OPENAI_API_KEY is required for embedding generation.");
  }
}

export async function embedText(
  text: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
    timeoutEnvName?: string;
  }
): Promise<number[]> {
  const env = options?.env ?? process.env;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const config = resolveEmbeddingConfig(env);

  if (config.useMockEmbeddings) {
    console.warn(
      "trace-mcp-bridge: USE_MOCK_EMBEDDINGS=true; using zero vector (testing only)"
    );
    return new Array<number>(config.expectedVectorDim).fill(0);
  }

  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("CRITICAL: OPENAI_API_KEY is required for embedding generation.");
  }

  const timeoutMs = fetchTimeoutMs(env, options?.timeoutEnvName);
  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
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
        env,
      })
    );
  }

  const body = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = body.data?.[0]?.embedding;
  const receivedDim = embedding?.length ?? 0;
  if (!embedding || receivedDim !== config.expectedVectorDim) {
    throw new Error(
      `Model ${config.model} returned ${receivedDim} dimensions, but ${config.expectedVectorDim} were expected.`
    );
  }

  return embedding;
}
