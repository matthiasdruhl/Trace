export type SearchRequest = {
  query_vector: number[];
  sql_filter: string;
  limit: number;
  include_text: boolean;
  columns?: string[];
};

export type SearchBackendRow = Record<string, unknown>;

export type SearchResponse = {
  ok: true;
  results: SearchBackendRow[];
  query_dim: number;
  k: number;
  took_ms: number;
  stub?: string;
};

export type AppDataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted"
  | "unknown";

export type AppRedactionStatus = "none" | "partial" | "full" | "unknown";

export type AppDatasetKind =
  | "regulatory_archive"
  | "curated_case_fixture"
  | "mixed"
  | "unknown";

export type AppHandoffReadiness = "ready" | "review_only" | "not_trustworthy";

export type AppProvenanceSource = "backend" | "synthesized";

export type AppProvenanceFallbackField =
  | "sourceRecordId"
  | "sourceCollection"
  | "sourceExcerpt"
  | "dataClassification"
  | "redactionStatus";

export type AppProvenanceDisclosure = {
  usedFallback: boolean;
  fallbackFields: AppProvenanceFallbackField[];
};

export type AppSearchResult = {
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
  dataClassification: AppDataClassification;
  redactionStatus: AppRedactionStatus;
  provenanceSource: AppProvenanceSource;
  provenance: AppProvenanceDisclosure;
};

export type AppResultQuality = {
  status: "strong" | "review" | "low_confidence";
  summary: string;
  suggestions: string[];
};

/** Typed filters applied to the investigation scope — excludes raw SQL (server-side only). */
export type AppliedTypedFiltersPublic = {
  cityCode?: string;
  docType?: string;
  startTimestamp?: string;
  endTimestamp?: string;
};

export type AppSearchResponse = {
  queryText: string;
  appliedFilter: {
    summary: string;
    filters?: AppliedTypedFiltersPublic;
  };
  results: AppSearchResult[];
  meta: {
    tookMs: number;
    resultCount: number;
    /** Retrieval mode label, e.g. "live". Extend when hybrid/semantic modes are added. */
    queryMode: string;
    rankingStrategy: "score_desc";
    topLeadIncidentId?: string;
    datasetLabel: string;
    datasetKind: AppDatasetKind;
    hasFallbackProvenance: boolean;
    handoffReadiness: AppHandoffReadiness;
    confidenceReasoning: string[];
    resultQuality: AppResultQuality;
  };
};
