import type {
  ApiCasePayload,
  ApiSearchRequest,
  AppliedTypedFiltersApi,
  CuratedCase,
  DataClassification,
  DatasetKind,
  HealthState,
  HandoffReadiness,
  RedactionStatus,
  ScopeInterpretationRequest,
  ScopeInterpretationSuggestion,
  ProvenanceSource,
  SearchResponse,
  SearchResultQuality,
  SearchResult,
} from "./types";
import { applySearchResultGuardrails, sanitizeResultScores } from "./queryGuardrails";
import {
  chooseSummaryForClientDisplay,
  clipPlainText,
  sanitizeAppliedSignalsList,
  sanitizeScopeSuggestedFilters,
  toUserFacingScopeInterpretationError,
} from "./scopeInterpretGuards";
import {
  SearchApiError,
  combineAbortSignals,
  createDeadlineController,
  isAbortLikeError,
  SCOPE_INTERPRETATION_HTTP_TIMEOUT_MS,
  SEARCH_HTTP_TIMEOUT_MS,
} from "./httpSearch";
import { canonicalizeTraceDocType } from "./utils";
import { canonicalizeTraceCityCode } from "./traceVocab";

const DEFAULT_API_BASE_URL = "http://localhost:3000";
const INVALID_SEARCH_RESPONSE_MESSAGE =
  "Trace received an incomplete response from the app API. Please try again.";
const INVALID_SCOPE_INTERPRETATION_RESPONSE_MESSAGE =
  "Trace received an incomplete scope interpretation response from the app API. Please try again.";
const DEFAULT_DATASET_LABEL = "Trace Regulatory Demo Archive";
const DEFAULT_DATASET_KIND: DatasetKind = "regulatory_archive";
const DEFAULT_SOURCE_COLLECTION = "trace-demo-regulatory-archive";

export const curatedCaseFallbacks: CuratedCase[] = [
  {
    id: "nyc-safety-incident",
    title: "NYC safety audit response",
    subtitle: "Recommended first run",
    description:
      "Use preserved city and document scope to narrow a vague audit request to the exact regulatory records worth handing off.",
    queryText: "safety incident reports in New York with supporting narrative",
    filters: {
      cityCode: "NYC-TLC",
      docType: "Safety_Incident_Log",
    },
    fixtureAvailable: true,
  },
  {
    id: "overdue-inspection-audit",
    title: "Overdue inspection audit",
    subtitle: "Semantic-only alternate",
    description:
      "Show the archive can still retrieve overdue inspection audit cases without a metadata prefilter.",
    queryText: "recent vehicle inspection audit with overdue paperwork",
    filters: {},
    fixtureAvailable: true,
  },
  /**
   * Stable 0-result narrow slice for demo refinement UX (evaluated 2026-04 on the Trace
   * regulatory demo archive: NYC-TLC safety incidents dominate the NYC slice; pairing NYC
   * with Insurance_Lapse_Report yields no rows while staying in supported vocab).
   */
  {
    id: "narrow-slice-zero-results",
    title: "Empty slice refinement drill",
    subtitle: "Stable zero-match path",
    description:
      "Practice refinement when the slice is legally valid but the cross of city and document type does not exist in this archive.",
    queryText: "insurance lapse paperwork tied to New York fleet operations",
    filters: {
      cityCode: "NYC-TLC",
      docType: "Insurance_Lapse_Report",
    },
    fixtureAvailable: true,
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

function requireFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  return value;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => readOptionalString(entry))
    .filter((entry): entry is string => entry !== undefined);
}

function normalizeFieldToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeCuratedCaseId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const curatedCaseFallbackById = new Map(
  curatedCaseFallbacks.map((fallback) => [normalizeCuratedCaseId(fallback.id), fallback]),
);

