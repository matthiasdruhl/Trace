import { describe, it, expect } from "vitest";
import {
  appliedFilterChipsFromApi,
  buildTopLeadBriefingMarkdown,
  buildTrustRecapBullets,
} from "./trustBriefing";
import type { SearchResponse, SearchResult } from "./types";

const lead: SearchResult = {
  incident_id: "inc-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  city_code: "NYC-TLC",
  doc_type: "Safety_Incident_Log",
  score: 0.9,
  why_this_matched: "Aligned with filters.",
  sourceRecordId: "inc-1",
  sourceCollection: "trace-demo-regulatory-archive",
  sourceExcerpt: "Excerpt",
  dataClassification: "internal",
  redactionStatus: "none",
  provenanceSource: "backend",
  provenance: { usedFallback: false, fallbackFields: [] },
};

const response: SearchResponse = {
  queryText: "Safety incidents",
  appliedFilter: {
    summary: "Filtered by city NYC-TLC, document type Safety_Incident_Log.",
    filters: { cityCode: "NYC-TLC", docType: "Safety_Incident_Log" },
  },
  results: [lead],
  meta: {
    tookMs: 12,
    resultCount: 1,
    queryMode: "scoped_hybrid",
    rankingStrategy: "score_desc",
    topLeadIncidentId: "inc-1",
    datasetLabel: "Trace Regulatory Demo Archive",
    datasetKind: "regulatory_archive",
    hasFallbackProvenance: false,
    handoffReadiness: "ready",
    confidenceReasoning: [],
    resultQuality: { status: "strong", summary: "ok", suggestions: [] },
  },
};

describe("trustBriefing helpers", () => {
  it("appliedFilterChipsFromApi builds chips from typed filters", () => {
    const chips = appliedFilterChipsFromApi(response.appliedFilter.filters);
    expect(chips).toContain("City NYC-TLC");
    expect(chips.some((c) => c.startsWith("Document"))).toBe(true);
  });

  it("buildTrustRecapBullets caps at three deterministic entries", () => {
    const bullets = buildTrustRecapBullets(lead, response);
    expect(bullets.length).toBeLessThanOrEqual(3);
    expect(bullets.map((b) => b.key).sort()).toEqual(["match", "retrieval", "scope"]);
  });

  it("buildTopLeadBriefingMarkdown returns markdown when recap is complete", () => {
    const md = buildTopLeadBriefingMarkdown(lead, response);
    expect(md).toContain("## Trace lead briefing");
    expect(md).toContain("scoped_hybrid");
  });
});
