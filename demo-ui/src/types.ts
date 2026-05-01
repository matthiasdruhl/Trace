export type SearchFilters = {
  cityCode?: string;
  docType?: string;
  startDate?: string;
  endDate?: string;
};

export type JudgeMetric = {
  value: string;
  label: string;
  detail: string;
};

export type JudgeHeroChip = {
  label: string;
};

export type JudgeStorySection = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
};

export type JudgeArchitectureStep = {
  id: string;
  label: string;
  title: string;
  body: string;
};

export type JudgeClaimCard = {
  id: string;
  claim: string;
  verified: string;
  scope: string;
  evidenceSummary: string;
  evidencePoints: string[];
  comparison?: {
    traceLabel: string;
    traceOutcome: string;
    weakerLabel: string;
    weakerOutcome: string;
  };
  boundary: string;
};

export type JudgeDemoPreset = {
  id: string;
  title: string;
  subtitle: string;
  queryText: string;
  filters: SearchFilters;
  proofGoal: string;
  whatToLookFor: string;
};

export type ScopeInterpretationField =
  | "cityCode"
  | "docType"
  | "startDate"
  | "endDate";

export type ScopeInterpretationSignal = {
  field: ScopeInterpretationField;
  sourceText: string;
  normalizedValue: string;
  rationale: string;
};

export type ScopeInterpretationRequest = {
  queryText: string;
};

export type ScopeInterpretationSuggestion = {
  queryText: string;
  suggestedFilters: SearchFilters;
  summary: string;
  appliedSignals: ScopeInterpretationSignal[];
  unresolvedSignals: string[];
  warnings: string[];
};

export type SubmittedSearchContext = {
  queryText: string;
  filters: SearchFilters;
};

export type RetrievalStrategy = "default" | "semantic_only";

export type ApiSearchRequest = {
  queryText: string;
  filters?: {
    cityCode?: string;
    docType?: string;
    startTimestamp?: string;
    endTimestamp?: string;
  };
  limit?: number;
  /** When set, server runs nearest-neighbor retrieval without typed metadata filters (explicit semantic-only). */
  retrievalStrategy?: RetrievalStrategy;
};

export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted"
  | "unknown";

export type RedactionStatus = "none" | "partial" | "full" | "unknown";

export type DatasetKind =
  | "regulatory_archive"
  | "curated_case_fixture"
  | "mixed"
  | "unknown";

export type HandoffReadiness = "ready" | "review_only" | "not_trustworthy";

export type ProvenanceSource = "backend" | "synthesized";

export type ProvenanceFallbackField =
  | "sourceRecordId"
  | "sourceCollection"
  | "sourceExcerpt"
  | "dataClassification"
  | "redactionStatus";

export type ProvenanceDisclosure = {
  usedFallback: boolean;
  fallbackFields: ProvenanceFallbackField[];
};

export type SearchResult = {
  incident_id: string;
  timestamp: string;
  city_code: string;
  doc_type: string;
  text_content?: string;
  score: number;
  why_this_matched: string;
  sourceRecordId: string;
  sourceCollection: string;
  sourceExcerpt: string;
  dataClassification: DataClassification;
  redactionStatus: RedactionStatus;
  provenanceSource?: ProvenanceSource;
  provenance?: ProvenanceDisclosure;
};

/** Typed filters returned by `/api/search` — excludes raw SQL (server-side only). */
export type AppliedTypedFiltersApi = {
  cityCode?: string;
  docType?: string;
  startTimestamp?: string;
  endTimestamp?: string;
};

export type ResultQualityStatus = "strong" | "review" | "low_confidence";

export type SearchResultQuality = {
  status: ResultQualityStatus;
  summary: string;
  suggestions: string[];
};

export type SearchResponse = {
  queryText: string;
  appliedFilter: {
    summary: string;
    filters?: AppliedTypedFiltersApi;
  };
  results: SearchResult[];
  meta: {
    tookMs: number;
    resultCount: number;
    queryMode: string;
    rankingStrategy: string;
    topLeadIncidentId?: string;
    datasetLabel: string;
    datasetKind: DatasetKind;
    hasFallbackProvenance: boolean;
    handoffReadiness: HandoffReadiness;
    confidenceReasoning: string[];
    resultQuality: SearchResultQuality;
  };
};

export type CuratedCase = {
  id: string;
  title: string;
  subtitle?: string;
  description: string;
  queryText: string;
  filters: SearchFilters;
  fixtureAvailable?: boolean;
};

export type ApiCasePayload = {
  caseId?: unknown;
  id?: unknown;
  label?: unknown;
  title?: unknown;
  subtitle?: unknown;
  description?: unknown;
  narrative?: unknown;
  queryText?: unknown;
  query?: unknown;
  prompt?: unknown;
  filters?: unknown;
  fixtureAvailable?: unknown;
};

export type HealthState = {
  ready: boolean;
  label: string;
  capabilities: {
    scopeInterpretation: boolean;
  };
};

export type SearchStatus =
  | "idle"
  | "interpreting"
  | "ready"
  | "running"
  | "completed"
  | "no_results"
  | "low_confidence"
  | "invalid_input"
  | "service_error";

export type HandoffSummary = {
  goal: string;
  appliedScope: string;
  primaryEvidence: string;
  suggestedHandoff: string;
};

export type QueryRefinementHint = {
  title: string;
  body: string;
  blocking: boolean;
};

export type InvestigationWorkspaceModel = {
  investigationRequest: string;
  activeScope: string;
  timeWindow: string;
  queryModeLabel: string;
  resultCount: number;
  latencyLabel: string;
  submittedFilters: SearchFilters;
  topLead: SearchResult | null;
  supportingResults: SearchResult[];
  handoffSummary: HandoffSummary | null;
};
