/** Shared search HTTP behavior: timeouts, error typing, retry classification. */

export const SEARCH_HTTP_TIMEOUT_MS = 55_000;
export const SCOPE_INTERPRETATION_HTTP_TIMEOUT_MS = 12_000;

export type SearchApiErrorInit = {
  message: string;
  status?: number;
  isTimeout?: boolean;
  isNetworkError?: boolean;
};

export class SearchApiError extends Error {
  readonly status?: number;
  readonly isTimeout: boolean;
  readonly isNetworkError: boolean;

  constructor(init: SearchApiErrorInit) {
    super(init.message);
    this.name = "SearchApiError";
    this.status = init.status;
    this.isTimeout = init.isTimeout ?? false;
    this.isNetworkError = init.isNetworkError ?? false;
  }
}

export function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

/** True when error likely came from our deadline rather than user navigation. */
export function isLikelyDeadlineAbort(error: unknown): boolean {
  if (!isAbortLikeError(error) || !(error instanceof Error)) {
    return false;
  }
  return /abort|timed out|timeout/i.test(error.message);
}

export function shouldRetrySearchOnce(error: unknown): boolean {
  if (error instanceof SearchApiError) {
    if (error.isTimeout) {
      return true;
    }
    if (error.isNetworkError) {
      return true;
    }
    const st = error.status;
    if (st !== undefined && st >= 500 && st <= 599) {
      return true;
    }
    return false;
  }
  return false;
}

export function combineAbortSignals(
  outer: AbortSignal | undefined,
  inner: AbortSignal,
): AbortSignal {
  if (!outer) {
    return inner;
  }
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (outer.aborted || inner.aborted) {
    forward();
    return controller.signal;
  }
  outer.addEventListener("abort", forward, { once: true });
  inner.addEventListener("abort", forward, { once: true });
  return controller.signal;
}

export function createDeadlineSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const id = window.setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${ms} ms`, "TimeoutError"));
  }, ms);
  controller.signal.addEventListener(
    "abort",
    () => {
      window.clearTimeout(id);
    },
    { once: true },
  );
  return controller.signal;
}

export function createDeadlineController(ms: number): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  const id = window.setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${ms} ms`, "TimeoutError"));
  }, ms);
  const cancel = () => {
    window.clearTimeout(id);
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  return {
    signal: controller.signal,
    cancel,
  };
}