function normalizeDataClassification(value: unknown): DataClassification {
  const normalized = readOptionalString(value);
  if (!normalized) {
    return "unknown";
  }

  switch (normalizeFieldToken(normalized)) {
    case "public":
    case "open":
      return "public";
    case "internal":
    case "internal_demo":
    case "demo_internal":
      return "internal";
    case "confidential":
      return "confidential";
    case "restricted":
    case "sensitive":
    case "regulated":
    case "protected":
      return "restricted";
    default:
      return "unknown";
  }
}

function normalizeRedactionStatus(value: unknown): RedactionStatus {
  const normalized = readOptionalString(value);
  if (!normalized) {
    return "unknown";
  }

  switch (normalizeFieldToken(normalized)) {
    case "none":
    case "not_redacted":
    case "unredacted":
    case "original":
      return "none";
    case "partial":
    case "partially_redacted":
    case "masked":
      return "partial";
    case "full":
    case "fully_redacted":
    case "redacted":
      return "full";
    default:
      return "unknown";
  }
}

function normalizeDatasetKind(value: unknown): DatasetKind {
  const normalized = readOptionalString(value);
  if (!normalized) {
    return DEFAULT_DATASET_KIND;
  }

  switch (normalizeFieldToken(normalized)) {
    case "regulatory":
    case "regulatory_archive":
    case "demo_regulatory_archive":
    case "regulatory_demo_archive":
      return "regulatory_archive";
    case "fixture":
    case "curated_fixture":
    case "curated_case_fixture":
      return "curated_case_fixture";
    case "mixed":
      return "mixed";
    case "unknown":
    case "unspecified":
      return "unknown";
    default:
      return DEFAULT_DATASET_KIND;
  }
}

function normalizeHandoffReadiness(value: unknown): HandoffReadiness {
  const normalized = readOptionalString(value);
  if (normalized === "ready" || normalized === "review_only" || normalized === "not_trustworthy") {
    return normalized;
  }
  if (normalized === "review_required") {
    return "review_only";
  }
  if (normalized === "blocked") {
    return "not_trustworthy";
  }
  return "review_only";
}

function alignHandoffReadinessWithQuality(
  readiness: HandoffReadiness,
  quality: SearchResultQuality,
): HandoffReadiness {
  if (quality.status === "low_confidence") {
    return "not_trustworthy";
  }
  if (quality.status !== "strong" && readiness === "ready") {
    return "review_only";
  }
  return readiness;
}

