import { buildWhyThisMatched } from "./explanations.js";
import { loadCuratedCases } from "./cases.js";
import { embedText, resolveEmbeddingConfig } from "./embeddings.js";
import {
  serializeTypedFilters,
  type NormalizedTypedSearchFilters,
} from "./filters.js";
import { compileUnsupportedDemoCityRules } from "../shared/demo-unsupported-cities.js";
import {
  interpretScope,
  scopeInterpretationAvailable,
} from "./scope-interpreter.js";
import {
  APP_DEFAULT_LIMIT,
  APP_LIMIT_MAX,
  APP_INTERPRET_SCOPE_QUERY_MAX_CHARS,
  FATAL_ERROR_MESSAGE_CHARS,
  FetchLike,
  HttpError,
  generateRequestId,
  isPlainObject,
  normalizeForPreview,
  safePreview,
  truncate,
} from "./common.js";
import { hydrateRuntimeSecrets, type SecretClientLike } from "./secrets.js";
import { callSearch } from "./search-client.js";
import {
  AppDataClassification,
  AppDatasetKind,
  AppHandoffReadiness,
  AppProvenanceFallbackField,
  AppRedactionStatus,
  AppSearchResponse,
  AppSearchResult,
  AppResultQuality,
  AppliedTypedFiltersPublic,
  SearchBackendRow,
  SearchRequest,
} from "./search-types.js";

export type ApiGatewayLikeEvent = {
  version?: string;
  rawPath?: string;
  path?: string;
  routeKey?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
  httpMethod?: string;
};

export type ApiGatewayLikeResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

type AppApiDependencies = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  requestIdFactory?: () => string;
  secretClient?: SecretClientLike;
};

type SearchRequestBody = {
  queryText: string;
  filters?: unknown;
  limit?: number;
  retrievalStrategy?: "semantic_only";
};

type InterpretScopeRequestBody = {
  queryText: string;
};

const SEARCH_BODY_KEYS = new Set<keyof SearchRequestBody>([
  "queryText",
  "filters",
  "limit",
  "retrievalStrategy",
]);
const INTERPRET_SCOPE_BODY_KEYS = new Set<keyof InterpretScopeRequestBody>([
  "queryText",
]);

const SUPPORTED_CITY_ALIAS_PATTERNS: Array<{
  pattern: RegExp;
  cityCode: string;
}> = [
  { pattern: /\bnew york\b|\bnyc\b/i, cityCode: "NYC-TLC" },
  { pattern: /\blondon\b/i, cityCode: "LON-TfL" },
  { pattern: /\bsan francisco\b|\bsf\b/i, cityCode: "SF-CPUC" },
  { pattern: /\bparis\b/i, cityCode: "PAR-VTC" },
  { pattern: /\bchicago\b/i, cityCode: "CHI-BACP" },
  { pattern: /\bmexico city\b/i, cityCode: "MEX-SEMOVI" },
  { pattern: /\bsao paulo\b|\bsao paolo\b/i, cityCode: "SAO-DTP" },
];

const UNSUPPORTED_CITY_PATTERNS = compileUnsupportedDemoCityRules();

const DOC_TYPE_ALIAS_PATTERNS: Array<{
  pattern: RegExp;
  docType: string;
}> = [
  {
    pattern: /\bvehicle inspection\b|\binspection audit\b|\boverdue inspection\b/i,
    docType: "Vehicle_Inspection_Audit",
  },
  {
    pattern: /\bdriver background\b|\bbackground flag\b/i,
    docType: "Driver_Background_Flag",
  },
  {
    pattern: /\binsurance lapse\b|\bcoverage gap\b/i,
    docType: "Insurance_Lapse_Report",
  },
  {
    pattern: /\bpermit renewal\b|\bcity permit\b/i,
    docType: "City_Permit_Renewal",
  },
  {
    pattern: /\bsafety incident\b|\bincident log\b/i,
    docType: "Safety_Incident_Log",
  },
  {
    pattern: /\bprivacy request\b|\bdata privacy\b/i,
    docType: "Data_Privacy_Request",
  },
];

