import {
  FATAL_ERROR_MESSAGE_CHARS,
  FetchLike,
  fetchTimedOutError,
  fetchTimeoutMs,
  fetchWithTimeout,
  formatUpstreamHttpFailure,
  isAbortError,
  isPlainObject,
  normalizeForPreview,
  safePreview,
  truncate,
} from "./common.js";
import {
  TRACE_CITY_CODES,
  TRACE_DOC_TYPES,
  type TraceCityCode,
  type TraceDocType,
} from "../shared/trace-vocab.js";
import { UNSAFE_USER_FACING_SNIPPET } from "../shared/unsafe-user-facing-snippet.js";

export { TRACE_CITY_CODES, TRACE_DOC_TYPES };
export type { TraceCityCode, TraceDocType };

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_SCOPE_INTERPRET_MODEL = "gpt-4o-mini";
const USER_FACING_UNAVAILABLE_WARNING =
  "Scope interpretation is temporarily unavailable. You can still set filters manually.";
const MODEL_CONFIG_INVALID_WARNING =
  "Scope interpretation is unavailable due to invalid model configuration. You can still set filters manually.";
const SUMMARY_PUBLIC_MAX_CHARS = 420;
const SIGNAL_EXPLANATION_MAX_CHARS = 400;
/** Hard caps on list lengths from model output (schema + defensive normalization). */
const MAX_APPLIED_SIGNALS_ITEMS = 8;
const MAX_UNRESOLVED_SIGNALS_ITEMS = 24;
const MAX_WARNINGS_ITEMS = 24;
const DEFAULT_SCOPE_INTERPRET_MAX_OUTPUT_TOKENS = 1536;
const GROUNDING_DROP_WARNING =
  "One or more interpreted filters lacked explanatory grounding and were omitted.";

export type ScopeInterpretationField =
  | "cityCode"
  | "docType"
  | "startDate"
  | "endDate";

export type ScopeInterpretationSuggestedFilters = {
  cityCode?: TraceCityCode;
  docType?: TraceDocType;
  startDate?: string;
  endDate?: string;
};

export type ScopeInterpretationSignal = {
  field: ScopeInterpretationField;
  sourceText: string;
  normalizedValue: string;
  rationale: string;
};

export type ScopeInterpretationResult = {
  queryText: string;
  suggestedFilters: ScopeInterpretationSuggestedFilters;
  summary: string;
  appliedSignals: ScopeInterpretationSignal[];
  unresolvedSignals: string[];
  warnings: string[];
};

type ScopeInterpretationOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  requestId?: string;
};

type RawScopeInterpretation = {
  summary: unknown;
  suggestedFilters: unknown;
  appliedSignals: unknown;
  unresolvedSignals: unknown;
  warnings: unknown;
};

type RawScopeInterpretationSignal = {
  field: unknown;
  sourceText: unknown;
  normalizedValue: unknown;
  rationale: unknown;
};

type RawOpenAiResponse = {
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      refusal?: string;
    }>;
  }>;
};

const CITY_CODE_SET = new Set<string>(TRACE_CITY_CODES);
const DOC_TYPE_SET = new Set<string>(TRACE_DOC_TYPES);
const SIGNAL_FIELD_SET = new Set<ScopeInterpretationField>([
  "cityCode",
  "docType",
  "startDate",
  "endDate",
]);

const SCOPE_INTERPRETATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      maxLength: SUMMARY_PUBLIC_MAX_CHARS,
      description: "One-line explanation of the suggested metadata scope.",
    },
    suggestedFilters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cityCode: {
          type: ["string", "null"],
          enum: [...TRACE_CITY_CODES, null],
        },
        docType: {
          type: ["string", "null"],
          enum: [...TRACE_DOC_TYPES, null],
        },
        startDate: {
          type: ["string", "null"],
          maxLength: 10,
          description: "Inclusive start date in YYYY-MM-DD format when confidently inferred.",
        },
        endDate: {
          type: ["string", "null"],
          maxLength: 10,
          description: "Inclusive end date in YYYY-MM-DD format when confidently inferred.",
        },
      },
      required: ["cityCode", "docType", "startDate", "endDate"],
    },
    appliedSignals: {
      type: "array",
      maxItems: MAX_APPLIED_SIGNALS_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: {
            type: "string",
            enum: ["cityCode", "docType", "startDate", "endDate"],
          },
          sourceText: { type: "string", maxLength: SIGNAL_EXPLANATION_MAX_CHARS },
          normalizedValue: { type: "string", maxLength: 120 },
          rationale: { type: "string", maxLength: SIGNAL_EXPLANATION_MAX_CHARS },
        },
        required: ["field", "sourceText", "normalizedValue", "rationale"],
      },
    },
    unresolvedSignals: {
      type: "array",
      maxItems: MAX_UNRESOLVED_SIGNALS_ITEMS,
      items: { type: "string", maxLength: SUMMARY_PUBLIC_MAX_CHARS },
    },
    warnings: {
      type: "array",
      maxItems: MAX_WARNINGS_ITEMS,
      items: { type: "string", maxLength: SUMMARY_PUBLIC_MAX_CHARS },
    },
  },
  required: [
    "summary",
    "suggestedFilters",
    "appliedSignals",
    "unresolvedSignals",
    "warnings",
  ],
} as const satisfies Record<string, unknown>;

