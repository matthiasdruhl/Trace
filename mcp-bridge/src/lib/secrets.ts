import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const EMPTY_PARAMETER_SENTINEL = "__EMPTY__";

const secretCache = new Map<string, Promise<string>>();

const RUNTIME_SECRET_SPECS = [
  {
    targetEnv: "OPENAI_API_KEY",
    refEnv: "OPENAI_API_KEY_SECRET_REF",
    jsonKeyEnv: "OPENAI_API_KEY_SECRET_JSON_KEY",
  },
  {
    targetEnv: "TRACE_API_KEY",
    refEnv: "TRACE_API_KEY_SECRET_REF",
    jsonKeyEnv: "TRACE_API_KEY_SECRET_JSON_KEY",
  },
] as const;

export type SecretClientLike = {
  send(command: GetSecretValueCommand): Promise<{
    SecretString?: string;
  }>;
};

function normalizeOptionalSetting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === EMPTY_PARAMETER_SENTINEL) {
    return undefined;
  }
  return trimmed;
}

function requireSecretString(
  secretRef: string,
  response: {
    SecretString?: string;
  }
): string {
  if (typeof response.SecretString === "string") {
    return response.SecretString;
  }

  throw new Error(
    `CRITICAL: Secret ${secretRef} does not contain a SecretString value.`
  );
}

function extractJsonSecretValue(
  secretRef: string,
  secretString: string,
  jsonKey: string
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString) as unknown;
  } catch {
    throw new Error(
      `CRITICAL: Secret ${secretRef} must contain valid JSON to read key "${jsonKey}".`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `CRITICAL: Secret ${secretRef} must be a JSON object to read key "${jsonKey}".`
    );
  }

  const value = (parsed as Record<string, unknown>)[jsonKey];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `CRITICAL: Secret ${secretRef} is missing a non-empty string at key "${jsonKey}".`
    );
  }

  return value;
}

export async function resolveSecretValue(
  secretRef: string,
  jsonKey?: string,
  options?: {
    secretClient?: SecretClientLike;
  }
): Promise<string> {
  const normalizedSecretRef = normalizeOptionalSetting(secretRef);
  if (!normalizedSecretRef) {
    throw new Error("CRITICAL: Secret reference must not be empty.");
  }

  const normalizedJsonKey = normalizeOptionalSetting(jsonKey);
  const cacheKey = `${normalizedSecretRef}\n${normalizedJsonKey ?? ""}`;
  const cached = secretCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const secretClient = options?.secretClient ?? new SecretsManagerClient({});
  const pending = (async () => {
    const response = await secretClient.send(
      new GetSecretValueCommand({
        SecretId: normalizedSecretRef,
      })
    );
    const secretString = requireSecretString(normalizedSecretRef, response);
    if (normalizedJsonKey) {
      return extractJsonSecretValue(
        normalizedSecretRef,
        secretString,
        normalizedJsonKey
      );
    }
    return secretString;
  })();

  secretCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    secretCache.delete(cacheKey);
    throw error;
  }
}

export async function hydrateRuntimeSecrets(
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    secretClient?: SecretClientLike;
  }
): Promise<NodeJS.ProcessEnv> {
  let resolvedEnv: NodeJS.ProcessEnv | undefined;

  for (const spec of RUNTIME_SECRET_SPECS) {
    const currentValue = normalizeOptionalSetting(env[spec.targetEnv]);
    if (currentValue) {
      continue;
    }

    const secretRef = normalizeOptionalSetting(env[spec.refEnv]);
    if (!secretRef) {
      continue;
    }

    const secretValue = await resolveSecretValue(secretRef, env[spec.jsonKeyEnv], {
      secretClient: options?.secretClient,
    });

    if (!resolvedEnv) {
      resolvedEnv = { ...env };
    }
    resolvedEnv[spec.targetEnv] = secretValue;
  }

  return resolvedEnv ?? env;
}

export function clearSecretCacheForTests(): void {
  secretCache.clear();
}
