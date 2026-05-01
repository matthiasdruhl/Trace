/**
 * Shared canonical vocab for scope interpretation and client-side guards.
 * Imported by mcp-bridge and demo-ui — single source of truth.
 */
export const TRACE_CITY_CODES = [
  "NYC-TLC",
  "LON-TfL",
  "SF-CPUC",
  "PAR-VTC",
  "CHI-BACP",
  "MEX-SEMOVI",
  "SAO-DTP",
] as const;

export const TRACE_DOC_TYPES = [
  "Vehicle_Inspection_Audit",
  "Driver_Background_Flag",
  "Insurance_Lapse_Report",
  "City_Permit_Renewal",
  "Safety_Incident_Log",
  "Data_Privacy_Request",
] as const;

export type TraceCityCode = (typeof TRACE_CITY_CODES)[number];
export type TraceDocType = (typeof TRACE_DOC_TYPES)[number];
