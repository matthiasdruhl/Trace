import assert from "node:assert/strict";
import test from "node:test";

import {
  interpretScope,
  normalizeScopeInterpretation,
  resolveScopeInterpretMaxOutputTokens,
  resolveScopeInterpretationModel,
  scopeInterpretationAvailable,
} from "./scope-interpreter.js";

const baseEnv = {
  OPENAI_API_KEY: "test-key",
  OPENAI_SCOPE_INTERPRET_MODEL: "gpt-4o-mini",
} satisfies NodeJS.ProcessEnv;

test("normalizeScopeInterpretation keeps only applied signals that match final filters", () => {
  const result = normalizeScopeInterpretation("Show New York safety incidents", {
    summary: "",
    suggestedFilters: {
      cityCode: "NYC-TLC",
      docType: "Safety_Incident_Log",
      startDate: null,
      endDate: null,
    },
    appliedSignals: [
      {
        field: "cityCode",
        sourceText: "New York",
        normalizedValue: "NYC-TLC",
        rationale: "New York maps to NYC-TLC.",
      },
      {
        field: "docType",
        sourceText: "safety incidents",
        normalizedValue: "Safety_Incident_Log",
        rationale: "Safety incidents map to the safety incident document type.",
      },
      {
        field: "startDate",
        sourceText: "today",
        normalizedValue: "2026-04-29",
        rationale: "Should not be applied because no startDate filter exists.",
      },
    ],
    unresolvedSignals: [],
    warnings: [],
  });

  assert.deepEqual(result, {
    queryText: "Show New York safety incidents",
    suggestedFilters: {
      cityCode: "NYC-TLC",
      docType: "Safety_Incident_Log",
    },
    summary: "Suggested scope: city NYC-TLC, document type Safety_Incident_Log.",
    appliedSignals: [
      {
        field: "cityCode",
        sourceText: "New York",
        normalizedValue: "NYC-TLC",
        rationale: "New York maps to NYC-TLC.",
      },
      {
        field: "docType",
        sourceText: "safety incidents",
        normalizedValue: "Safety_Incident_Log",
        rationale: "Safety incidents map to the safety incident document type.",
      },
    ],
    unresolvedSignals: [],
    warnings: [],
  });
});

test("normalizeScopeInterpretation rejects unsupported enums and invalid dates", () => {
  assert.throws(
    () =>
      normalizeScopeInterpretation("Find Chicago records", {
        summary: "Bad suggestion",
        suggestedFilters: {
          cityCode: "ATL-UNKNOWN",
          docType: "Insurance_Lapse_Report",
          startDate: "2026-02-30",
          endDate: null,
        },
        appliedSignals: [],
        unresolvedSignals: [],
        warnings: [],
      }),
    /supported Trace city codes/
  );
});

test("scopeInterpretationAvailable requires an OpenAI key and a non-empty model", () => {
  assert.equal(scopeInterpretationAvailable(baseEnv), true);
  assert.equal(
    scopeInterpretationAvailable({ OPENAI_SCOPE_INTERPRET_MODEL: "gpt-4o-mini" }),
    false
  );
  assert.equal(
    scopeInterpretationAvailable({
      OPENAI_API_KEY: "test-key",
      OPENAI_SCOPE_INTERPRET_MODEL: "   ",
    }),
    false
  );
});

test("normalizeScopeInterpretation drops structured suggestions without explanatory grounding", () => {
  const result = normalizeScopeInterpretation("Find Chicago records", {
    summary: "Chicago regulators.",
    suggestedFilters: {
      cityCode: "CHI-BACP",
      docType: "Insurance_Lapse_Report",
      startDate: null,
      endDate: null,
    },
    appliedSignals: [],
    unresolvedSignals: [],
    warnings: [],
  });

  assert.deepEqual(result.suggestedFilters, {});
  assert.deepEqual(result.appliedSignals, []);
  assert.ok(
    result.warnings.some((warning) => warning.includes("lacked explanatory grounding"))
  );
});

