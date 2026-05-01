import type { SearchFilters } from "./types";
import type { TraceCityCode, TraceDocType } from "./traceVocab";

export type ArchiveVocabularyOption<TValue extends string = string> = {
  value: TValue;
  label: string;
};

export type ArchiveExamplePrompt = {
  id: string;
  label: string;
  queryText: string;
  filters: SearchFilters;
};

export const archiveCityOptions: ArchiveVocabularyOption<TraceCityCode>[] = [
  { value: "NYC-TLC", label: "New York (NYC-TLC)" },
  { value: "LON-TfL", label: "London (LON-TfL)" },
  { value: "SF-CPUC", label: "San Francisco (SF-CPUC)" },
  { value: "PAR-VTC", label: "Paris (PAR-VTC)" },
  { value: "CHI-BACP", label: "Chicago (CHI-BACP)" },
  { value: "MEX-SEMOVI", label: "Mexico City (MEX-SEMOVI)" },
  { value: "SAO-DTP", label: "Sao Paulo (SAO-DTP)" },
] as const;

export const archiveDocTypeOptions: ArchiveVocabularyOption<TraceDocType>[] = [
  { value: "Vehicle_Inspection_Audit", label: "Vehicle inspection audit" },
  { value: "Driver_Background_Flag", label: "Driver background flag" },
  { value: "Insurance_Lapse_Report", label: "Insurance lapse report" },
  { value: "City_Permit_Renewal", label: "City permit renewal" },
  { value: "Safety_Incident_Log", label: "Safety incident log" },
  { value: "Data_Privacy_Request", label: "Data privacy request" },
] as const;

export const archiveComposerHelperCopy =
  "Best for transportation compliance audits grounded in archived safety incidents, inspections, insurance coverage, permit renewals, and related oversight records.";

export const archiveExamplePrompts: ArchiveExamplePrompt[] = [
  {
    id: "recommended-nyc-safety",
    label: "Recommended: NYC safety audit",
    queryText: "safety incident reports in New York with supporting narrative",
    filters: {
      cityCode: "NYC-TLC",
      docType: "Safety_Incident_Log",
    },
  },
  {
    id: "inspection-audit",
    label: "Inspection audit",
    queryText: "recent vehicle inspection audit with overdue paperwork",
    filters: {},
  },
  {
    id: "empty-slice-drill",
    label: "Refinement drill",
    queryText: "insurance lapse paperwork tied to New York fleet operations",
    filters: {
      cityCode: "NYC-TLC",
      docType: "Insurance_Lapse_Report",
    },
  },
] as const;
