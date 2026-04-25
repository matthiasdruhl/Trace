import test from "node:test";
import assert from "node:assert/strict";

import { buildWhyThisMatched } from "./explanations.js";

test("buildWhyThisMatched is deterministic and bounded", () => {
  const input = {
    queryText: "Find overdue vehicle inspection audit cases with missing paperwork",
    filters: {
      cityCode: "NYC-TLC",
      docType: "Vehicle_Inspection_Audit",
    },
    row: {
      incident_id: "abc-123",
      timestamp: "2025-01-02T03:04:05Z",
      city_code: "NYC-TLC",
      doc_type: "Vehicle_Inspection_Audit",
      text_content:
        "Inspectors marked the vehicle overdue and requested mechanic paperwork before closing the audit. Extra detail follows here for clipping.",
    },
  };

  const first = buildWhyThisMatched(input);
  const second = buildWhyThisMatched(input);

  assert.equal(first, second);
  assert.match(
    first,
    /Search request: "Find overdue vehicle inspection audit cases with missing paperwork"\./
  );
  assert.match(
    first,
    /Record: abc-123, Vehicle_Inspection_Audit, NYC-TLC, 2025-01-02T03:04:05Z\./
  );
  assert.match(
    first,
    /Search filters: city NYC-TLC, document type Vehicle_Inspection_Audit\./
  );
  assert.match(
    first,
    /Text preview: "Inspectors marked the vehicle overdue and requested mechanic paperwork before closing the audit\."/
  );
  assert.ok(first.length <= 380);
});

test("buildWhyThisMatched does not claim matched terms from metadata alone", () => {
  const explanation = buildWhyThisMatched({
    queryText: "Find vehicle inspection fraud with supporting narrative",
    filters: {
      docType: "Vehicle_Inspection_Audit",
    },
    row: {
      incident_id: "meta-001",
      timestamp: "2025-03-04T05:06:07Z",
      city_code: "NYC-TLC",
      doc_type: "Vehicle_Inspection_Audit",
      text_content: "",
    },
  });

  assert.match(explanation, /Search request: "Find vehicle inspection fraud with supporting narrative"\./);
  assert.match(
    explanation,
    /Search filters: document type Vehicle_Inspection_Audit\./
  );
  assert.doesNotMatch(explanation, /Matched terms:/);
  assert.doesNotMatch(explanation, /semantic similarity/i);
  assert.doesNotMatch(explanation, /aligned with/i);
  assert.doesNotMatch(explanation, /Text preview:/);
});

test("buildWhyThisMatched omits an empty text preview and reports no active filters", () => {
  const explanation = buildWhyThisMatched({
    queryText: "repeat safety problem",
    filters: {},
    row: {
      incident_id: "empty-777",
      timestamp: "2025-07-08T09:10:11Z",
      city_code: "CHI-BACP",
      doc_type: "Safety_Incident_Log",
      text_content: "   \n\t  ",
    },
  });

  assert.match(explanation, /Search filters: none\./);
  assert.doesNotMatch(explanation, /Text preview:/);
  assert.doesNotMatch(explanation, /Snippet:/);
});