function normalizeAppliedTypedFiltersPayload(raw: unknown): AppliedTypedFiltersApi | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }

  const out: AppliedTypedFiltersApi = {};

  const cityCode = readOptionalString(raw.cityCode);
  if (cityCode) {
    out.cityCode = cityCode;
  }

  const docType = readOptionalString(raw.docType);
  if (docType) {
    out.docType = docType;
  }

  const startTimestamp = readOptionalString(raw.startTimestamp);
  if (startTimestamp) {
    out.startTimestamp = startTimestamp;
  }

  const endTimestamp = readOptionalString(raw.endTimestamp);
  if (endTimestamp) {
    out.endTimestamp = endTimestamp;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolveApiBaseUrl(
  baseUrl: string | undefined = import.meta.env.VITE_TRACE_API_BASE_URL,
): string {
  const normalized = readOptionalString(baseUrl) ?? DEFAULT_API_BASE_URL;
  return normalized.replace(/\/+$/, "");
}

export function buildApiUrl(pathname: string, baseUrl?: string): string {
  let normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const normalizedBaseUrl = resolveApiBaseUrl(baseUrl);
  const baseAlreadyIncludesApi =
    normalizedBaseUrl === "/api" || normalizedBaseUrl.endsWith("/api");

  if (normalizedPath === "/api" || normalizedPath.startsWith("/api/")) {
    normalizedPath =
      normalizedPath === "/api"
        ? "/"
        : normalizedPath.slice("/api".length) || "/";
    if (!normalizedPath.startsWith("/")) {
      normalizedPath = `/${normalizedPath}`;
    }
  }

  const apiPath = baseAlreadyIncludesApi ? normalizedPath : `/api${normalizedPath}`;
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
  const record: ApiCasePayload = isPlainObject(input) ? (input as ApiCasePayload) : {};
  const rawFilters = isPlainObject(record.filters) ? record.filters : {};
  const resolvedId =
    readOptionalString(record.caseId) ?? readOptionalString(record.id) ?? `case-${index + 1}`;
  const fallback = curatedCaseFallbackById.get(normalizeCuratedCaseId(resolvedId));
  const cityCode = readOptionalString(rawFilters.cityCode);
  const docType = readOptionalString(rawFilters.docType);

  return {
    id: fallback?.id ?? resolvedId,
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
      cityCode: cityCode
        ? canonicalizeTraceCityCode(cityCode)
        : fallback?.filters.cityCode,
      docType: docType
        ? canonicalizeTraceDocType(docType)
        : fallback?.filters.docType,
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

  const explicitSourceRecordId = readOptionalString(input.sourceRecordId);
  const explicitSourceCollection = readOptionalString(input.sourceCollection);
  const explicitSourceExcerpt = readOptionalString(input.sourceExcerpt);
  const explicitProvenanceSource = readOptionalString(input.provenanceSource);
  const explicitProvenance = isPlainObject(input.provenance) ? input.provenance : undefined;
  const explicitFallbackFields = Array.isArray(explicitProvenance?.fallbackFields)
    ? explicitProvenance.fallbackFields.filter(
        (field): field is NonNullable<SearchResult["provenance"]>["fallbackFields"][number] =>
          field === "sourceRecordId" ||
          field === "sourceCollection" ||
          field === "sourceExcerpt" ||
          field === "dataClassification" ||
          field === "redactionStatus",
      )
    : [];
  const provenanceSource: ProvenanceSource =
    explicitProvenanceSource === "backend" || explicitProvenanceSource === "synthesized"
      ? explicitProvenanceSource
      : explicitSourceRecordId && explicitSourceCollection && explicitSourceExcerpt
        ? "backend"
        : "synthesized";
  const fallbackFields =
    explicitFallbackFields.length > 0
      ? explicitFallbackFields
      : provenanceSource === "synthesized"
        ? [
            ...(explicitSourceRecordId ? [] : (["sourceRecordId"] as const)),
            ...(explicitSourceCollection ? [] : (["sourceCollection"] as const)),
            ...(explicitSourceExcerpt ? [] : (["sourceExcerpt"] as const)),
            ...(readOptionalString(input.dataClassification) ? [] : (["dataClassification"] as const)),
            ...(readOptionalString(input.redactionStatus) ? [] : (["redactionStatus"] as const)),
          ]
        : [];
  const provenance = {
    usedFallback:
      explicitProvenance?.usedFallback === true || provenanceSource === "synthesized",
    fallbackFields,
  };

  return {
    incident_id: requireString(input.incident_id),
    timestamp: requireString(input.timestamp),
    city_code: requireString(input.city_code),
    doc_type: requireString(input.doc_type),
    text_content: textContent,
    score: requireFiniteNumber(input.score),
    why_this_matched: requireString(input.why_this_matched),
    sourceRecordId: explicitSourceRecordId ?? requireString(input.incident_id),
    sourceCollection: explicitSourceCollection ?? DEFAULT_SOURCE_COLLECTION,
    sourceExcerpt:
      explicitSourceExcerpt ??
      readOptionalString(textContent) ??
      "No source excerpt was supplied by the backend for this record.",
    dataClassification: normalizeDataClassification(input.dataClassification),
    redactionStatus: normalizeRedactionStatus(input.redactionStatus),
    provenanceSource,
    provenance,
  };
}

export function normalizeSearchResponse(payload: unknown): SearchResponse {
  if (!isPlainObject(payload)) {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  if (!isPlainObject(payload.appliedFilter) || !isPlainObject(payload.meta) || !Array.isArray(payload.results)) {
    throw new Error(INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  const queryText = requireString(payload.queryText);
  const normalizedResults = payload.results.map((result) => normalizeSearchResult(result));
  const topLeadId = readOptionalString(payload.meta.topLeadIncidentId);
  const topLeadMatchesResults =
    topLeadId === undefined || normalizedResults.some((r) => r.incident_id === topLeadId);

  const serverResultQuality: SearchResultQuality = isPlainObject(payload.meta.resultQuality)
    ? {
        status:
          payload.meta.resultQuality.status === "strong" ||
          payload.meta.resultQuality.status === "review" ||
          payload.meta.resultQuality.status === "low_confidence"
            ? payload.meta.resultQuality.status
            : "review",
        summary:
          readOptionalString(payload.meta.resultQuality.summary) ??
          "Trace returned results that still need operator review.",
        suggestions: readStringArray(payload.meta.resultQuality.suggestions),
      }
    : {
        status: "review",
        summary: "Trace returned results that still need operator review.",
        suggestions: [],
      };

  const guardedResultQuality = applySearchResultGuardrails(
    queryText,
    normalizedResults,
    topLeadMatchesResults
      ? serverResultQuality
      : {
          status: serverResultQuality.status === "low_confidence" ? "low_confidence" : "review",
          summary:
            "Trace returned a top-lead reference that did not match the packaged results, so this run needs operator review before handoff.",
          suggestions: [
            "Review the first ranked result manually before relying on the lead reference.",
            "Retry the search if the lead reference and packaged rows remain inconsistent.",
          ],
        },
  );
  const sanitizedResults = sanitizeResultScores(normalizedResults);
  const handoffReadiness = alignHandoffReadinessWithQuality(
    normalizeHandoffReadiness(payload.meta.handoffReadiness),
    guardedResultQuality,
  );

  return {
    queryText,
    appliedFilter: {
      summary: requireString(payload.appliedFilter.summary),
      filters: normalizeAppliedTypedFiltersPayload(payload.appliedFilter.filters),
    },
    results: sanitizedResults,
    meta: {
      tookMs: requireFiniteNumber(payload.meta.tookMs),
      resultCount: sanitizedResults.length,
      queryMode: requireString(payload.meta.queryMode),
      rankingStrategy:
        readOptionalString(payload.meta.rankingStrategy) ?? "score_desc",
      topLeadIncidentId: topLeadMatchesResults ? topLeadId : undefined,
      datasetLabel:
        readOptionalString(payload.meta.datasetLabel) ?? DEFAULT_DATASET_LABEL,
      datasetKind: normalizeDatasetKind(payload.meta.datasetKind),
      hasFallbackProvenance:
        payload.meta.hasFallbackProvenance === true ||
        sanitizedResults.some((result) => result.provenanceSource === "synthesized"),
      handoffReadiness,
      confidenceReasoning: readStringArray(payload.meta.confidenceReasoning),
      resultQuality: guardedResultQuality,
    },
  };
}

function normalizeHealthState(payload: unknown, ready: boolean): HealthState {
  const responseRecord = isPlainObject(payload) ? payload : {};
  const capabilitiesRecord = isPlainObject(responseRecord.capabilities)
    ? responseRecord.capabilities
    : {};

  return {
    ready,
    label:
      readOptionalString(responseRecord.label) ??
      (ready ? "Ready for live demo" : "Degraded"),
    capabilities: {
      scopeInterpretation: capabilitiesRecord.scopeInterpretation === true,
    },
  };
}

function normalizeScopeInterpretationResponse(
  payload: unknown,
): ScopeInterpretationSuggestion {
  if (!isPlainObject(payload)) {
    throw new Error(INVALID_SCOPE_INTERPRETATION_RESPONSE_MESSAGE);
  }

  const rawSuggested = isPlainObject(payload.suggestedFilters) ? payload.suggestedFilters : {};
  const sanitized = sanitizeScopeSuggestedFilters(rawSuggested);

  const unresolvedSignals = readStringArray(payload.unresolvedSignals)
    .map((entry) => clipPlainText(entry, 520))
    .filter((entry) => entry.length > 0);
  const serverWarnings = readStringArray(payload.warnings)
    .map((entry) => clipPlainText(entry, 520))
    .filter((entry) => entry.length > 0);
  const warnings = [...sanitized.extras.clientWarnings, ...serverWarnings];

  const appliedSignals = sanitizeAppliedSignalsList(payload.appliedSignals, sanitized.filters);

  return {
    queryText: requireString(payload.queryText),
    suggestedFilters: sanitized.filters,
    summary: chooseSummaryForClientDisplay(
      payload.summary,
      sanitized.filters,
      unresolvedSignals,
      sanitized.extras,
    ),
    appliedSignals,
    unresolvedSignals,
    warnings,
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
      .filter(
        (curatedCase) =>
          isUsableCuratedCase(curatedCase) && curatedCase.fixtureAvailable !== false,
      );

    return normalized.length > 0 ? normalized : curatedCaseFallbacks;
  } catch {
    return curatedCaseFallbacks;
  }
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthState> {
  try {
    const response = await fetch(buildApiUrl("/health"), { signal });
    try {
      const payload = await response.json();
      const bodyReady =
        isPlainObject(payload) && typeof payload.ready === "boolean" ? payload.ready : undefined;
      const ready = response.ok && (bodyReady === undefined ? true : bodyReady);
      return normalizeHealthState(payload, ready);
    } catch {
      return normalizeHealthState(undefined, response.ok);
    }
  } catch {
    return normalizeHealthState(undefined, false);
  }
}

export async function searchTrace(
  request: ApiSearchRequest,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const deadline = createDeadlineController(SEARCH_HTTP_TIMEOUT_MS);
  const combined = combineAbortSignals(signal, deadline.signal);

  try {
    const response = await fetch(buildApiUrl("/search"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: combined,
    });

    if (!response.ok) {
      throw new SearchApiError({
        message: await readErrorMessage(response),
        status: response.status,
      });
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
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (error instanceof SearchApiError) {
      throw error;
    }
    if (isAbortLikeError(error)) {
      throw new SearchApiError({
        message:
          "The search request timed out before Trace finished assembling results. You can retry once the network settles.",
        isTimeout: true,
      });
    }
    if (error instanceof TypeError) {
      throw new SearchApiError({
        message:
          error.message ||
          "Trace could not reach the search service. Check connectivity and try again.",
        isNetworkError: true,
      });
    }
    throw error;
  } finally {
    deadline.cancel();
  }
}

export async function interpretScope(
  request: ScopeInterpretationRequest,
  signal?: AbortSignal,
): Promise<ScopeInterpretationSuggestion> {
  const deadline = createDeadlineController(SCOPE_INTERPRETATION_HTTP_TIMEOUT_MS);
  const combined = combineAbortSignals(signal, deadline.signal);

  try {
    const response = await fetch(buildApiUrl("/interpret-scope"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: combined,
    });

    if (!response.ok) {
      const message = await readErrorMessage(response);
      throw new Error(toUserFacingScopeInterpretationError(message, response.status));
    }

    try {
      const payload = await response.json();
      return normalizeScopeInterpretationResponse(payload);
    } catch (error) {
      throw new Error(
        toUserFacingScopeInterpretationError(error instanceof Error ? error.message : undefined),
      );
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (isAbortLikeError(error)) {
      throw new Error(
        toUserFacingScopeInterpretationError(
          error instanceof Error ? error.message : "Request timed out",
          408,
        ),
      );
    }
    if (error instanceof TypeError) {
      throw new Error(toUserFacingScopeInterpretationError(error.message));
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(toUserFacingScopeInterpretationError(undefined));
  } finally {
    deadline.cancel();
  }
}
