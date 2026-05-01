import type { ScopeInterpretationField, ScopeInterpretationSignal, SearchFilters } from "./types";
import {
  TRACE_CITY_CODES,
  TRACE_DOC_TYPES,
  UNSAFE_USER_FACING_SNIPPET as UNSAFE_INTERP_SNIPPET,
} from "./traceVocab";

export { TRACE_CITY_CODES, TRACE_DOC_TYPES };

const CITY_CODE_SET = new Set<string>(TRACE_CITY_CODES);
const DOC_TYPE_SET = new Set<string>(TRACE_DOC_TYPES);

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const GENERIC_SCOPE_INTERPRETATION_FAILURE_MESSAGE =
  "Trace could not interpret the scope right now. You can still search with manual filters or try again in a moment.";
const UNAVAILABLE_SCOPE_INTERPRETATION_MESSAGE =
  "Scope interpretation is unavailable in this environment right now. You can still search with manual filters.";

type UnknownRecordLike = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function looksUnsafeInterpretationSnippet(text: string): boolean {
  return UNSAFE_INTERP_SNIPPET.test(text);
}

export function toUserFacingScopeInterpretationError(
  rawMessage: unknown,
  status?: number,
): string {
  const normalized = typeof rawMessage === "string" ? rawMessage.trim() : "";
  const lower = normalized.toLowerCase();

  if (
    status === 404 ||
    status === 405 ||
    status === 408 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 501 ||
    lower === "not found" ||
    lower.includes("cannot post") ||
    lower.includes("not implemented") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("service unavailable")
  ) {
    return UNAVAILABLE_SCOPE_INTERPRETATION_MESSAGE;
  }

  if (
    status === 401 ||
    status === 403 ||
    lower.includes("forbidden") ||
    lower.includes("unauthorized")
  ) {
    return "Trace could not access scope interpretation in this environment. You can still search with manual filters.";
  }

  return GENERIC_SCOPE_INTERPRETATION_FAILURE_MESSAGE;
}

export function isScopeInterpretationUnavailableMessage(message: unknown): boolean {
  return (
    typeof message === "string" &&
    message.trim().toLowerCase() ===
      UNAVAILABLE_SCOPE_INTERPRETATION_MESSAGE.trim().toLowerCase()
  );
}

export function clipPlainText(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  return collapsed.length > maxLen ? `${collapsed.slice(0, Math.max(0, maxLen - 1)).trim()}…` : collapsed;
}

/** Trims, collapses whitespace, omits obvious SQL/SQL-ish disclosure in user/model-authored lines. */
export function sanitizeUserFacingInterpretationText(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed || looksUnsafeInterpretationSnippet(collapsed)) {
    return "";
  }
  return collapsed.length > maxLen ? `${collapsed.slice(0, Math.max(0, maxLen - 1)).trim()}…` : collapsed;
}

export function isValidInterpretationDateOnly(value: string): boolean {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12) {
    return false;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return false;
  }
  return true;
}

export function sanitizeOptionalCityCode(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return CITY_CODE_SET.has(trimmed) ? trimmed : undefined;
}

export function sanitizeOptionalDocType(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return DOC_TYPE_SET.has(trimmed) ? trimmed : undefined;
}

export function sanitizeOptionalInterpretationDate(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return isValidInterpretationDateOnly(trimmed) ? trimmed : undefined;
}

export type SanitizedScopeFilters = {
  filters: SearchFilters;
  extras: {
    clientWarnings: string[];
    droppedMalformedFields: boolean;
    invalidDateRangeDropped: boolean;
  };
};

export function sanitizeScopeSuggestedFilters(raw: unknown): SanitizedScopeFilters {
  if (!isPlainObject(raw)) {
    return {
      filters: {},
      extras: {
        clientWarnings: [],
        droppedMalformedFields: false,
        invalidDateRangeDropped: false,
      },
    };
  }

  let droppedMalformedFields = false;
  let invalidDateRangeDropped = false;

  const cityCode = sanitizeOptionalCityCode(raw.cityCode);
  if (
    raw.cityCode !== undefined &&
    raw.cityCode !== null &&
    String(raw.cityCode).trim() !== "" &&
    !cityCode
  ) {
    droppedMalformedFields = true;
  }

  const docType = sanitizeOptionalDocType(raw.docType);
  if (
    raw.docType !== undefined &&
    raw.docType !== null &&
    String(raw.docType).trim() !== "" &&
    !docType
  ) {
    droppedMalformedFields = true;
  }

  let startDate = sanitizeOptionalInterpretationDate(raw.startDate);
  if (
    raw.startDate !== undefined &&
    raw.startDate !== null &&
    String(raw.startDate).trim() !== "" &&
    !startDate
  ) {
    droppedMalformedFields = true;
  }

  let endDate = sanitizeOptionalInterpretationDate(raw.endDate);
  if (
    raw.endDate !== undefined &&
    raw.endDate !== null &&
    String(raw.endDate).trim() !== "" &&
    !endDate
  ) {
    droppedMalformedFields = true;
  }

  if (startDate && endDate && startDate > endDate) {
    invalidDateRangeDropped = true;
    startDate = undefined;
    endDate = undefined;
  }

  const clientWarnings: string[] = [];
  if (droppedMalformedFields) {
    clientWarnings.push(
      "One or more suggested filter values were not in the supported Trace vocabulary and were not applied.",
    );
  }
  if (invalidDateRangeDropped) {
    clientWarnings.push(
      "The suggested date range was invalid or inconsistent and was not applied.",
    );
  }

  const filters: SearchFilters = {};
  if (cityCode) {
    filters.cityCode = cityCode;
  }
  if (docType) {
    filters.docType = docType;
  }
  if (startDate) {
    filters.startDate = startDate;
  }
  if (endDate) {
    filters.endDate = endDate;
  }

  return {
    filters,
    extras: {
      clientWarnings,
      droppedMalformedFields,
      invalidDateRangeDropped,
    },
  };
}

