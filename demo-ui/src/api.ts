import type {
  ApiCasePayload,
  ApiSearchRequest,
  CuratedCase,
  HealthState,
  SearchResponse,
  SearchResult,
} from "./types";

const DEFAULT_API_BASE_URL = "http://localhost:3000";
const INVALID_SEARCH_RESPONSE_MESSAGE =
  "Trace received an incomplete response from the app API. Please try again.";

const curatedCaseFallbacks: CuratedCase[] = [
  {
    id: "overdue-inspection-audit",
    title: "Overdue inspection audit",
    subtitle: "Semantic-only win",
    description:
      "Show the archive can retrieve overdue inspection audit cases without a metadata prefilter.",
    queryText: "recent vehicle inspection audit with overdue paperwork",
    filters: {},
    fixtureAvailable: true,
  },
  {
    id: "nyc-safety-incident",
    title: "NYC safety incident",
    subtitle: "Filtering win",
    description:
      "Use city and document-type filters to narrow a semantic query to the exact regulatory slice.",
    queryText: "safety incident reports in New York with supporting narrative",
    filters: {
      cityCode: "NYC-TLC",
      docType: "Safety_Incident_Log",
    },
    fixtureAvailable: true,
  },
  {
    id: "insurance-lapse-coverage-gap",
    title: "Insurance lapse / coverage gap",
    subtitle: "Operator-value case",
    description:
      "Surface insurance lapse cases that matter operationally when coverage gaps can suspend vehicles.",
    queryText: "insurance lapse or coverage gap for fleet vehicles",
    filters: {
      cityCode: "CHI-BACP",
      docType: "Insurance_Lapse_Report",
    },
    fixtureAvailable: false,
  },
];

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function requireString(value: unknown): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  return normalized;
}

function requireStringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  return value;
}

function requireFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  return value;
}

export function resolveApiBaseUrl(
  baseUrl: string | undefined = import.meta.env.VITE_TRACE_API_BASE_URL,
): string {
  const normalized = readOptionalString(baseUrl) ?? DEFAULT_API_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

export function buildApiUrl(pathname: string, baseUrl?: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const normalizedBaseUrl = resolveApiBaseUrl(baseUrl);
  const baseAlreadyIncludesApi =
    normalizedBaseUrl === "/api" || normalizedBaseUrl.endsWith("/api");
  const apiPath =
    normalizedPath === "/api" || normalizedPath.startsWith("/api/")
      ? normalizedPath
      : `${baseAlreadyIncludesApi ? "" : "/api"}${normalizedPath}`;
  return `${normalizedBaseUrl}${apiPath}`;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    if (isPlainObject(payload)) {
      const message =
        readOptionalString(payload.message) ??
        readOptionalString(payload.error) ??
        (isPlainObject(payload.error) ? readOptionalString(payload.error.message) : undefined);

      if (message) {
        return message;
      }
    }
  } catch {
    // Ignore parse errors and fall through to status text.
  }

  return response.statusText || "Unexpected backend error";
}

function normalizeCaseRecord(input: unknown, index: number): CuratedCase {
  const fallback = curatedCaseFallbacks[index];
  const record: ApiCasePayload = isPlainObject(input) ? (input as ApiCasePayload) : {};
  const rawFilters = isPlainObject(record.filters) ? record.filters : {};

  return {
    id:
      readOptionalString(record.caseId) ??
      readOptionalString(record.id) ??
      fallback?.id ??
      `case-${index + 1}`,
    title:
      readOptionalString(record.label) ??
      readOptionalString(record.title) ??
      fallback?.title ??
      `Example ${index + 1}`,
    subtitle: readOptionalString(record.subtitle) ?? fallback?.subtitle,
    description:
      readOptionalString(record.description) ??
      readOptionalString(record.narrative) ??
      readOptionalString(record.subtitle) ??
      fallback?.description ??
      "",
    queryText:
      readOptionalString(record.queryText) ??
      readOptionalString(record.query) ??
      readOptionalString(record.prompt) ??
      fallback?.queryText ??
      "",
    filters: {
      cityCode:
        readOptionalString(rawFilters.cityCode) ?? fallback?.filters.cityCode,
      docType:
        readOptionalString(rawFilters.docType) ?? fallback?.filters.docType,
      startDate:
        readOptionalString(rawFilters.startTimestamp)?.slice(0, 10) ??
        fallback?.filters.startDate,
      endDate:
        readOptionalString(rawFilters.endTimestamp)?.slice(0, 10) ??
        fallback?.filters.endDate,
    },
    fixtureAvailable:
      typeof record.fixtureAvailable === "boolean"
        ? record.fixtureAvailable
        : fallback?.fixtureAvailable,
  };
}

function isUsableCuratedCase(curatedCase: CuratedCase): boolean {
  return curatedCase.title.trim().length > 0 && curatedCase.queryText.trim().length > 0;
}

function normalizeSearchResult(input: unknown): SearchResult {
  if (!isPlainObject(input)) {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  const textContent = input.text_content;
  if (textContent !== undefined && typeof textContent !== "string") {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  return {
    incident_id: requireString(input.incident_id),
    timestamp: requireString(input.timestamp),
    city_code: requireString(input.city_code),
    doc_type: requireString(input.doc_type),
    text_content: textContent,
    score: requireFiniteNumber(input.score),
    why_this_matched: requireString(input.why_this_matched),
  };
}

function normalizeSearchResponse(payload: unknown): SearchResponse {
  if (!isPlainObject(payload)) {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  if (!isPlainObject(payload.appliedFilter) || !isPlainObject(payload.meta) || !Array.isArray(payload.results)) {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  const normalizedResults = payload.results.map((result) => normalizeSearchResult(result));
  requireFiniteNumber(payload.meta.resultCount);

  return {
    queryText: requireString(payload.queryText),
    appliedFilter: {
      sqlFilter: requireStringValue(payload.appliedFilter.sqlFilter),
      summary: requireString(payload.appliedFilter.summary),
    },
    results: normalizedResults,
    meta: {
      tookMs: requireFiniteNumber(payload.meta.tookMs),
      resultCount: normalizedResults.length,
      queryMode: requireString(payload.meta.queryMode),
    },
  };
}

export async function fetchCases(signal?: AbortSignal): Promise<CuratedCase[]> {
  try {
    const response = await fetch(buildApiUrl("/cases"), { signal });
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    const payload = (await response.json()) as unknown;
    const caseRecords = Array.isArray(payload)
      ? payload
      : isPlainObject(payload) && Array.isArray(payload.cases)
        ? payload.cases
        : null;

    if (!caseRecords || caseRecords.length === 0) {
      return curatedCaseFallbacks;
    }

    const normalized = caseRecords
      .map((record, index) => normalizeCaseRecord(record, index))
      .filter((curatedCase) => isUsableCuratedCase(curatedCase));

    return normalized.length > 0 ? normalized : curatedCaseFallbacks;
  } catch {
    return curatedCaseFallbacks;
  }
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthState> {
  try {
    const response = await fetch(buildApiUrl("/health"), { signal });
    return {
      ready: response.ok,
      label: response.ok ? "Backend ready" : "Backend unavailable",
    };
  } catch {
    return {
      ready: false,
      label: "Backend unavailable",
    };
  }
}

export async function searchTrace(
  request: ApiSearchRequest,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const response = await fetch(buildApiUrl("/search"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  try {
    const payload = await response.json();
    return normalizeSearchResponse(payload);
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_SEARCH_RESPONSE_MESSAGE) {
      throw error;
    }

    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }
}
