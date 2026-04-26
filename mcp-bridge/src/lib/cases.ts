import { TypedSearchFilters } from "./filters.js";

export type CuratedCase = {
  id: string;
  title: string;
  subtitle: string;
  narrative: string;
  queryText: string;
  filters: TypedSearchFilters;
  fixtureCaseId?: string;
  fixtureAvailable: boolean;
};

const CURATED_CASES: CuratedCase[] = [
  {
    id: "overdue-inspection-audit",
    title: "Overdue inspection audit",
    subtitle: "Semantic-only win",
    narrative:
      "Show the archive can retrieve overdue inspection audit cases without a metadata prefilter.",
    queryText: "recent vehicle inspection audit with overdue paperwork",
    filters: {},
    fixtureCaseId: "unfiltered-demo",
    fixtureAvailable: true,
  },
  {
    id: "nyc-safety-incident",
    title: "NYC safety incident",
    subtitle: "Filtering win",
    narrative:
      "Use city and document-type filters to narrow a semantic query to the exact regulatory slice.",
    queryText: "safety incident reports in New York with supporting narrative",
    filters: {
      cityCode: "NYC-TLC",
      docType: "Safety_Incident_Log",
    },
    fixtureCaseId: "filtered-nyc-safety",
    fixtureAvailable: true,
  },
  {
    id: "insurance-lapse-coverage-gap",
    title: "Insurance lapse / coverage gap",
    subtitle: "Operator-value case",
    narrative:
      "Surface insurance lapse cases that matter operationally when coverage gaps can suspend vehicles.",
    queryText: "insurance lapse or coverage gap for fleet vehicles",
    filters: {
      cityCode: "CHI-BACP",
      docType: "Insurance_Lapse_Report",
    },
    fixtureCaseId: "filtered-chi-insurance",
    fixtureAvailable: false,
  },
];

export function loadCuratedCases(): CuratedCase[] {
  return CURATED_CASES.map((item) => ({
    ...item,
    filters: { ...item.filters },
  }));
}
