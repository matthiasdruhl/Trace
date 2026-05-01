import { describe, expect, it } from "vitest";

import {
  chooseSummaryForClientDisplay,
  isScopeInterpretationUnavailableMessage,
  toUserFacingScopeInterpretationError,
} from "./scopeInterpretGuards";

describe("chooseSummaryForClientDisplay", () => {
  it("prefers baseline over optimistic model wording when sanitization dropped all structured filters", () => {
    const summary = chooseSummaryForClientDisplay(
      "Chicago insurance lapse narrowed to definitive Trace regulators.",
      {},
      [],
      { droppedMalformedFields: true, invalidDateRangeDropped: false },
    );
    expect(summary).not.toContain("Chicago insurance lapse narrowed");
    expect(summary).toMatch(/no safe scope suggestion/i);
  });

  it("still surfaces a sanitized model summary when at least one filter survived client validation", () => {
    const summary = chooseSummaryForClientDisplay(
      "NYC-focused safety regulator slice.",
      { cityCode: "NYC-TLC", docType: "", startDate: "", endDate: "" },
      [],
      { droppedMalformedFields: true, invalidDateRangeDropped: false },
    );
    expect(summary).toContain("NYC-focused");
  });

  it("falls back to the baseline summary when modelSummaryRaw is not a string", () => {
    const summary = chooseSummaryForClientDisplay(
      { nested: "object" },
      { cityCode: "NYC-TLC" },
      [],
    );
    expect(summary).not.toContain("[object");
    expect(summary).toMatch(/suggested scope/i);
  });
});

describe("toUserFacingScopeInterpretationError", () => {
  it("turns a raw Not Found response into an unavailable message", () => {
    expect(toUserFacingScopeInterpretationError("Not Found", 404)).toMatch(
      /scope interpretation is unavailable/i,
    );
  });

  it("returns a generic product message for other failures", () => {
    expect(toUserFacingScopeInterpretationError("socket hang up", 500)).toMatch(
      /could not interpret the scope right now/i,
    );
  });

  it("flags the standardized unavailable message for session fallback handling", () => {
    expect(
      isScopeInterpretationUnavailableMessage(
        toUserFacingScopeInterpretationError("Not Found", 404),
      ),
    ).toBe(true);
    expect(isScopeInterpretationUnavailableMessage("socket hang up")).toBe(false);
  });
});