function logInterpreterEvent(
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>
): void {
  const message = `[Scope Interpreter] ${JSON.stringify(payload)}`;
  if (level === "info") {
    console.info(message);
    return;
  }
  if (level === "warn") {
    console.warn(message);
    return;
  }
  console.error(message);
}

function buildInterpreterInstructions(): string {
  return [
    "You normalize a natural-language investigation request into safe Trace metadata filters.",
    "Only use supported metadata filters and never invent new fields.",
    "Return only the canonical cityCode/docType enumerations provided in the schema when the request maps safely.",
    "City aliases: New York, NYC -> NYC-TLC; London -> LON-TfL; San Francisco, SF -> SF-CPUC; Paris -> PAR-VTC; Chicago -> CHI-BACP; Mexico City -> MEX-SEMOVI; Sao Paulo, Sao Paolo -> SAO-DTP.",
    "Document aliases: vehicle inspection, inspection audit -> Vehicle_Inspection_Audit; driver background, background flag -> Driver_Background_Flag; insurance lapse, coverage gap -> Insurance_Lapse_Report; permit renewal, city permit -> City_Permit_Renewal; safety incident, incident log -> Safety_Incident_Log; privacy request, data privacy -> Data_Privacy_Request.",
    "If the request includes a confident calendar date range, return inclusive YYYY-MM-DD startDate/endDate values only.",
    "If the request references a whole month like March 2026, convert it to the full month range.",
    "If a phrase is ambiguous, unsupported, or unsafe to map, leave the filter null and include the phrase in unresolvedSignals instead of guessing.",
    "Do not mention SQL, do not emit free-form filters, and do not run the search.",
  ].join(" ");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDateOnly(value: string, label: string): string {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${label} must use YYYY-MM-DD format.`);
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12) {
    throw new Error(`${label} must use a real calendar date.`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`${label} must use a real calendar date.`);
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function looksUnsafePublicInterpretationSnippet(text: string): boolean {
  return UNSAFE_USER_FACING_SNIPPET.test(text);
}

function clipPublicInterpretationText(text: string, maxChars: number): string {
  const collapsed = collapseWhitespace(text);
  if (!collapsed) {
    return "";
  }
  if (!looksUnsafePublicInterpretationSnippet(collapsed)) {
    return collapsed.length > maxChars
      ? `${collapsed.slice(0, Math.max(0, maxChars - 1)).trim()}…`
      : collapsed;
  }
  const scrubbedAttempt = collapsed
    .replace(UNSAFE_USER_FACING_SNIPPET, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!scrubbedAttempt || looksUnsafePublicInterpretationSnippet(scrubbedAttempt)) {
    return "";
  }
  return scrubbedAttempt.length > maxChars
    ? `${scrubbedAttempt.slice(0, Math.max(0, maxChars - 1)).trim()}…`
    : scrubbedAttempt;
}

function normalizedStringArray(
  value: unknown,
  label: string,
  maxItems: number
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  const capped = value.slice(0, maxItems);
  const items: string[] = [];
  for (const entry of capped) {
    if (typeof entry !== "string") {
      throw new Error(`${label} must contain only strings.`);
    }
    const trimmed = entry.trim();
    if (trimmed) {
      const clipped = clipPublicInterpretationText(trimmed, SUMMARY_PUBLIC_MAX_CHARS);
      if (!clipped) {
        continue;
      }
      items.push(clipped);
    }
  }
  return items;
}

function normalizeNullableString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string or null.`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildFallbackResult(
  queryText: string,
  warnings: string | string[],
  unresolvedSignals: string[] = []
): ScopeInterpretationResult {
  return {
    queryText,
    suggestedFilters: {},
    summary: "No safe scope suggestion available.",
    appliedSignals: [],
    unresolvedSignals,
    warnings: Array.isArray(warnings) ? warnings : [warnings],
  };
}

function buildSummaryFromFilters(
  filters: ScopeInterpretationSuggestedFilters,
  unresolvedSignals: string[]
): string {
  const parts: string[] = [];
  if (filters.cityCode) {
    parts.push(`city ${filters.cityCode}`);
  }
  if (filters.docType) {
    parts.push(`document type ${filters.docType}`);
  }
  if (filters.startDate) {
    parts.push(`from ${filters.startDate}`);
  }
  if (filters.endDate) {
    parts.push(`through ${filters.endDate}`);
  }

  if (parts.length > 0) {
    return `Suggested scope: ${parts.join(", ")}.`;
  }

  if (unresolvedSignals.length > 0) {
    return "No safe scope suggestion available from the provided request.";
  }

  return "No safe scope suggestion available.";
}

function choosePublicSummary(
  parsedSummaryRaw: unknown,
  suggestedFilters: ScopeInterpretationSuggestedFilters,
  unresolvedSignals: string[]
): string {
  const baseline = buildSummaryFromFilters(suggestedFilters, unresolvedSignals);
  if (typeof parsedSummaryRaw !== "string") {
    return baseline;
  }
  const clipped = clipPublicInterpretationText(parsedSummaryRaw.trim(), SUMMARY_PUBLIC_MAX_CHARS);
  return clipped.length > 0 ? clipped : baseline;
}

function extractAssistantContent(response: RawOpenAiResponse): {
  refusal?: string;
  outputText?: string;
} {
  const outputs = Array.isArray(response.output) ? response.output : [];
  let refusal: string | undefined;
  const outputTextParts: string[] = [];

  for (const item of outputs) {
    if (!Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (content.type === "refusal" && typeof content.refusal === "string") {
        refusal = content.refusal.trim() || refusal;
      }
      if (content.type === "output_text" && typeof content.text === "string") {
        const trimmed = content.text.trim();
        if (trimmed) {
          outputTextParts.push(trimmed);
        }
      }
    }
  }

  return {
    refusal,
    outputText: outputTextParts.length > 0 ? outputTextParts.join("\n") : undefined,
  };
}

function normalizeAppliedSignals(
  value: unknown,
  suggestedFilters: ScopeInterpretationSuggestedFilters,
  maxItems: number
): ScopeInterpretationSignal[] {
  if (!Array.isArray(value)) {
    throw new Error("appliedSignals must be an array.");
  }

  const capped = value.slice(0, maxItems);
  const signals: ScopeInterpretationSignal[] = [];
  for (const entry of capped) {
    if (!isPlainObject(entry)) {
      throw new Error("appliedSignals entries must be objects.");
    }

    const rawSignal = entry as RawScopeInterpretationSignal;
    const field = rawSignal.field;
    if (typeof field !== "string" || !SIGNAL_FIELD_SET.has(field as ScopeInterpretationField)) {
      throw new Error("appliedSignals.field must be a supported field.");
    }
    if (
      typeof rawSignal.sourceText !== "string" ||
      typeof rawSignal.normalizedValue !== "string" ||
      typeof rawSignal.rationale !== "string"
    ) {
      throw new Error("appliedSignals entries must contain string values.");
    }

    const trimmedSourceText = rawSignal.sourceText.trim();
    const trimmedNormalizedValue = rawSignal.normalizedValue.trim();
    const trimmedRationale = rawSignal.rationale.trim();

    const sourceText = clipPublicInterpretationText(
      trimmedSourceText,
      SIGNAL_EXPLANATION_MAX_CHARS
    );
    const rationale = clipPublicInterpretationText(trimmedRationale, SIGNAL_EXPLANATION_MAX_CHARS);

    if (!sourceText || !trimmedNormalizedValue || !rationale) {
      continue;
    }

    const appliedValue = suggestedFilters[field as ScopeInterpretationField];
    if (appliedValue === undefined || appliedValue !== trimmedNormalizedValue) {
      continue;
    }

    signals.push({
      field: field as ScopeInterpretationField,
      sourceText,
      normalizedValue: typeof appliedValue === "string" ? appliedValue : trimmedNormalizedValue,
      rationale,
    });
  }

  return signals;
}

function pruneSuggestedFiltersToGroundedSignals(
  suggestedFilters: ScopeInterpretationSuggestedFilters,
  appliedSignals: ScopeInterpretationSignal[]
): {
  filters: ScopeInterpretationSuggestedFilters;
  signals: ScopeInterpretationSignal[];
  extraWarnings: string[];
} {
  const groundedTags = new Set(
    appliedSignals.map((s) => `${s.field}:${s.normalizedValue}`)
  );

  const next: ScopeInterpretationSuggestedFilters = {};
  let droppedAny = false;

  function consider(
    field: keyof ScopeInterpretationSuggestedFilters,
    value: string | undefined
  ): void {
    if (!value) {
      return;
    }
    if (groundedTags.has(`${String(field)}:${value}`)) {
      (next as Record<string, string>)[field] = value;
    } else {
      droppedAny = true;
    }
  }

  consider("cityCode", suggestedFilters.cityCode);
  consider("docType", suggestedFilters.docType);
  consider("startDate", suggestedFilters.startDate);
  consider("endDate", suggestedFilters.endDate);

  const signals = appliedSignals.filter((s) => {
    const current = next[s.field];
    return typeof current === "string" && current === s.normalizedValue;
  });

  return {
    filters: next,
    signals,
    extraWarnings: droppedAny ? [GROUNDING_DROP_WARNING] : [],
  };
}

export function resolveScopeInterpretMaxOutputTokens(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.OPENAI_SCOPE_INTERPRET_MAX_OUTPUT_TOKENS?.trim();
  if (!raw) {
    return DEFAULT_SCOPE_INTERPRET_MAX_OUTPUT_TOKENS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return DEFAULT_SCOPE_INTERPRET_MAX_OUTPUT_TOKENS;
  }
  if (parsed < 256 || parsed > 8192) {
    return DEFAULT_SCOPE_INTERPRET_MAX_OUTPUT_TOKENS;
  }
  return parsed;
}

export function resolveScopeInterpretationModel(
  env: NodeJS.ProcessEnv = process.env
): string {
  const model = (
    env.OPENAI_SCOPE_INTERPRET_MODEL ?? DEFAULT_SCOPE_INTERPRET_MODEL
  ).trim();
  if (!model) {
    throw new Error("OPENAI_SCOPE_INTERPRET_MODEL resolved to an empty string after trim.");
  }
  return model;
}

export function scopeInterpretationAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    return false;
  }

  try {
    resolveScopeInterpretationModel(env);
    return true;
  } catch {
    return false;
  }
}