const DEMO_DATASET_LABEL = "Trace Regulatory Demo Archive";
const DEMO_DATASET_KIND: AppDatasetKind = "regulatory_archive";
const DEMO_SOURCE_COLLECTION = "trace-demo-regulatory-archive";
const APP_SEARCH_RESULT_COLUMNS = [
  "incident_id",
  "timestamp",
  "city_code",
  "doc_type",
  "text_content",
  "source_record_id",
  "source_collection",
  "source_excerpt",
  "data_classification",
  "redaction_status",
  "dataset_label",
  "dataset_kind",
] as const;
const SOURCE_EXCERPT_MAX_CHARS = 280;
const SCORE_MIN = 0;
const SCORE_MAX = 1;
const STRONG_RESULT_SCORE_MIN = 0.6;
const STRONG_QUERY_OVERLAP_RATIO_MIN = 0.34;
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
  "of",
  "on",
  "or",
  "recent",
  "report",
  "reports",
  "that",
  "the",
  "to",
  "with",
]);

type MappedSearchResult = {
  result: AppSearchResult;
  usedFallbackProvenance: boolean;
  usedFallbackDatasetMeta: boolean;
  datasetLabel?: string;
  datasetKind?: AppDatasetKind;
};

type DerivedDatasetMeta = {
  datasetLabel: string;
  datasetKind: AppDatasetKind;
  mixedDatasets: boolean;
  usedDemoAdapter: boolean;
};

function validateObjectKeys(
  label: string,
  raw: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): void {
  for (const key of Object.keys(raw)) {
    if (allowedKeys.has(key)) {
      continue;
    }
    throw new HttpError(400, "INVALID_REQUEST", `${label}.${key} is not supported.`);
  }
}

function jsonResponse(
  statusCode: number,
  requestId: string,
  body: Record<string, unknown>
): ApiGatewayLikeResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
    body: JSON.stringify(body),
  };
}

function errorResponse(error: unknown, requestId: string): ApiGatewayLikeResult {
  if (error instanceof HttpError) {
    return jsonResponse(error.status, requestId, {
      error: {
        code: error.code,
        message: error.expose
          ? safePreview(error.message, 220)
          : "Request failed.",
      },
    });
  }

  const message =
    error instanceof Error
      ? truncate(normalizeForPreview(error.message), FATAL_ERROR_MESSAGE_CHARS)
      : truncate(normalizeForPreview(String(error)), FATAL_ERROR_MESSAGE_CHARS);

  console.error(
    "[App API Error]",
    JSON.stringify({
      kind: "request_failure",
      requestId,
      message,
    })
  );

  return jsonResponse(500, requestId, {
    error: {
      code: "INTERNAL",
      message: "Internal server error.",
    },
  });
}

function requestMethod(event: ApiGatewayLikeEvent): string {
  return (
    event.requestContext?.http?.method ??
    event.httpMethod ??
    event.routeKey?.split(" ", 2)[0] ??
    "GET"
  ).toUpperCase();
}

function requestPath(event: ApiGatewayLikeEvent): string {
  return event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? "/";
}

function parseJsonBody(event: ApiGatewayLikeEvent): unknown {
  if (!event.body) {
    throw new HttpError(400, "EMPTY_BODY", "Request body is required.");
  }
  if (event.isBase64Encoded) {
    throw new HttpError(
      400,
      "INVALID_BODY_ENCODING",
      "Base64-encoded request bodies are not supported."
    );
  }
  try {
    return JSON.parse(event.body) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

function resolveSearchQueryMode(params: {
  retrievalStrategy?: "semantic_only";
  sqlFilter: string;
}): "semantic_only" | "scoped_hybrid" {
  if (params.retrievalStrategy === "semantic_only") {
    return "semantic_only";
  }
  return params.sqlFilter.trim().length > 0 ? "scoped_hybrid" : "semantic_only";
}

function validateSearchBody(raw: unknown): SearchRequestBody {
  if (!isPlainObject(raw)) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must be an object.");
  }

  if ("sql_filter" in raw) {
    throw new HttpError(
      400,
      "UNSUPPORTED_FIELD",
      "sql_filter is not accepted. Use typed filters instead."
    );
  }

  validateObjectKeys("body", raw, SEARCH_BODY_KEYS);

  if (typeof raw.queryText !== "string" || raw.queryText.trim().length === 0) {
    throw new HttpError(
      400,
      "INVALID_QUERY",
      "queryText must be a non-empty string."
    );
  }

  let limit = APP_DEFAULT_LIMIT;
  if ("limit" in raw && raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit)) {
      throw new HttpError(400, "INVALID_LIMIT", "limit must be an integer.");
    }
    limit = raw.limit;
  }
  if (limit < 1 || limit > APP_LIMIT_MAX) {
    throw new HttpError(
      400,
      "INVALID_LIMIT",
      `limit must be between 1 and ${APP_LIMIT_MAX}.`
    );
  }

  let retrievalStrategy: "semantic_only" | undefined;
  if ("retrievalStrategy" in raw && raw.retrievalStrategy !== undefined) {
    if (raw.retrievalStrategy !== "semantic_only") {
      throw new HttpError(
        400,
        "INVALID_RETRIEVAL_STRATEGY",
        'retrievalStrategy must be omitted or set to "semantic_only".'
      );
    }
    retrievalStrategy = "semantic_only";
  }

  return {
    queryText: raw.queryText.trim(),
    filters: raw.filters,
    limit,
    retrievalStrategy,
  };
}

