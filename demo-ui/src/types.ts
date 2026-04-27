export type SearchFilters = {
  cityCode?: string;
  docType?: string;
  startDate?: string;
  endDate?: string;
};

export type SubmittedSearchContext = {
  queryText: string;
  filters: SearchFilters;
};

export type ApiSearchRequest = {
  queryText: string;
  filters?: {
    cityCode?: string;
    docType?: string;
    startTimestamp?: string;
    endTimestamp?: string;
  };
  limit?: number;
};

export type SearchResult = {
  incident_id: string;
  timestamp: string;
  city_code: string;
  doc_type: string;
  text_content?: string;
  score: number;
  why_this_matched: string;
};

export type SearchResponse = {
  queryText: string;
  appliedFilter: {
    sqlFilter: string;
    summary: string;
  };
  results: SearchResult[];
  meta: {
    tookMs: number;
    resultCount: number;
    queryMode: string;
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
};

export type SearchStatus = "idle" | "loading" | "success" | "error";

export type HandoffSummary = {
  goal: string;
  appliedScope: string;
  primaryEvidence: string;
  suggestedHandoff: string;
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
