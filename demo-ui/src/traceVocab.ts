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

export type UnsupportedDemoCityRule = {
  patternSource: string;
  patternFlags: string;
  label: string;
};

export const UNSUPPORTED_DEMO_CITY_RULES: UnsupportedDemoCityRule[] = [
  { patternSource: "\\bboston\\b", patternFlags: "i", label: "Boston" },
];

export function compileUnsupportedDemoCityRules(): Array<{
  pattern: RegExp;
  label: string;
}> {
  return UNSUPPORTED_DEMO_CITY_RULES.map((rule) => ({
    pattern: new RegExp(rule.patternSource, rule.patternFlags),
    label: rule.label,
  }));
}

export const UNSAFE_USER_FACING_SNIPPET =
  /(`|\$\{|;\s*$|\bdrop\b|\bdelete\s+from\b|\binsert\s+into\b|\bunion\s+select\b|\bEXEC\s*\(|\bsql\b|\bsql\b\s*-?\s*filter\b)/i;

export function canonicalizeTraceCityCode(value: string): string {
  const trimmed = value.trim();
  const canonical = TRACE_CITY_CODES.find(
    (cityCode) => cityCode.toLowerCase() === trimmed.toLowerCase(),
  );
  return canonical ?? trimmed;
}