test("normalizeScopeInterpretation keeps only fields covered by matching signals", () => {
  const result = normalizeScopeInterpretation("Show NYC safety incidents", {
    summary: "",
    suggestedFilters: {
      cityCode: "NYC-TLC",
      docType: "Safety_Incident_Log",
      startDate: null,
      endDate: null,
    },
    appliedSignals: [
      {
        field: "cityCode",
        sourceText: "NYC",
        normalizedValue: "NYC-TLC",
        rationale: "City grounding.",
      },
    ],
    unresolvedSignals: [],
    warnings: [],
  });

  assert.deepEqual(result.suggestedFilters, { cityCode: "NYC-TLC" });
  assert.equal(result.appliedSignals.length, 1);
  assert.ok(
    result.warnings.some((warning) => warning.includes("lacked explanatory grounding"))
  );
});

test("resolveScopeInterpretMaxOutputTokens defaults and validates bounds", () => {
  assert.equal(resolveScopeInterpretMaxOutputTokens({}), 1536);
  assert.equal(
    resolveScopeInterpretMaxOutputTokens({ OPENAI_SCOPE_INTERPRET_MAX_OUTPUT_TOKENS: "4096" }),
    4096
  );
  assert.equal(
    resolveScopeInterpretMaxOutputTokens({ OPENAI_SCOPE_INTERPRET_MAX_OUTPUT_TOKENS: "128" }),
    1536
  );
});

test("resolveScopeInterpretationModel defaults when no override is set", () => {
  assert.equal(
    resolveScopeInterpretationModel({ OPENAI_API_KEY: "test-key" }),
    "gpt-4o-mini"
  );
});

test("interpretScope returns a controlled fallback when OpenAI is not configured", async () => {
  const result = await interpretScope("Chicago insurance lapse cases in March 2026", {
    env: {},
  });

  assert.deepEqual(result, {
    queryText: "Chicago insurance lapse cases in March 2026",
    suggestedFilters: {},
    summary: "No safe scope suggestion available.",
    appliedSignals: [],
    unresolvedSignals: [],
    warnings: [
      "Scope interpretation is unavailable because OpenAI is not configured.",
    ],
  });
});

test("interpretScope falls back safely when OPENAI_SCOPE_INTERPRET_MODEL resolves empty after trim", async () => {
  const result = await interpretScope("Chicago insurance lapse cases in March 2026", {
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_SCOPE_INTERPRET_MODEL: "   ",
    },
  });

  assert.deepEqual(result.warnings, [
    "Scope interpretation is unavailable due to invalid model configuration. You can still set filters manually.",
  ]);
  assert.deepEqual(result.suggestedFilters, {});
  assert.deepEqual(result.appliedSignals, []);
});

test("interpretScope returns a controlled fallback when the fetch is aborted (timeout path)", async () => {
  const abortError = Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
  });

  const result = await interpretScope("Chicago insurance lapse cases in March 2026", {
    env: baseEnv,
    fetchImpl: async () => {
      throw abortError;
    },
  });

  assert.deepEqual(result.suggestedFilters, {});
  assert.deepEqual(result.appliedSignals, []);
  assert.deepEqual(result.warnings, [
    "Scope interpretation is temporarily unavailable. You can still set filters manually.",
  ]);
});

test("normalizeScopeInterpretation throws when startDate is after endDate", () => {
  assert.throws(
    () =>
      normalizeScopeInterpretation("Find NYC records in April 2026", {
        summary: "NYC records in April",
        suggestedFilters: {
          cityCode: "NYC-TLC",
          docType: "Safety_Incident_Log",
          startDate: "2026-04-30",
          endDate: "2026-04-01",
        },
        appliedSignals: [
          {
            field: "cityCode",
            sourceText: "NYC",
            normalizedValue: "NYC-TLC",
            rationale: "City grounding.",
          },
        ],
        unresolvedSignals: [],
        warnings: [],
      }),
    /startDate.*endDate/
  );
});
