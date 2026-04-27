import { truncate } from "./common.js";
import { NormalizedTypedSearchFilters } from "./filters.js";

function extractSnippet(textContent?: string): string | undefined {
  if (!textContent) {
    return undefined;
  }
  const normalized = textContent.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const sentence = normalized.match(/^(.+?[.?!])(?:\s|$)/)?.[1] ?? normalized;
  return truncate(sentence, 140);
}

function buildFilterClause(filters: NormalizedTypedSearchFilters): string {
  const parts: string[] = [];
  if (filters.cityCode) {
    parts.push(`city ${filters.cityCode}`);
  }
  if (filters.docType) {
    parts.push(`document type ${filters.docType}`);
  }
  if (filters.startTimestamp) {
    parts.push(`from ${filters.startTimestamp}`);
  }
  if (filters.endTimestamp) {
    parts.push(`through ${filters.endTimestamp}`);
  }
  return parts.length > 0
    ? `Search filters: ${parts.join(", ")}.`
    : "Search filters: none.";
}

export function buildWhyThisMatched(input: {
  queryText: string;
  filters: NormalizedTypedSearchFilters;
  row: {
    incident_id: string;
    timestamp: string;
    city_code: string;
    doc_type: string;
    text_content?: string;
  };
}): string {
  const snippet = extractSnippet(input.row.text_content);
  const trimmedQuery = input.queryText.trim();

  const parts = [
    `Search request: "${truncate(trimmedQuery, 80)}".`,
    `Record: ${input.row.incident_id}, ${input.row.doc_type}, ${input.row.city_code}, ${input.row.timestamp}.`,
    buildFilterClause(input.filters),
  ];

  if (snippet) {
    parts.push(`Text preview: "${snippet}".`);
  }

  return truncate(parts.join(" "), 380);
}
