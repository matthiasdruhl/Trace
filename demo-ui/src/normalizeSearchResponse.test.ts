import { describe, it, expect } from "vitest";
import { normalizeSearchResponse } from "./api";

function baseSearchPayload() {
  return {
    queryText: "safety incident narrative",
    appliedFilter: {
      summary: "Filtered by city NYC-TLC.",
      filters: { cityCode: "NYC-TLC" },
    },
    results: [
      {
        incident_id: "a",
        timestamp: "2026-01-01T00:00:00.000Z",
        city_code: "NYC-TLC",
        doc_type: "Safety_Incident_Log",
        text_content: "Safety incident narrative",
        score: 0.4,
        why_this_matched: "Match",
        sourceRecordId: "a",
        sourceCollection: "c",
        sourceExcerpt: "e",
        dataClassification: "internal",
        redactionStatus: "none",
      },
    ],
    meta: {
      tookMs: 2,
      resultCount: 1,
      queryMode: "semantic_only",
      rankingStrategy: "score_desc",
      datasetLabel: "Trace Regulatory Demo Archive",
      datasetKind: "regulatory_archive",
      handoffReadiness: "review_only",
      confidenceReasoning: [],
      resultQuality: { status: "review", summary: "review", suggestions: [] },
    },
  };
}

describe("normalizeSearchResponse", () => {
  it("accepts minimal regulatory demo shaped payloads", () => {
    const normalized = normalizeSearchResponse(baseSearchPayload());

    expect(normalized.meta.queryMode).toBe("semantic_only");
    expect(normalized.results).toHaveLength(1);
    expect(normalized.appliedFilter.summary).toContain("NYC-TLC");
  });

  it("downgrades trust while clamping out-of-range scores", () => {
    const payload = baseSearchPayload();
    payload.results[0].score = 1.18;
    payload.meta.resultQuality = { status: "strong", summary: "strong", suggestions: [] };

    const normalized = normalizeSearchResponse(payload);

    expect(normalized.results[0].score).toBe(1);
    expect(normalized.meta.resultQuality.status).toBe("low_confidence");
  });

  it("drops inconsistent top lead ids instead of rejecting otherwise usable rows", () => {
    const payload = baseSearchPayload();
    (payload.meta as Record<string, unknown>).topLeadIncidentId = "missing";
    payload.meta.resultQuality = { status: "strong", summary: "strong", suggestions: [] };

    const normalized = normalizeSearchResponse(payload);

    expect(normalized.meta.topLeadIncidentId).toBeUndefined();
    expect(normalized.meta.resultQuality.status).toBe("review");
  });
});