export function normalizeScopeInterpretation(
  queryText: string,
  raw: unknown
): ScopeInterpretationResult {
  if (!isPlainObject(raw)) {
    throw new Error("Model output must be an object.");
  }

  const parsed = raw as RawScopeInterpretation;
  if (!isPlainObject(parsed.suggestedFilters)) {
    throw new Error("suggestedFilters must be an object.");
  }

  const rawFilters = parsed.suggestedFilters as Record<string, unknown>;
  const cityCode = normalizeNullableString(rawFilters.cityCode, "suggestedFilters.cityCode");
  if (cityCode && !CITY_CODE_SET.has(cityCode)) {
    throw new Error("suggestedFilters.cityCode must be one of the supported Trace city codes.");
  }

  const docType = normalizeNullableString(rawFilters.docType, "suggestedFilters.docType");
  if (docType && !DOC_TYPE_SET.has(docType)) {
    throw new Error(
      "suggestedFilters.docType must be one of the supported Trace document types."
    );
  }

  const startDateValue = normalizeNullableString(
    rawFilters.startDate,
    "suggestedFilters.startDate"
  );
  const endDateValue = normalizeNullableString(
    rawFilters.endDate,
    "suggestedFilters.endDate"
  );

  const startDate = startDateValue
    ? parseDateOnly(startDateValue, "suggestedFilters.startDate")
    : undefined;
  const endDate = endDateValue
    ? parseDateOnly(endDateValue, "suggestedFilters.endDate")
    : undefined;

  if (startDate && endDate && startDate > endDate) {
    throw new Error(
      "suggestedFilters.startDate must be before or equal to suggestedFilters.endDate."
    );
  }

  const suggestedFilters: ScopeInterpretationSuggestedFilters = {};
  if (cityCode) {
    suggestedFilters.cityCode = cityCode as TraceCityCode;
  }
  if (docType) {
    suggestedFilters.docType = docType as TraceDocType;
  }
  if (startDate) {
    suggestedFilters.startDate = startDate;
  }
  if (endDate) {
    suggestedFilters.endDate = endDate;
  }

  const unresolvedSignals = normalizedStringArray(
    parsed.unresolvedSignals,
    "unresolvedSignals",
    MAX_UNRESOLVED_SIGNALS_ITEMS
  );
  const warnings = normalizedStringArray(parsed.warnings, "warnings", MAX_WARNINGS_ITEMS);
  const appliedSignalsRaw = normalizeAppliedSignals(
    parsed.appliedSignals,
    suggestedFilters,
    MAX_APPLIED_SIGNALS_ITEMS
  );

  const grounded = pruneSuggestedFiltersToGroundedSignals(suggestedFilters, appliedSignalsRaw);
  const mergedWarnings = [...warnings, ...grounded.extraWarnings];

  const summary = choosePublicSummary(parsed.summary, grounded.filters, unresolvedSignals);

  return {
    queryText,
    suggestedFilters: grounded.filters,
    summary,
    appliedSignals: grounded.signals,
    unresolvedSignals,
    warnings: mergedWarnings,
  };
}

