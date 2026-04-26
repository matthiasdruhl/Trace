import test from "node:test";
import assert from "node:assert/strict";

import { serializeTypedFilters } from "./filters.js";

test("serializeTypedFilters accepts UTC timestamps with or without fractional seconds", () => {
  const serialized = serializeTypedFilters({
    cityCode: "NYC-TLC",
    docType: "Safety_Incident_Log",
    startTimestamp: "2025-01-01T00:00:00Z",
    endTimestamp: "2025-02-01T00:00:00Z",
  });

  assert.equal(
    serialized.sqlFilter,
    "city_code = 'NYC-TLC' AND doc_type = 'Safety_Incident_Log' AND timestamp >= '2025-01-01T00:00:00.000Z' AND timestamp <= '2025-02-01T00:00:00.000Z'"
  );
  assert.equal(
    serialized.summary,
    "Filtered by city NYC-TLC, document type Safety_Incident_Log, from 2025-01-01T00:00:00.000Z, through 2025-02-01T00:00:00.000Z."
  );
});

test("serializeTypedFilters normalizes offset timestamps to canonical UTC", () => {
  const serialized = serializeTypedFilters({
    startTimestamp: "2025-01-01T00:00:00.25+02:30",
    endTimestamp: "2025-01-01T00:00:00-05:00",
  });

  assert.deepEqual(serialized.filters, {
    cityCode: undefined,
    docType: undefined,
    startTimestamp: "2024-12-31T21:30:00.250Z",
    endTimestamp: "2025-01-01T05:00:00.000Z",
  });
  assert.equal(
    serialized.sqlFilter,
    "timestamp >= '2024-12-31T21:30:00.250Z' AND timestamp <= '2025-01-01T05:00:00.000Z'"
  );
});

test("serializeTypedFilters rejects invalid ranges", () => {
  assert.throws(
    () =>
      serializeTypedFilters({
        startTimestamp: "2025-02-01T00:00:00Z",
        endTimestamp: "2025-01-01T00:00:00Z",
      }),
    /filters\.startTimestamp must be before or equal to filters\.endTimestamp/
  );
});

test("serializeTypedFilters rejects ranges that invert after timezone normalization", () => {
  assert.throws(
    () =>
      serializeTypedFilters({
        startTimestamp: "2025-01-01T00:00:00-05:00",
        endTimestamp: "2025-01-01T00:00:00+02:30",
      }),
    /filters\.startTimestamp must be before or equal to filters\.endTimestamp/
  );
});

test("serializeTypedFilters rejects ambiguous or unsupported timestamp formats", () => {
  for (const value of [
    "2025-01-01",
    "2025-01-01T00:00:00",
    "2025-01-01 00:00:00Z",
    "2025-01-01T00:00:00+0000",
    "2025-01-01t00:00:00Z",
  ]) {
    assert.throws(
      () =>
        serializeTypedFilters({
          startTimestamp: value,
        }),
      /filters\.startTimestamp must be an ISO 8601 timestamp with an explicit timezone/
    );
  }
});

test("serializeTypedFilters rejects impossible calendar timestamps", () => {
  assert.throws(
    () =>
      serializeTypedFilters({
        startTimestamp: "2025-02-30T00:00:00Z",
      }),
    /filters\.startTimestamp must be an ISO 8601 timestamp with an explicit timezone/
  );
});

test("serializeTypedFilters rejects invalid code fields", () => {
  assert.throws(
    () =>
      serializeTypedFilters({
        cityCode: "NYC TLC",
      }),
    /filters\.cityCode may contain only letters, numbers, underscores, and hyphens/
  );
});

test("serializeTypedFilters rejects unsupported filter keys", () => {
  assert.throws(
    () =>
      serializeTypedFilters({
        incidentId: "case-123",
      }),
    /filters\.incidentId is not supported/
  );
});
