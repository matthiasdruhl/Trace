import type {
  ApiSearchRequest,
  HandoffSummary,
  InvestigationWorkspaceModel,
  SearchFilters,
  SearchResponse,
  SearchResult,
  SubmittedSearchContext,
} from "./types";

type DateBoundary = "start" | "end";

type ParsedDateInput = {
  year: number;
  month: number;
  day: number;
};

const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function trimOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeSearchFilters(filters: SearchFilters): SearchFilters {
  return {
    cityCode: trimOrUndefined(filters.cityCode ?? "") ?? "",
    docType: trimOrUndefined(filters.docType ?? "") ?? "",
    startDate: trimOrUndefined(filters.startDate ?? "") ?? "",
    endDate: trimOrUndefined(filters.endDate ?? "") ?? "",
  };
}

function padDatePart(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDateInput(value: string): ParsedDateInput | null {
  const match = DATE_INPUT_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  if (month < 1 || month > 12) {
    return null;
  }

  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }

  return {
    year,
    month,
    day,
  };
}

export function formatDateBoundaryTimestamp(
  value: string,
  boundary: DateBoundary
): string | null {
  const parsed = parseDateInput(value);
  if (!parsed) {
    return null;
  }

  const timePortion =
    boundary === "start" ? "00:00:00.000Z" : "23:59:59.999Z";

  return `${padDatePart(parsed.year, 4)}-${padDatePart(parsed.month)}-${padDatePart(parsed.day)}T${timePortion}`;
}

export function buildSearchRequest(
  queryText: string,
  filters: SearchFilters,
): ApiSearchRequest {
  const normalizedQuery = queryText.trim();
  const normalizedFilters = normalizeSearchFilters(filters);
  const cityCode = trimOrUndefined(normalizedFilters.cityCode ?? "");
  const docType = trimOrUndefined(normalizedFilters.docType ?? "");
  const startDate = trimOrUndefined(normalizedFilters.startDate ?? "");
  const endDate = trimOrUndefined(normalizedFilters.endDate ?? "");

  const apiFilters: NonNullable<ApiSearchRequest["filters"]> = {};

  if (cityCode) {
    apiFilters.cityCode = cityCode.toUpperCase();
  }
  if (docType) {
    apiFilters.docType = docType;
  }
  if (startDate) {
    const startTimestamp = formatDateBoundaryTimestamp(startDate, "start");
    if (startTimestamp) {
      apiFilters.startTimestamp = startTimestamp;
    }
  }
  if (endDate) {
    const endTimestamp = formatDateBoundaryTimestamp(endDate, "end");
    if (endTimestamp) {
      apiFilters.endTimestamp = endTimestamp;
    }
  }

  return {
    queryText: normalizedQuery,
    filters: Object.keys(apiFilters).length > 0 ? apiFilters : undefined,
    limit: 5,
  };
}

export function validateSubmission(
  queryText: string,
  filters: SearchFilters,
): string | null {
  if (queryText.trim().length === 0) {
    return "Enter an investigation question before running Trace.";
  }

  const startDate = trimOrUndefined(filters.startDate ?? "");
  const endDate = trimOrUndefined(filters.endDate ?? "");

  if (startDate && !parseDateInput(startDate)) {
    return "Start date is invalid.";
  }

  if (endDate && !parseDateInput(endDate)) {
    return "End date is invalid.";
  }

  if (startDate && endDate && startDate > endDate) {
    return "End date must be on or after the start date.";
  }

  return null;
}

export function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function formatLatency(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) {
    return "Timing unavailable";
  }

  return `${Math.round(milliseconds)} ms`;
}

export function formatScore(score: number): string {
  return score.toFixed(2);
}

export function summarizeActiveFilters(filters: SearchFilters): string {
  const parts: string[] = [];

  const cityCode = trimOrUndefined(filters.cityCode ?? "");
  const docType = trimOrUndefined(filters.docType ?? "");
  const startDate = trimOrUndefined(filters.startDate ?? "");
  const endDate = trimOrUndefined(filters.endDate ?? "");

  if (cityCode) {
    parts.push(`City ${cityCode.toUpperCase()}`);
  }
  if (docType) {
    parts.push(`Document type ${docType}`);
  }
  if (startDate && endDate) {
    parts.push(`Date range ${startDate} to ${endDate}`);
  } else if (startDate) {
    parts.push(`From ${startDate}`);
  } else if (endDate) {
    parts.push(`Through ${endDate}`);
  }

  return parts.length > 0 ? parts.join(" | ") : "No structured filters applied";
}

