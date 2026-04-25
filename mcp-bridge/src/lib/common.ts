import { randomUUID } from "node:crypto";

export const OPENAI_MODEL_DIMENSIONS: Readonly<Record<string, number>> = {
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
  "text-embedding-3-large": 3072,
};

export const MCP_LIMIT_MIN = 1;
export const MCP_LIMIT_MAX = 50;
export const MCP_DEFAULT_LIMIT = 10;
export const APP_DEFAULT_LIMIT = 5;
export const APP_LIMIT_MAX = 10;
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const SAFE_BODY_PREVIEW_CHARS = 200;
export const FATAL_ERROR_MESSAGE_CHARS = 320;

export type FetchLike = typeof fetch;

export class HttpError extends Error {
  status: number;
  code: string;
  expose: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { expose?: boolean }
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.expose = options?.expose ?? true;
  }
}

export function envBool(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[name];
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function logVerboseErrors(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOG_VERBOSE_ERRORS === "true";
}

export function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  return value.slice(0, maxLen);
}

export function normalizeForPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function safePreview(value: string, maxLen: number = SAFE_BODY_PREVIEW_CHARS): string {
  return truncate(normalizeForPreview(value), maxLen);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fetchTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  envName = "MCP_FETCH_TIMEOUT_MS"
): number {
  const raw = env[envName]?.trim();
  if (!raw) {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  return parsed;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  return false;
}

export function isRetriableNetworkError(err: unknown): boolean {
  if (isAbortError(err)) {
    return false;
  }
  return err instanceof TypeError;
}

export function fetchTimedOutError(timeoutMs: number): Error {
  return new Error(
    `Request timed out after ${timeoutMs}ms. The downstream service is unresponsive.`
  );
}

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function requestIdFromResponse(res: Response): string | undefined {
  return (
    res.headers.get("x-request-id") ??
    res.headers.get("x-openai-request-id") ??
    res.headers.get("apigw-requestid") ??
    res.headers.get("x-amzn-requestid") ??
    res.headers.get("cf-ray") ??
    undefined
  );
}

export function traceIdFromResponse(res: Response): string | undefined {
  return res.headers.get("x-amzn-trace-id") ?? undefined;
}

export function logBackendError(payload: Record<string, unknown>): void {
  console.error("[Backend Error]", JSON.stringify(payload));
}

export function safeBackendDiagnostics(input: {
  kind: string;
  label?: string;
  res: Response;
  bodyText: string;
  backendMessage?: string;
  env?: NodeJS.ProcessEnv;
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
  if (logVerboseErrors(input.env)) {
    const contentType = input.res.headers.get("content-type");
    if (contentType) {
      payload.contentType = contentType;
    }
  }
  logBackendError(payload);
}

export function mcpDebugSuffix(
  res: Response,
  bodyCharLength: number,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!envBool("MCP_DEBUG", env)) {
    return "";
  }
  const parts = [`bodyChars=${bodyCharLength}`];
  const contentType = res.headers.get("content-type");
  if (contentType) {
    parts.push(`contentType=${contentType}`);
  }
  return ` [debug: ${parts.join(", ")}]`;
}

export function formatUpstreamHttpFailure(options: {
  label: string;
  res: Response;
  bodyText: string;
  env?: NodeJS.ProcessEnv;
}): string {
  safeBackendDiagnostics({
    kind: "upstream_http",
    label: options.label,
    res: options.res,
    bodyText: options.bodyText,
    env: options.env,
  });

  const requestId = requestIdFromResponse(options.res);
  const traceId = traceIdFromResponse(options.res);
  const preview = safePreview(options.bodyText);
  let message = `${options.label}: HTTP ${options.res.status} ${options.res.statusText || ""}.`;
  if (requestId) {
    message += ` Request-Id: ${requestId}.`;
  }
  if (traceId) {
    message += ` Trace-Id: ${traceId}.`;
  }
  message += ` Response preview: ${preview}`;
  message += mcpDebugSuffix(options.res, options.bodyText.length, options.env);
  return message;
}

export function generateRequestId(): string {
  return randomUUID();
}
