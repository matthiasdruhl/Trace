import type {
  QueryRefinementHint,
  ResultQualityStatus,
  SearchFilters,
  SearchResult,
  SearchResultQuality,
} from "./types";
import { compileUnsupportedDemoCityRules } from "./traceVocab";

const SUPPORTED_CITY_HINTS = [
  "NYC-TLC",
  "CHI-BACP",
  "SF-CPUC",
  "LON-TfL",
  "PAR-VTC",
  "MEX-SEMOVI",
  "SAO-DTP",
];

const UNSUPPORTED_CITY_RULES = compileUnsupportedDemoCityRules();

const VAGUE_CONCEPT_RULES = [
  /\brepeat drivers?\b/i,
  /\bcomplaints?\b/i,
  /\bfraud\b/i,
];

const QUERY_TOKEN_PATTERN = /[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9]+)?/gi;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "archive",
  "around",
  "at",
  "be",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "maybe",
  "no",
  "of",
  "on",
  "or",
  "recent",
  "report",
  "reports",
  "same",
  "that",
  "the",
  "to",
  "with",
]);

const SCORE_MIN = 0;
const SCORE_MAX = 1;

function tokenizeMeaningfulTerms(text: string): string[] {
  const matches = text.toLowerCase().match(QUERY_TOKEN_PATTERN) ?? [];

  return matches.filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function normalizeTokenForOverlap(token: string): string[] {
  return token
    .split(/[_-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function buildQueryVocabulary(queryText: string): string[] {
  return tokenizeMeaningfulTerms(queryText).flatMap((token) => normalizeTokenForOverlap(token));
}

function buildResultVocabulary(result: SearchResult): Set<string> {
  return new Set(
    tokenizeMeaningfulTerms(
      [
        result.incident_id,
        result.city_code,
        result.doc_type,
        result.why_this_matched,
        result.text_content ?? "",
      ].join(" "),
    ).flatMap((token) => normalizeTokenForOverlap(token)),
  );
}

function countQueryOverlap(queryTokens: string[], result: SearchResult): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const resultTokens = buildResultVocabulary(result);
  let overlap = 0;
  for (const token of queryTokens) {
    if (resultTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function queryContainsGibberishToken(queryText: string): boolean {
  return tokenizeMeaningfulTerms(queryText).some(
    (token) =>
      /^([a-z0-9])\1{3,}$/.test(token) ||
      /^[bcdfghjklmnpqrstvwxyz]{5,}$/i.test(token),
  );
}

function downgradeResultQuality(
  current: SearchResultQuality,
  nextStatus: ResultQualityStatus,
  summary: string,
  suggestions: string[],
): SearchResultQuality {
  const priority: Record<ResultQualityStatus, number> = {
    strong: 0,
    review: 1,
    low_confidence: 2,
  };

  if (priority[nextStatus] <= priority[current.status]) {
    return current;
  }

  return {
    status: nextStatus,
    summary,
    suggestions,
  };
}

export function sanitizeResultScores(results: SearchResult[]): SearchResult[] {
  return results.map((result) => ({
    ...result,
    score: Math.min(SCORE_MAX, Math.max(SCORE_MIN, result.score)),
  }));
}

export function applySearchResultGuardrails(
  queryText: string,
  results: SearchResult[],
  serverQuality: SearchResultQuality,
): SearchResultQuality {
  let quality = serverQuality;

  if (results.length === 0) {
    return quality;
  }

  const hasOutOfRangeScore = results.some(
    (result) => result.score < SCORE_MIN || result.score > SCORE_MAX,
  );
  if (hasOutOfRangeScore) {
    quality = downgradeResultQuality(
      quality,
      "low_confidence",
      "Trace received uncalibrated ranking scores from retrieval, so these results are withheld pending review.",
      [
        "Retry the search after narrowing the request with a supported city, document type, or date range.",
        "Only trust a lead when the returned ranking scores stay within the expected 0.00 to 1.00 range.",
      ],
    );
  }

  const queryTokens = buildQueryVocabulary(queryText);
  if (queryTokens.length === 0) {
    return quality;
  }

  const overlapCounts = results.map((result) => countQueryOverlap(queryTokens, result));
  const maxOverlap = Math.max(...overlapCounts);
  const maxOverlapRatio = maxOverlap / queryTokens.length;
  const suspiciousQuery = queryContainsGibberishToken(queryText);

  if (suspiciousQuery && maxOverlapRatio < 0.34) {
    return downgradeResultQuality(
      quality,
      "low_confidence",
      "This request reads as too ambiguous or malformed for a trustworthy winner, so Trace is withholding the retrieved hits.",
      [
        "Replace placeholder or nonsensical terms with the exact event type you want to investigate.",
        "Use Interpret scope or add one concrete filter before running the search again.",
      ],
    );
  }

  if (maxOverlap === 0 && queryTokens.length >= 3) {
    return downgradeResultQuality(
      quality,
      "low_confidence",
      "Trace did not find a result that visibly overlaps the investigation request, so these hits are not safe to present as evidence.",
      [
        "Rewrite the question using the exact event or document language you expect in the archive.",
        "Add a supported city, document type, or time window before trusting the next retrieval pass.",
      ],
    );
  }

  if (quality.status === "strong" && queryTokens.length >= 4 && maxOverlapRatio < 0.34) {
    return downgradeResultQuality(
      quality,
      "review",
      "Trace found a plausible lead, but the visible overlap with the request is still thin enough that an operator should review it before handoff.",
      [
        "Tighten the request with a city, document type, or date range.",
        "Prefer the lead only if the excerpt and match explanation clearly mirror the investigation question.",
      ],
    );
  }

  return quality;
}

function hasStructuredScope(filters: SearchFilters): boolean {
  return Boolean(
    filters.cityCode?.trim() ||
      filters.docType?.trim() ||
      filters.startDate?.trim() ||
      filters.endDate?.trim(),
  );
}

export function buildQueryRefinementHint(
  queryText: string,
  filters: SearchFilters,
): QueryRefinementHint | null {
  const normalizedQuery = queryText.trim();
  if (!normalizedQuery) {
    return null;
  }

  for (const rule of UNSUPPORTED_CITY_RULES) {
    if (rule.pattern.test(normalizedQuery)) {
      return {
        title: "Need narrower request",
        body: `${rule.label} is outside the trusted city mappings in this demo. Try a supported city (${SUPPORTED_CITY_HINTS.join(", ")}) or run the recommended demo path.`,
        blocking: true,
      };
    }
  }

  if (!hasStructuredScope(filters) && VAGUE_CONCEPT_RULES.some((rule) => rule.test(normalizedQuery))) {
    return {
      title: "Add one concrete scope signal",
      body: "This request is broad enough that Trace may surface plausible but non-defensible matches. Add a city or document type, or use Interpret scope before running the search.",
      blocking: false,
    };
  }

  return null;
}
