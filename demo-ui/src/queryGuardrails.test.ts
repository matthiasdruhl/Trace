import { describe, expect, it } from "vitest";
import type { SearchResult, SearchResultQuality } from "./types";
import {
  applySearchResultGuardrails,
  buildQueryRefinementHint,
  sanitizeResultScores,
} from "./queryGuardrails";

function createResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    incident_id: "INC-NYC-101",
    timestamp: "2026-02-10T14:00:00.000Z",
    city_code: "NYC-TLC",
    doc_type: "Safety_Incident_Log",
    text_content: "Safety incident narrative with supporting witness detail.",
    score: 0.92,
    why_this_matched: "The safety incident narrative overlaps the requested evidence.",
    sourceRecordId: "record-inc-nyc-101",
    sourceCollection: "nyc_tlc_incident_log",
    sourceExcerpt: "Safety incident narrative with supporting witness detail.",
    dataClassification: "internal",
    redactionStatus: "none",
    ...overrides,
  };
}

const strongQuality: SearchResultQuality = {
  status: "strong",
  summary: "Strong scoped match.",
  suggestions: [],
};

describe("buildQueryRefinementHint", () => {
  it("returns null for an empty query", () => {
    expect(buildQueryRefinementHint("", {})).toBeNull();
    expect(buildQueryRefinementHint("   ", {})).toBeNull();
  });

  it("returns null for a clean query with no vague signals or unsupported cities", () => {
    expect(
      buildQueryRefinementHint("vehicle inspection audit overdue paperwork", {}),
    ).toBeNull();
  });

  it("returns a blocking hint for Boston (unsupported city)", () => {
    const hint = buildQueryRefinementHint("safety incidents in Boston", {});
    expect(hint).not.toBeNull();
    expect(hint?.blocking).toBe(true);
    expect(hint?.body).toMatch(/boston/i);
  });

  it("blocks for Boston regardless of capitalisation", () => {
    expect(buildQueryRefinementHint("incidents in BOSTON last quarter", {})?.blocking).toBe(true);
    expect(buildQueryRefinementHint("boston driver complaints", {})?.blocking).toBe(true);
  });

  it("does not block for a supported city", () => {
    const hint = buildQueryRefinementHint("safety incidents in New York", {});
    expect(hint).toBeNull();
  });

  it("returns a non-blocking advisory hint for a vague concept without structured scope", () => {
    const hint = buildQueryRefinementHint("repeat driver complaints", {});
    expect(hint).not.toBeNull();
    expect(hint?.blocking).toBe(false);
  });

  it("does not return an advisory hint for a vague concept when structured scope is already set", () => {
    const hint = buildQueryRefinementHint("repeat driver complaints", {
      cityCode: "NYC-TLC",
    });
    expect(hint).toBeNull();
  });

  it("does not block for 'repeat drivers' when a city filter is set", () => {
    const hint = buildQueryRefinementHint("safety incident with repeat drivers", {
      cityCode: "CHI-BACP",
    });
    expect(hint).toBeNull();
  });

  it("returns advisory hint for fraud without scope", () => {
    const hint = buildQueryRefinementHint("fraud concerns in the archive", {});
    expect(hint?.blocking).toBe(false);
  });

  it("does not trigger advisory hint for fraud when docType is set", () => {
    const hint = buildQueryRefinementHint("possible fraud in license records", {
      docType: "City_Permit_Renewal",
    });
    expect(hint).toBeNull();
  });

  it("blocking hint takes precedence over advisory — Boston with fraud returns blocking", () => {
    const hint = buildQueryRefinementHint("fraud complaints in Boston with repeat drivers", {});
    expect(hint?.blocking).toBe(true);
    expect(hint?.body).toMatch(/boston/i);
  });

  it("includes list of supported cities in the blocking hint body", () => {
    const hint = buildQueryRefinementHint("driver complaints in Boston", {});
    expect(hint?.body).toMatch(/NYC-TLC/);
  });
});

describe("applySearchResultGuardrails", () => {
  it("downgrades to low confidence when retrieval scores are outside the trusted range", () => {
    const quality = applySearchResultGuardrails(
      "safety incident narrative",
      [createResult({ score: 1.18 })],
      strongQuality,
    );

    expect(quality.status).toBe("low_confidence");
    expect(quality.summary).toMatch(/uncalibrated ranking scores/i);
  });

  it("downgrades to low confidence when no visible query overlap exists", () => {
    const quality = applySearchResultGuardrails(
      "overdue inspection paperwork",
      [
        createResult({
          doc_type: "Driver_Certification_Record",
          text_content: "Completely unrelated permit renewal bundle.",
          why_this_matched: "Generic semantic similarity.",
        }),
      ],
      strongQuality,
    );

    expect(quality.status).toBe("low_confidence");
    expect(quality.summary).toMatch(/did not find a result that visibly overlaps/i);
  });

  it("downgrades suspicious nonsense-style queries when overlap stays weak", () => {
    const quality = applySearchResultGuardrails(
      "zzzz impossible archive query no hits maybe",
      [
        createResult({
          doc_type: "Driver_Certification_Record",
          text_content: "Permit bundle for a routine renewal review.",
          why_this_matched: "General archive similarity.",
        }),
      ],
      strongQuality,
    );

    expect(quality.status).toBe("low_confidence");
    expect(quality.summary).toMatch(/too ambiguous or malformed/i);
  });

  it("preserves strong quality for the known-good safety preset shape", () => {
    const quality = applySearchResultGuardrails(
      "safety incident reports in New York with supporting narrative",
      [createResult()],
      strongQuality,
    );

    expect(quality.status).toBe("strong");
  });
});

describe("sanitizeResultScores", () => {
  it("clamps scores into the trusted display range", () => {
    const [result] = sanitizeResultScores([
      createResult({ score: 1.18 }),
    ]);

    expect(result.score).toBe(1);
  });
});
