import type { ApiSearchRequest, SearchFilters, SearchResult } from "./types";

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
  const cityCode = trimOrUndefined(filters.cityCode ?? "");
  const docType = trimOrUndefined(filters.docType ?? "");
  const startDate = trimOrUndefined(filters.startDate ?? "");
  const endDate = trimOrUndefined(filters.endDate ?? "");

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

export function buildExcerpt(result: SearchResult): string {
  const text = result.text_content?.trim();
  if (!text) {
    return "No excerpt available for this record. Use the metadata and match explanation to continue the investigation.";
  }

  return text.length > 240 ? `${text.slice(0, 237).trimEnd()}...` : text;
}