function signalValueMatchesSuggestedField(
  field: ScopeInterpretationField,
  normalizedValue: string,
  filters: SearchFilters,
): boolean {
  const v = normalizedValue.trim();
  if (!v) {
    return false;
  }
  switch (field) {
    case "cityCode":
      return filters.cityCode === v;
    case "docType":
      return filters.docType === v;
    case "startDate":
      return filters.startDate === v;
    case "endDate":
      return filters.endDate === v;
    default:
      return false;
  }
}

function normalizeScopeInterpretationSignalGuarded(
  input: unknown,
  filters: SearchFilters,
): ScopeInterpretationSignal | null {
  if (!isPlainObject(input)) {
    return null;
  }

  const field = input.field;
  if (
    field !== "cityCode" &&
    field !== "docType" &&
    field !== "startDate" &&
    field !== "endDate"
  ) {
    return null;
  }

  if (
    typeof input.sourceText !== "string" ||
    typeof input.normalizedValue !== "string" ||
    typeof input.rationale !== "string"
  ) {
    return null;
  }

  const sourceText = sanitizeUserFacingInterpretationText(input.sourceText.trim(), 400);
  const normalizedValue = sanitizeUserFacingInterpretationText(input.normalizedValue.trim(), 120);
  const rationale = sanitizeUserFacingInterpretationText(input.rationale.trim(), 400);

  if (!sourceText || !normalizedValue || !rationale) {
    return null;
  }

  if (!signalValueMatchesSuggestedField(field, normalizedValue, filters)) {
    return null;
  }

  return {
    field,
    sourceText,
    normalizedValue,
    rationale,
  };
}

export function buildFallbackScopeSummary(filters: SearchFilters, unresolvedSignals: string[]): string {
  const parts: string[] = [];
  if (filters.cityCode) {
    parts.push(`city ${filters.cityCode}`);
  }
  if (filters.docType) {
    parts.push(`document type ${filters.docType}`);
  }
  if (filters.startDate) {
    parts.push(`from ${filters.startDate}`);
  }
  if (filters.endDate) {
    parts.push(`through ${filters.endDate}`);
  }

  if (parts.length > 0) {
    return `Suggested scope: ${parts.join(", ")}.`;
  }
  if (unresolvedSignals.length > 0) {
    return "No safe scope suggestion available from the provided request.";
  }
  return "No safe scope suggestion available.";
}

function hasStructuredFilterValues(filters: SearchFilters): boolean {
  return (
    Boolean(filters.cityCode?.trim()) ||
    Boolean(filters.docType?.trim()) ||
    Boolean(filters.startDate?.trim()) ||
    Boolean(filters.endDate?.trim())
  );
}

export function chooseSummaryForClientDisplay(
  modelSummaryRaw: unknown,
  filters: SearchFilters,
  unresolvedSignals: string[],
  sanitizationExtras?: { droppedMalformedFields: boolean; invalidDateRangeDropped: boolean },
): string {
  const baseline = clipPlainText(buildFallbackScopeSummary(filters, unresolvedSignals), 420);

  if (
    sanitizationExtras &&
    (sanitizationExtras.droppedMalformedFields || sanitizationExtras.invalidDateRangeDropped) &&
    !hasStructuredFilterValues(filters)
  ) {
    return baseline || "Trace could not find a safe structured scope in this request.";
  }

  const modelStr =
    typeof modelSummaryRaw === "string" ? modelSummaryRaw.trim() : "";

  const modelClean = sanitizeUserFacingInterpretationText(modelStr, 420);
  if (modelClean) {
    return modelClean;
  }
  return baseline || "Trace could not find a safe structured scope in this request.";
}

export function sanitizeAppliedSignalsList(
  signals: unknown,
  filters: SearchFilters,
): ScopeInterpretationSignal[] {
  if (!Array.isArray(signals)) {
    return [];
  }

  const out: ScopeInterpretationSignal[] = [];
  for (const item of signals) {
    const next = normalizeScopeInterpretationSignalGuarded(item, filters);
    if (next) {
      out.push(next);
    }
  }
  return out;
}