export function formatTimeWindow(filters: SearchFilters): string {
  const startDate = trimOrUndefined(filters.startDate ?? "");
  const endDate = trimOrUndefined(filters.endDate ?? "");

  if (startDate && endDate) {
    return `${startDate} to ${endDate}`;
  }

  if (startDate) {
    return `From ${startDate}`;
  }

  if (endDate) {
    return `Through ${endDate}`;
  }

  return "Open scope";
}

export function buildExcerpt(result: SearchResult): string {
  const text = result.text_content?.trim();
  if (!text) {
    return "No excerpt available for this record. Use the metadata and match explanation to continue the investigation.";
  }

  return text.length > 240 ? `${text.slice(0, 237).trimEnd()}...` : text;
}

export function buildFilterMatchChips(
  result: SearchResult,
  filters: SearchFilters,
): string[] {
  const chips: string[] = [];
  const cityCode = trimOrUndefined(filters.cityCode ?? "");
  const docType = trimOrUndefined(filters.docType ?? "");
  const startDate = trimOrUndefined(filters.startDate ?? "");
  const endDate = trimOrUndefined(filters.endDate ?? "");

  if (cityCode && result.city_code.toUpperCase() === cityCode.toUpperCase()) {
    chips.push("City scope match");
  }

  if (docType && result.doc_type === docType) {
    chips.push("Document type scope match");
  }

  if (startDate || endDate) {
    const resultTimestamp = Date.parse(result.timestamp);
    const startTimestamp = startDate
      ? Date.parse(formatDateBoundaryTimestamp(startDate, "start") ?? "")
      : null;
    const endTimestamp = endDate
      ? Date.parse(formatDateBoundaryTimestamp(endDate, "end") ?? "")
      : null;

    if (
      Number.isFinite(resultTimestamp) &&
      (startTimestamp === null || resultTimestamp >= startTimestamp) &&
      (endTimestamp === null || resultTimestamp <= endTimestamp)
    ) {
      chips.push("Within requested date range");
    }
  }

  return chips;
}

export function buildPrimaryEvidenceLabel(result: SearchResult): string {
  return `${result.incident_id} · ${result.doc_type} · ${result.city_code} · ${formatTimestamp(result.timestamp)}`;
}

export function buildHandoffSummary(
  queryText: string,
  activeScope: string,
  topLead: SearchResult,
  supportingResults: SearchResult[],
): HandoffSummary {
  const supportingCount = supportingResults.length;
  const supportingLabel =
    supportingCount > 0
      ? ` with ${supportingCount} supporting record${supportingCount === 1 ? "" : "s"}`
      : "";

  return {
    goal: queryText.trim(),
    appliedScope: activeScope,
    primaryEvidence: buildPrimaryEvidenceLabel(topLead),
    suggestedHandoff: `Review incident ${topLead.incident_id}${supportingLabel} in this scope before escalation.`,
  };
}

export function deriveInvestigationWorkspaceModel(
  queryText: string,
  filters: SearchFilters,
  response: SearchResponse | null,
  submittedSearchContext: SubmittedSearchContext | null,
): InvestigationWorkspaceModel {
  const activeFilters = submittedSearchContext?.filters ?? filters;
  const activeQueryText = submittedSearchContext?.queryText ?? queryText;
  const activeScope =
    response?.appliedFilter.summary || summarizeActiveFilters(activeFilters);
  const results = response?.results ?? [];
  const topLead = results[0] ?? null;
  const supportingResults = topLead ? results.slice(1) : [];

  return {
    investigationRequest:
      response?.queryText ?? trimOrUndefined(activeQueryText) ?? "No investigation request yet",
    activeScope,
    timeWindow: formatTimeWindow(activeFilters),
    queryModeLabel: response ? `${response.meta.queryMode} retrieval` : "Awaiting query",
    resultCount: response?.meta.resultCount ?? 0,
    latencyLabel: response ? formatLatency(response.meta.tookMs) : "Timing unavailable",
    submittedFilters: activeFilters,
    topLead,
    supportingResults,
    handoffSummary: topLead
      ? buildHandoffSummary(
          response?.queryText ?? activeQueryText,
          activeScope,
          topLead,
          supportingResults,
        )
      : null,
  };
}
