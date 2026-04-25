import { HttpError } from "./common.js";

export type TypedSearchFilters = {
  cityCode?: string;
  docType?: string;
  startTimestamp?: string;
  endTimestamp?: string;
};

export type NormalizedTypedSearchFilters = {
  cityCode?: string;
  docType?: string;
  startTimestamp?: string;
  endTimestamp?: string;
};

export type SerializedFilters = {
  filters: NormalizedTypedSearchFilters;
  sqlFilter: string;
  summary: string;
};

const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const FILTER_KEYS = new Set<keyof TypedSearchFilters>([
  "cityCode",
  "docType",
  "startTimestamp",
  "endTimestamp",
]);

type ParsedTimestamp = {
  isoUtc: string;
  epochMs: number;
};

function invalidTimestampError(label: string): HttpError {
  return new HttpError(
    400,
    "INVALID_FILTER",
    `${label} must be an ISO 8601 timestamp with an explicit timezone, like 2025-01-01T00:00:00.000Z.`
  );
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseExplicitTimestamp(label: string, value: string): ParsedTimestamp {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    throw invalidTimestampError(label);
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText,
    timezone,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;

  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText, 10);
  const millisecond = Number.parseInt((fractionText ?? "").padEnd(3, "0") || "0", 10);

  if (month < 1 || month > 12) {
    throw invalidTimestampError(label);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw invalidTimestampError(label);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw invalidTimestampError(label);
  }

  let offsetMinutes = 0;
  if (timezone !== "Z") {
    const offsetHours = Number.parseInt(offsetHourText ?? "", 10);
    const offsetRemainderMinutes = Number.parseInt(offsetMinuteText ?? "", 10);
    if (
      !Number.isInteger(offsetHours) ||
      !Number.isInteger(offsetRemainderMinutes) ||
      offsetHours > 23 ||
      offsetRemainderMinutes > 59
    ) {
      throw invalidTimestampError(label);
    }
    offsetMinutes = offsetHours * 60 + offsetRemainderMinutes;
    if (offsetSign === "-") {
      offsetMinutes *= -1;
    }
  }

  const localEpochMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const epochMs = localEpochMs - offsetMinutes * 60_000;

  return {
    isoUtc: new Date(epochMs).toISOString(),
    epochMs,
  };
}

function validateFilterKeys(filters: Record<string, unknown>): void {
  for (const key of Object.keys(filters)) {
    if (FILTER_KEYS.has(key as keyof TypedSearchFilters)) {
      continue;
    }
    throw new HttpError(400, "INVALID_FILTER", `filters.${key} is not supported.`);
  }
}

function normalizeCodeField(label: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_FILTER", `${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!CODE_PATTERN.test(trimmed)) {
    throw new HttpError(
      400,
      "INVALID_FILTER",
      `${label} may contain only letters, numbers, underscores, and hyphens.`
    );
  }
  return trimmed;
}

function normalizeTimestampField(
  label: string,
  value: unknown
): ParsedTimestamp | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_FILTER", `${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return parseExplicitTimestamp(label, trimmed);
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function serializeTypedFilters(filters: unknown): SerializedFilters {
  if (filters === undefined) {
    return {
      filters: {},
      sqlFilter: "",
      summary: "No metadata filters applied.",
    };
  }

  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) {
    throw new HttpError(400, "INVALID_FILTER", "filters must be an object.");
  }

  const filterRecord = filters as Record<string, unknown>;
  validateFilterKeys(filterRecord);

  const typed = filterRecord as TypedSearchFilters;
  const cityCode = normalizeCodeField("filters.cityCode", typed.cityCode);
  const docType = normalizeCodeField("filters.docType", typed.docType);
  const startTimestamp = normalizeTimestampField(
    "filters.startTimestamp",
    typed.startTimestamp
  );
  const endTimestamp = normalizeTimestampField(
    "filters.endTimestamp",
    typed.endTimestamp
  );

  if (startTimestamp && endTimestamp && startTimestamp.epochMs > endTimestamp.epochMs) {
    throw new HttpError(
      400,
      "INVALID_FILTER_RANGE",
      "filters.startTimestamp must be before or equal to filters.endTimestamp."
    );
  }

  const parts: string[] = [];
  const summaryParts: string[] = [];

  if (cityCode) {
    parts.push(`city_code = ${quoteSqlLiteral(cityCode)}`);
    summaryParts.push(`city ${cityCode}`);
  }
  if (docType) {
    parts.push(`doc_type = ${quoteSqlLiteral(docType)}`);
    summaryParts.push(`document type ${docType}`);
  }
  if (startTimestamp) {
    parts.push(`timestamp >= ${quoteSqlLiteral(startTimestamp.isoUtc)}`);
    summaryParts.push(`from ${startTimestamp.isoUtc}`);
  }
  if (endTimestamp) {
    parts.push(`timestamp <= ${quoteSqlLiteral(endTimestamp.isoUtc)}`);
    summaryParts.push(`through ${endTimestamp.isoUtc}`);
  }

  return {
    filters: {
      cityCode,
      docType,
      startTimestamp: startTimestamp?.isoUtc,
      endTimestamp: endTimestamp?.isoUtc,
    },
    sqlFilter: parts.join(" AND "),
    summary:
      summaryParts.length > 0
        ? `Filtered by ${summaryParts.join(", ")}.`
        : "No metadata filters applied.",
  };
}
