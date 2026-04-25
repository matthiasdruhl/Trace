export type SearchRequest = {
  query_vector: number[];
  sql_filter: string;
  limit: number;
  include_text: boolean;
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

export type AppSearchResult = {
  incident_id: string;
  timestamp: string;
  city_code: string;
  doc_type: string;
  text_content?: string;
  score: number;
  why_this_matched: string;
};

export type AppSearchResponse = {
  queryText: string;
  appliedFilter: {
    sqlFilter: string;
    summary: string;
  };
  results: AppSearchResult[];
  meta: {
    tookMs: number;
    resultCount: number;
    queryMode: "live";
  };
};
