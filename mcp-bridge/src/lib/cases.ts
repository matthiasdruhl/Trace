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
    id: "nyc-safety-incident",
    title: "NYC safety audit response",
    subtitle: "Recommended first run",
    narrative:
      "Use preserved city and document scope to narrow a vague audit request to the exact regulatory records worth handing off.",
    queryText: "safety incident reports in New York with supporting narrative",
    filters: {
      cityCode: "NYC-TLC",
      docType: "Safety_Incident_Log",
    },
    fixtureCaseId: "filtered-nyc-safety",
    fixtureAvailable: true,
  },
  {
    id: "overdue-inspection-audit",
    title: "Overdue inspection audit",
    subtitle: "Semantic-only alternate",
    narrative:
      "Show the archive can still retrieve overdue inspection audit cases without a metadata prefilter.",
    queryText: "recent vehicle inspection audit with overdue paperwork",
    filters: {},
    fixtureCaseId: "unfiltered-demo",
    fixtureAvailable: true,
  },
  /**
   * Stable 0-result pairing for refinement UX (verified 2026-04 on Trace regulatory demo
   * archive: NYC-TLC rows skew to safety incidents; Insurance_Lapse_Report is scarce there).
   */
  {
    id: "narrow-slice-zero-results",
    title: "Empty slice refinement drill",
    subtitle: "Stable zero-match path",
    narrative:
      "Practice refinement when the slice uses supported literals but no records satisfy the cross-filter.",
    queryText: "insurance lapse paperwork tied to New York fleet operations",
    filters: {
      cityCode: "NYC-TLC",
      docType: "Insurance_Lapse_Report",
    },
    fixtureAvailable: true,
  },
];

export function loadCuratedCases(): CuratedCase[] {
  return CURATED_CASES.map((item) => ({
    ...item,
    filters: { ...item.filters },
  }));
}
