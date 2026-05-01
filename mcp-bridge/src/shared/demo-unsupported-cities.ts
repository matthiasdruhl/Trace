/**
 * Cities explicitly outside the demo corpus (shared client + POST /api/search guardrails).
 * Single source of truth for regex + label used in queryGuardrails and app-api.
 */
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