export async function interpretScope(
  queryText: string,
  options?: ScopeInterpretationOptions
): Promise<ScopeInterpretationResult> {
  const env = options?.env ?? process.env;
  const requestId = options?.requestId ?? null;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    return buildFallbackResult(
      queryText,
      "Scope interpretation is unavailable because OpenAI is not configured."
    );
  }

  let model: string;
  try {
    model = resolveScopeInterpretationModel(env);
  } catch {
    logInterpreterEvent("warn", {
      kind: "scope_interpret_invalid_model_configuration",
      requestId,
    });
    return buildFallbackResult(queryText, MODEL_CONFIG_INVALID_WARNING);
  }
  const timeoutMs = fetchTimeoutMs(env, "OPENAI_SCOPE_INTERPRET_TIMEOUT_MS");
  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      OPENAI_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_output_tokens: resolveScopeInterpretMaxOutputTokens(env),
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: buildInterpreterInstructions(),
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: queryText,
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "trace_scope_interpretation",
              strict: true,
              schema: SCOPE_INTERPRETATION_SCHEMA,
            },
          },
        }),
      },
      timeoutMs
    );
  } catch (error) {
    const message = isAbortError(error)
      ? fetchTimedOutError(timeoutMs).message
      : error instanceof Error
        ? truncate(normalizeForPreview(error.message), FATAL_ERROR_MESSAGE_CHARS)
        : truncate(normalizeForPreview(String(error)), FATAL_ERROR_MESSAGE_CHARS);

    logInterpreterEvent("error", {
      kind: "scope_interpret_network_failure",
      requestId,
      message,
    });
    return buildFallbackResult(queryText, USER_FACING_UNAVAILABLE_WARNING);
  }

  if (!response.ok) {
    const bodyText = await response.text();
    const message = formatUpstreamHttpFailure({
      label: "OpenAI scope interpretation failed",
      res: response,
      bodyText,
      env,
    });
    logInterpreterEvent("error", {
      kind: "scope_interpret_upstream_failure",
      requestId,
      message,
    });
    return buildFallbackResult(queryText, USER_FACING_UNAVAILABLE_WARNING);
  }

  let payload: RawOpenAiResponse;
  try {
    payload = (await response.json()) as RawOpenAiResponse;
  } catch {
    logInterpreterEvent("error", {
      kind: "scope_interpret_invalid_json",
      requestId,
      message: "OpenAI returned a non-JSON response.",
    });
    return buildFallbackResult(queryText, USER_FACING_UNAVAILABLE_WARNING);
  }

  const assistantContent = extractAssistantContent(payload);
  if (assistantContent.refusal) {
    logInterpreterEvent("warn", {
      kind: "scope_interpret_refusal",
      requestId,
      refusalPreview: safePreview(assistantContent.refusal),
    });
    return buildFallbackResult(
      queryText,
      "Scope interpretation did not return a safe suggestion for this request."
    );
  }

  if (!assistantContent.outputText) {
    logInterpreterEvent("error", {
      kind: "scope_interpret_missing_output",
      requestId,
      message: "OpenAI response did not include structured output text.",
    });
    return buildFallbackResult(queryText, USER_FACING_UNAVAILABLE_WARNING);
  }

  try {
    const modelResult = JSON.parse(assistantContent.outputText) as unknown;
    const normalized = normalizeScopeInterpretation(queryText, modelResult);
    logInterpreterEvent("info", {
      kind: "scope_interpret_success",
      requestId,
      queryTextLength: queryText.length,
      suggestedFilterCount: Object.keys(normalized.suggestedFilters).length,
      warningCount: normalized.warnings.length,
      unresolvedCount: normalized.unresolvedSignals.length,
    });
    return normalized;
  } catch (error) {
    const message =
      error instanceof Error
        ? truncate(normalizeForPreview(error.message), FATAL_ERROR_MESSAGE_CHARS)
        : truncate(normalizeForPreview(String(error)), FATAL_ERROR_MESSAGE_CHARS);
    logInterpreterEvent("error", {
      kind: "scope_interpret_invalid_output",
      requestId,
      message,
    });
    return buildFallbackResult(queryText, [
      "Trace could not validate the generated scope suggestion.",
      "You can still set filters manually.",
    ]);
  }
}