function validateInterpretScopeBody(raw: unknown): InterpretScopeRequestBody {
  if (!isPlainObject(raw)) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must be an object.");
  }

  validateObjectKeys("body", raw, INTERPRET_SCOPE_BODY_KEYS);

  if (typeof raw.queryText !== "string" || raw.queryText.trim().length === 0) {
    throw new HttpError(
      400,
      "INVALID_QUERY",
      "queryText must be a non-empty string."
    );
  }

  const trimmedQueryText = raw.queryText.trim();
  if (trimmedQueryText.length > APP_INTERPRET_SCOPE_QUERY_MAX_CHARS) {
    throw new HttpError(
      400,
      "INVALID_QUERY",
      `queryText must be at most ${APP_INTERPRET_SCOPE_QUERY_MAX_CHARS} characters.`
    );
  }

  return {
    queryText: trimmedQueryText,
  };
}

function compactAppliedTypedFiltersForPublic(
  filters: NormalizedTypedSearchFilters
): AppliedTypedFiltersPublic | undefined {
  const out: AppliedTypedFiltersPublic = {};
  if (filters.cityCode) {
    out.cityCode = filters.cityCode;
  }
  if (filters.docType) {
    out.docType = filters.docType;
  }
  if (filters.startTimestamp) {
    out.startTimestamp = filters.startTimestamp;
  }
  if (filters.endTimestamp) {
    out.endTimestamp = filters.endTimestamp;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readOptionalStringField(
  row: SearchBackendRow,
  fieldNames: readonly string[]
): string | undefined {
  for (const fieldName of fieldNames) {
    const value = row[fieldName];
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return undefined;
}

function normalizeFieldToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeDataClassification(
  value: string | undefined
): AppDataClassification | undefined {
  if (!value) {
    return undefined;
  }
  switch (normalizeFieldToken(value)) {
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
    case "unknown":
    case "unspecified":
    case "unclassified":
      return "unknown";
    default:
      return undefined;
  }
}

function normalizeRedactionStatus(
  value: string | undefined
): AppRedactionStatus | undefined {
  if (!value) {
    return undefined;
  }
  switch (normalizeFieldToken(value)) {
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
    case "unknown":
    case "unspecified":
      return "unknown";
    default:
      return undefined;
  }
}

function normalizeDatasetKind(value: string | undefined): AppDatasetKind | undefined {
  if (!value) {
    return undefined;
  }
  switch (normalizeFieldToken(value)) {
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
      return undefined;
  }
}

function buildSourceExcerpt(
  explicitExcerpt: string | undefined,
  textContent: string | undefined
): { value: string; usedDemoAdapter: boolean } {
  const sourceText = explicitExcerpt ?? textContent;
  if (!sourceText) {
    return {
      value: "No source excerpt was supplied by the backend for this record.",
      usedDemoAdapter: true,
    };
  }
  return {
    value: truncate(normalizeForPreview(sourceText), SOURCE_EXCERPT_MAX_CHARS),
    usedDemoAdapter: explicitExcerpt === undefined,
  };
}

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
  return tokenizeMeaningfulTerms(queryText).flatMap((token) =>
    normalizeTokenForOverlap(token)
  );
}

function buildResultVocabulary(result: AppSearchResult): Set<string> {
  return new Set(
    tokenizeMeaningfulTerms(
      [
        result.incident_id,
        result.city_code,
        result.doc_type,
        result.why_this_matched,
        result.text_content ?? "",
      ].join(" ")
    ).flatMap((token) => normalizeTokenForOverlap(token))
  );
}

function countQueryOverlap(queryTokens: string[], result: AppSearchResult): number {
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

function deriveDatasetMeta(mappedResults: MappedSearchResult[]): DerivedDatasetMeta {
  const labels = [...new Set(mappedResults.map((entry) => entry.datasetLabel).filter(Boolean))];
  const kinds = [...new Set(mappedResults.map((entry) => entry.datasetKind).filter(Boolean))];

  const mixedDatasets = labels.length > 1 || kinds.length > 1;
  if (mixedDatasets) {
    return {
      datasetLabel: "Mixed Trace search datasets",
      datasetKind: "mixed",
      mixedDatasets: true,
      usedDemoAdapter: false,
    };
  }

  return {
    datasetLabel: labels[0] ?? DEMO_DATASET_LABEL,
    datasetKind: kinds[0] ?? DEMO_DATASET_KIND,
    mixedDatasets: false,
    usedDemoAdapter: mappedResults.some((entry) => entry.usedFallbackDatasetMeta),
  };
}

function deriveHandoffReadiness(
  resultQuality: AppResultQuality,
  mappedResults: MappedSearchResult[],
  datasetMeta: DerivedDatasetMeta
): AppHandoffReadiness {
  if (mappedResults.length === 0 || resultQuality.status === "low_confidence") {
    return "not_trustworthy";
  }

  const usesDemoSeededMetadata =
    datasetMeta.datasetLabel === DEMO_DATASET_LABEL ||
    mappedResults.some(({ result }) => result.sourceCollection === DEMO_SOURCE_COLLECTION);

  const hasProvenanceGaps =
    datasetMeta.mixedDatasets ||
    datasetMeta.usedDemoAdapter ||
    usesDemoSeededMetadata ||
    mappedResults.some(
      ({ result, usedFallbackProvenance }) =>
        usedFallbackProvenance ||
        result.dataClassification === "unknown" ||
        result.dataClassification === "confidential" ||
        result.dataClassification === "restricted" ||
        result.redactionStatus === "unknown"
    );

  if (resultQuality.status === "strong" && !hasProvenanceGaps) {
    return "ready";
  }

  return "review_only";
}

function buildConfidenceReasoning(
  resultQuality: AppResultQuality,
  mappedResults: MappedSearchResult[],
  datasetMeta: DerivedDatasetMeta,
  handoffReadiness: AppHandoffReadiness
): string[] {
  const reasons = [resultQuality.summary];
  const usesDemoSeededMetadata =
    datasetMeta.datasetLabel === DEMO_DATASET_LABEL ||
    mappedResults.some(({ result }) => result.sourceCollection === DEMO_SOURCE_COLLECTION);

  if (mappedResults.length === 0) {
    reasons.push(
      "No evidence records were returned, so this run did not surface a result package to review or hand off."
    );
  }

  if (datasetMeta.mixedDatasets) {
    reasons.push(
      "Results span multiple dataset labels or kinds, so each record needs record-level provenance review before handoff."
    );
  } else if (datasetMeta.usedDemoAdapter) {
    reasons.push(
      `Dataset metadata is currently using the temporary demo adapter (${datasetMeta.datasetLabel} / ${datasetMeta.datasetKind}) until the backend emits explicit dataset fields for every row.`
    );
  } else {
    reasons.push(
      `All returned rows point to dataset ${datasetMeta.datasetLabel} (${datasetMeta.datasetKind}).`
    );
  }

  const usedResultAdapter = mappedResults.some(
    (entry) => entry.usedFallbackProvenance
  );
  if (usedResultAdapter) {
    reasons.push(
      "At least one result is explicitly flagged with fallback provenance fields because the backend omitted part of the record-level provenance payload."
    );
  } else if (mappedResults.length > 0) {
    reasons.push(
      "Each returned result carried explicit provenance, classification, and redaction fields from the backend."
    );
  }

  if (usesDemoSeededMetadata) {
    reasons.push(
      "The current dataset metadata is still coming from the demo-seeded archive labels, so Trace is keeping this package in review instead of auto-promoting it to handoff-ready."
    );
  }

  const hasUnknownTrustLabels = mappedResults.some(
    ({ result }) =>
      result.dataClassification === "unknown" || result.redactionStatus === "unknown"
  );
  if (hasUnknownTrustLabels) {
    reasons.push(
      "Some records still have unknown classification or redaction status, so human review is required before any downstream sharing."
    );
  }

  if (handoffReadiness === "not_trustworthy") {
    reasons.push(
      mappedResults.length === 0
        ? "Trace is not issuing a review or handoff package because the run returned no evidence material."
        : "Trace is blocking handoff because retrieval confidence did not clear the minimum trust threshold for this run."
    );
  } else if (handoffReadiness === "review_only") {
    reasons.push(
      "Trace can support operator review here, but the server is withholding handoff readiness until the trust gaps are cleared."
    );
  } else {
    reasons.push("Trace marks this evidence package ready for workflow handoff.");
  }

  return reasons;
}

function mapSearchResultRow(
  row: SearchBackendRow,
  queryText: string,
  filters: ReturnType<typeof serializeTypedFilters>["filters"]
): MappedSearchResult {
  const incidentId = row.incident_id;
  const timestamp = row.timestamp;
  const cityCode = row.city_code;
  const docType = row.doc_type;
  const score = row.score;
  const textContent = row.text_content;

  if (
    typeof incidentId !== "string" ||
    typeof timestamp !== "string" ||
    typeof cityCode !== "string" ||
    typeof docType !== "string" ||
    typeof score !== "number" ||
    !Number.isFinite(score)
  ) {
    throw new HttpError(
      502,
      "INVALID_BACKEND_RESPONSE",
      "Search backend returned an invalid result row.",
      { expose: false }
    );
  }

  if (textContent !== undefined && typeof textContent !== "string") {
    throw new HttpError(
      502,
      "INVALID_BACKEND_RESPONSE",
      "Search backend returned an invalid text payload.",
      { expose: false }
    );
  }

  const backendSourceRecordId = readOptionalStringField(row, [
    "source_record_id",
    "sourceRecordId",
    "record_id",
    "recordId",
    "document_id",
    "documentId",
  ]);
  const sourceRecordId = backendSourceRecordId ?? incidentId;
  const backendSourceCollection = readOptionalStringField(row, [
    "source_collection",
    "sourceCollection",
    "collection",
    "collection_name",
    "collectionName",
  ]);
  const sourceCollection = backendSourceCollection ?? DEMO_SOURCE_COLLECTION;
  const backendSourceExcerpt = readOptionalStringField(row, [
    "source_excerpt",
    "sourceExcerpt",
    "record_excerpt",
    "recordExcerpt",
    "excerpt",
  ]);
  const sourceExcerpt = buildSourceExcerpt(backendSourceExcerpt, textContent);
  const backendDataClassification = readOptionalStringField(row, [
    "data_classification",
    "dataClassification",
    "classification",
    "security_classification",
    "securityClassification",
  ]);
  const dataClassification =
    normalizeDataClassification(backendDataClassification) ?? "unknown";
  const backendRedactionStatus = readOptionalStringField(row, [
    "redaction_status",
    "redactionStatus",
    "redaction",
    "redaction_state",
    "redactionState",
  ]);
  const redactionStatus =
    normalizeRedactionStatus(backendRedactionStatus) ?? "unknown";
  const datasetLabel = readOptionalStringField(row, [
    "dataset_label",
    "datasetLabel",
    "dataset_name",
    "datasetName",
  ]);
  const datasetKind = normalizeDatasetKind(
    readOptionalStringField(row, ["dataset_kind", "datasetKind"])
  );

  const fallbackFields: AppProvenanceFallbackField[] = [];
  if (backendSourceRecordId === undefined) {
    fallbackFields.push("sourceRecordId");
  }
  if (backendSourceCollection === undefined) {
    fallbackFields.push("sourceCollection");
  }
  if (sourceExcerpt.usedDemoAdapter) {
    fallbackFields.push("sourceExcerpt");
  }
  if (backendDataClassification === undefined) {
    fallbackFields.push("dataClassification");
  }
  if (backendRedactionStatus === undefined) {
    fallbackFields.push("redactionStatus");
  }

  const usedFallbackProvenance = fallbackFields.length > 0;
  const usedFallbackDatasetMeta = datasetLabel === undefined || datasetKind === undefined;

  return {
    result: {
      incident_id: incidentId,
      timestamp,
      city_code: cityCode,
      doc_type: docType,
      text_content: textContent,
      score,
      why_this_matched: buildWhyThisMatched({
        queryText,
        filters,
        row: {
          incident_id: incidentId,
          timestamp,
          city_code: cityCode,
          doc_type: docType,
          text_content: textContent,
        },
      }),
      sourceRecordId,
      sourceCollection,
      sourceExcerpt: sourceExcerpt.value,
      dataClassification,
      redactionStatus,
      provenanceSource: usedFallbackProvenance ? "synthesized" : "backend",
      provenance: {
        usedFallback: usedFallbackProvenance,
        fallbackFields,
      },
    },
    usedFallbackProvenance,
    usedFallbackDatasetMeta,
    datasetLabel,
    datasetKind,
  };
}

function sortResultsByScoreDescending(results: AppSearchResult[]): AppSearchResult[] {
  return [...results].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.incident_id.localeCompare(right.incident_id);
  });
}

function detectQueryExpectedCity(queryText: string): string | undefined {
  for (const { pattern, cityCode } of SUPPORTED_CITY_ALIAS_PATTERNS) {
    if (pattern.test(queryText)) {
      return cityCode;
    }
  }
  return undefined;
}

function detectUnsupportedCityMention(queryText: string): string | undefined {
  for (const { pattern, label } of UNSUPPORTED_CITY_PATTERNS) {
    if (pattern.test(queryText)) {
      return label;
    }
  }
  return undefined;
}

function detectQueryExpectedDocType(queryText: string): string | undefined {
  for (const { pattern, docType } of DOC_TYPE_ALIAS_PATTERNS) {
    if (pattern.test(queryText)) {
      return docType;
    }
  }
  return undefined;
}

/**
 * Derives result quality from the top lead and query signals.
 * IMPORTANT: `sortedResults` must be pre-sorted by score descending — callers
 * are responsible for ordering before passing here. `sortedResults[0]` is
 * treated as the highest-scoring record.
 */
function assessResultQuality(
  queryText: string,
  filters: NormalizedTypedSearchFilters,
  sortedResults: AppSearchResult[]
): AppResultQuality {
  const results = sortedResults;
  if (results.length === 0) {
    return {
      status: "low_confidence",
      summary:
        "No evidence records landed inside the current request, so this run produced no material for review or handoff.",
      suggestions: [
        "Broaden the wording or remove one filter.",
        "Try the recommended demo path to see a known-good investigation.",
      ],
    };
  }

  const topLead = results[0];
  if (topLead.score < SCORE_MIN || topLead.score > SCORE_MAX) {
    return {
      status: "low_confidence",
      summary:
        "Trace received an out-of-range ranking score from retrieval, so this result set is not safe to hand off.",
      suggestions: [
        "Rerun the request after tightening the scope.",
        "Treat this run as untrusted until retrieval scores are calibrated.",
      ],
    };
  }

  const unsupportedCity = detectUnsupportedCityMention(queryText);
  if (unsupportedCity) {
    return {
      status: "low_confidence",
      summary: `${unsupportedCity} is outside the trusted city mappings in this demo build, so Trace cannot defend this result set yet.`,
      suggestions: [
        "Switch to a supported city or run the recommended demo.",
        "Use Interpret scope to confirm a safe city/document slice before searching.",
      ],
    };
  }

  const expectedCity = detectQueryExpectedCity(queryText);
  if (
    expectedCity &&
    !filters.cityCode &&
    topLead.city_code.toUpperCase() !== expectedCity.toUpperCase()
  ) {
    return {
      status: "low_confidence",
      summary: `The request points to ${expectedCity}, but the strongest result landed in ${topLead.city_code}.`,
      suggestions: [
        "Set the city filter explicitly or use Interpret scope first.",
        "Tighten the request before carrying anything forward.",
      ],
    };
  }

  const expectedDocType = detectQueryExpectedDocType(queryText);
  if (expectedDocType && !filters.docType && topLead.doc_type !== expectedDocType) {
    return {
      status: "low_confidence",
      summary: `The request implies ${expectedDocType}, but the strongest result is ${topLead.doc_type}.`,
      suggestions: [
        "Set a document type before rerunning this search.",
        "Use the recommended demo path if you need a clean handoff example.",
      ],
    };
  }

  const hasPrimaryScope = Boolean(filters.cityCode || filters.docType);
  const hasFullPrimaryScope = Boolean(filters.cityCode && filters.docType);
  const hasTemporalScope = Boolean(filters.startTimestamp || filters.endTimestamp);
  const queryTokens = buildQueryVocabulary(queryText);
  const maxOverlap = queryTokens.length > 0 ? countQueryOverlap(queryTokens, topLead) : 0;
  const overlapRatio = queryTokens.length > 0 ? maxOverlap / queryTokens.length : 0;

  if (queryTokens.length >= 3 && maxOverlap === 0) {
    return {
      status: "low_confidence",
      summary:
        "Trace did not find a top lead that visibly overlaps the investigation request, so this run is not safe to hand off.",
      suggestions: [
        "Rewrite the question using the exact event or document language you expect in the archive.",
        "Tighten the scope before trusting the next retrieval pass.",
      ],
    };
  }

  if (
    hasFullPrimaryScope &&
    topLead.score >= STRONG_RESULT_SCORE_MIN &&
    (queryTokens.length === 0 || overlapRatio >= STRONG_QUERY_OVERLAP_RATIO_MIN)
  ) {
    return {
      status: "strong",
      summary:
        "The current run stayed inside an explicit city and document scope and returned a lead that aligns cleanly enough with the request to prepare for handoff review.",
      suggestions: [
        "Review the top lead and supporting records together before escalation.",
      ],
    };
  }

  return {
    status: "review",
    summary:
      hasPrimaryScope || hasTemporalScope
        ? "Trace found a plausible lead inside the requested slice, but the server is keeping this run in review while the scope or evidence remains partial."
        : "Trace found plausible matches, but this run is still open-scope and should be tightened before handoff.",
    suggestions: [
      hasPrimaryScope || hasTemporalScope
        ? "Review the lead manually and tighten the scope further if the excerpt does not clearly support the ask."
        : "Use Interpret scope or add a city/document filter before escalating.",
      "Treat this as exploratory evidence rather than a final handoff.",
    ],
  };
}

function buildHealthPayload(env: NodeJS.ProcessEnv): {
  ok: boolean;
  service: string;
  ready: boolean;
  checks: Record<string, boolean>;
  capabilities: Record<string, boolean>;
} {
  const hasSearchUrl = Boolean(env.TRACE_SEARCH_URL?.trim()) || Boolean(env.TRACE_MCP_MOCK);
  let embeddingsConfigured = false;
  try {
    const embeddingConfig = resolveEmbeddingConfig(env);
    embeddingsConfigured =
      embeddingConfig.useMockEmbeddings || Boolean(env.OPENAI_API_KEY?.trim());
  } catch {
    embeddingsConfigured = false;
  }
  const scopeInterpretation = scopeInterpretationAvailable(env);

  const ready = hasSearchUrl && embeddingsConfigured;
  return {
    ok: ready,
    service: "trace-app-api",
    ready,
    checks: {
      traceSearchUrl: hasSearchUrl,
      embeddingsConfigured,
    },
    capabilities: {
      scopeInterpretation,
    },
  };
}

async function handleSearch(
  event: ApiGatewayLikeEvent,
  deps: AppApiDependencies,
  requestId: string
): Promise<ApiGatewayLikeResult> {
  const body = validateSearchBody(parseJsonBody(event));
  const appliedFilter =
    body.retrievalStrategy === "semantic_only"
      ? serializeTypedFilters(undefined)
      : serializeTypedFilters(body.filters);

  const queryVector = await embedText(body.queryText, {
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const searchRequest: SearchRequest = {
    query_vector: queryVector,
    sql_filter: appliedFilter.sqlFilter,
    limit: body.limit ?? APP_DEFAULT_LIMIT,
    include_text: true,
    columns: [...APP_SEARCH_RESULT_COLUMNS],
  };

  const searchResponse = await callSearch(searchRequest, {
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const publicAppliedFilters = compactAppliedTypedFiltersForPublic(appliedFilter.filters);
  const mappedResults = searchResponse.results.map((row) =>
    mapSearchResultRow(row, body.queryText, appliedFilter.filters)
  );
  const orderedResults = sortResultsByScoreDescending(
    mappedResults.map((entry) => entry.result)
  );
  const resultQuality = assessResultQuality(
    body.queryText,
    appliedFilter.filters,
    orderedResults
  );
  const datasetMeta = deriveDatasetMeta(mappedResults);
  const handoffReadiness = deriveHandoffReadiness(
    resultQuality,
    mappedResults,
    datasetMeta
  );
  const confidenceReasoning = buildConfidenceReasoning(
    resultQuality,
    mappedResults,
    datasetMeta,
    handoffReadiness
  );

  const responseBody: AppSearchResponse = {
    queryText: body.queryText,
    appliedFilter: {
      summary: appliedFilter.summary,
      ...(publicAppliedFilters ? { filters: publicAppliedFilters } : {}),
    },
    results: orderedResults,
    meta: {
      tookMs: searchResponse.took_ms,
      resultCount: orderedResults.length,
      queryMode: resolveSearchQueryMode({
        retrievalStrategy: body.retrievalStrategy,
        sqlFilter: appliedFilter.sqlFilter,
      }),
      rankingStrategy: "score_desc",
      topLeadIncidentId: orderedResults[0]?.incident_id,
      datasetLabel: datasetMeta.datasetLabel,
      datasetKind: datasetMeta.datasetKind,
      hasFallbackProvenance: mappedResults.some(
        (entry) => entry.usedFallbackProvenance || entry.usedFallbackDatasetMeta
      ),
      handoffReadiness,
      confidenceReasoning,
      resultQuality,
    },
  };

  console.info(
    "[App API]",
    JSON.stringify({
      kind: "search_success",
      requestId,
      resultCount: responseBody.meta.resultCount,
      tookMs: responseBody.meta.tookMs,
      appliedSummaryPreview: safePreview(responseBody.appliedFilter.summary, 160),
      appliedFilterFields: publicAppliedFilters ? Object.keys(publicAppliedFilters) : [],
    })
  );

  return jsonResponse(200, requestId, responseBody as unknown as Record<string, unknown>);
}

async function handleInterpretScope(
  event: ApiGatewayLikeEvent,
  deps: AppApiDependencies,
  requestId: string
): Promise<ApiGatewayLikeResult> {
  const body = validateInterpretScopeBody(parseJsonBody(event));
  const responseBody = await interpretScope(body.queryText, {
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    requestId,
  });
  return jsonResponse(200, requestId, responseBody as unknown as Record<string, unknown>);
}

export function createAppApiHandler(deps: AppApiDependencies = {}) {
  const env = deps.env ?? process.env;
  let runtimeEnvPromise: Promise<NodeJS.ProcessEnv> | undefined;

  function resolveRuntimeEnv(): Promise<NodeJS.ProcessEnv> {
    if (!runtimeEnvPromise) {
      runtimeEnvPromise = hydrateRuntimeSecrets(env, {
        secretClient: deps.secretClient,
      }).catch((err: unknown) => {
        // Reset so the next request retries instead of permanently serving a
        // rejected promise on this warm Lambda instance.
        runtimeEnvPromise = undefined;
        throw err;
      });
    }
    return runtimeEnvPromise;
  }

  return async function handler(
    event: ApiGatewayLikeEvent
  ): Promise<ApiGatewayLikeResult> {
    const requestId = (deps.requestIdFactory ?? generateRequestId)();
    try {
      const method = requestMethod(event);
      const path = requestPath(event);

      if (method === "GET" && path === "/api/health") {
        const healthEnv = await resolveRuntimeEnv().catch((error) => {
          const message =
            error instanceof Error
              ? truncate(normalizeForPreview(error.message), FATAL_ERROR_MESSAGE_CHARS)
              : truncate(normalizeForPreview(String(error)), FATAL_ERROR_MESSAGE_CHARS);
          console.error(
            "[App API Error]",
            JSON.stringify({
              kind: "health_secret_resolution_failure",
              requestId,
              message,
            })
          );
          return env;
        });
        const payload = buildHealthPayload(healthEnv);
        return jsonResponse(payload.ready ? 200 : 503, requestId, payload);
      }

      if (method === "GET" && path === "/api/cases") {
        return jsonResponse(200, requestId, {
          cases: loadCuratedCases(),
        });
      }

      if (method === "POST" && path === "/api/search") {
        const runtimeEnv = await resolveRuntimeEnv();
        return await handleSearch(event, { ...deps, env: runtimeEnv }, requestId);
      }

      if (method === "POST" && path === "/api/interpret-scope") {
        const runtimeEnv = await resolveRuntimeEnv().catch((error) => {
          const message =
            error instanceof Error
              ? truncate(normalizeForPreview(error.message), FATAL_ERROR_MESSAGE_CHARS)
              : truncate(normalizeForPreview(String(error)), FATAL_ERROR_MESSAGE_CHARS);
          console.error(
            "[App API Error]",
            JSON.stringify({
              kind: "interpret_scope_secret_resolution_failure",
              requestId,
              message,
            })
          );
          return env;
        });
        return await handleInterpretScope(event, { ...deps, env: runtimeEnv }, requestId);
      }

      if (
        path === "/api/search" ||
        path === "/api/cases" ||
        path === "/api/health" ||
        path === "/api/interpret-scope"
      ) {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      }

      throw new HttpError(404, "NOT_FOUND", "Route not found.");
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}
