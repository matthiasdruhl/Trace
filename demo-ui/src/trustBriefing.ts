import type { AppliedTypedFiltersApi, SearchResponse, SearchResult } from "./types";

export function appliedFilterChipsFromApi(
  filters: AppliedTypedFiltersApi | undefined,
): string[] {
  if (!filters) {
    return [];
  }
  const chips: string[] = [];
  if (filters.cityCode?.trim()) {
    chips.push(`City ${filters.cityCode.trim()}`);
  }
  if (filters.docType?.trim()) {
    chips.push(`Document ${filters.docType.trim()}`);
  }
  if (filters.startTimestamp?.trim()) {
    chips.push(`From ${filters.startTimestamp.trim()}`);
  }
  if (filters.endTimestamp?.trim()) {
    chips.push(`Through ${filters.endTimestamp.trim()}`);
  }
  return chips;
}

export type TrustRecapBullet = {
  key: string;
  text: string;
};

export function buildTrustRecapBullets(
  result: SearchResult,
  response: SearchResponse,
): TrustRecapBullet[] {
  const bullets: TrustRecapBullet[] = [];
  const summary = response.appliedFilter.summary?.trim();
  if (summary) {
    bullets.push({
      key: "scope",
      text: `Applied scope (API): ${summary}`,
    });
  }
  const id = result.sourceRecordId?.trim() || result.incident_id?.trim();
  if (id && result.why_this_matched?.trim()) {
    bullets.push({
      key: "match",
      text: `Primary lead ${id}: ${result.why_this_matched.trim()}`,
    });
  }
  const mode = response.meta.queryMode?.trim();
  const rank = response.meta.rankingStrategy?.trim();
  const n = response.meta.resultCount;
  if (mode && rank && Number.isFinite(n)) {
    bullets.push({
      key: "retrieval",
      text: `Retrieval: ${mode}; ranking: ${rank}; packaged results: ${n}`,
    });
  }
  return bullets.slice(0, 3);
}

/** Deterministic markdown when every bullet is present; otherwise null (fall back to narrower copy). */
export function buildTopLeadBriefingMarkdown(
  result: SearchResult,
  response: SearchResponse,
): string | null {
  const bullets = buildTrustRecapBullets(result, response);
  if (bullets.length < 3) {
    return null;
  }
  const lines = ["## Trace lead briefing (verify before handoff)", "", ...bullets.map((b) => `- ${b.text}`), ""];
  return lines.join("\n");
}

export function buildRequestScopeCopyMarkdown(
  queryText: string,
  appliedSummary: string | undefined,
): string {
  const lines = [
    "## Investigation request + scope",
    "",
    `**Request:** ${queryText.trim()}`,
    "",
    `**Applied scope (API):** ${(appliedSummary ?? "Not available").trim()}`,
    "",
  ];
  return lines.join("\n");
}
