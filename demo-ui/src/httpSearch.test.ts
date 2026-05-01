import { describe, it, expect } from "vitest";
import { SearchApiError, shouldRetrySearchOnce } from "./httpSearch";

describe("shouldRetrySearchOnce", () => {
  it("returns true for timeouts, network flags, and HTTP 5xx SearchApiError", () => {
    expect(shouldRetrySearchOnce(new SearchApiError({ message: "timeout", isTimeout: true }))).toBe(
      true,
    );
    expect(
      shouldRetrySearchOnce(new SearchApiError({ message: "offline", isNetworkError: true })),
    ).toBe(true);
    expect(shouldRetrySearchOnce(new SearchApiError({ message: "bad", status: 503 }))).toBe(true);
  });

  it("returns false for HTTP 4xx SearchApiError", () => {
    expect(shouldRetrySearchOnce(new SearchApiError({ message: "nope", status: 404 }))).toBe(
      false,
    );
  });

  it("returns false for unknown errors", () => {
    expect(shouldRetrySearchOnce(new Error("something else"))).toBe(false);
  });
});
