import {
  buildSearchRequest,
  canonicalizeTraceDocType,
  formatDateBoundaryTimestamp,
  validateSubmission,
} from "./utils";

describe("utils", () => {
  it("buildSearchRequest serializes date-only filters to UTC day boundaries", () => {
    const request = buildSearchRequest("Query", {
      startDate: "2026-03-08",
      endDate: "2026-03-08",
    });

    expect(request.filters?.startTimestamp).toBe("2026-03-08T00:00:00.000Z");
    expect(request.filters?.endTimestamp).toBe("2026-03-08T23:59:59.999Z");
  });

  it("buildSearchRequest preserves city code case exactly, including mixed-case canonical codes", () => {
    const allUppercase = buildSearchRequest("Query", { cityCode: "NYC-TLC" });
    expect(allUppercase.filters?.cityCode).toBe("NYC-TLC");

    const mixedCase = buildSearchRequest("Query", { cityCode: "LON-TfL" });
    expect(mixedCase.filters?.cityCode).toBe("LON-TfL");
  });

  it("canonicalizeTraceDocType resolves legacy casing to the exact canonical literal", () => {
    expect(canonicalizeTraceDocType("safety_incident_log")).toBe("Safety_Incident_Log");
    expect(canonicalizeTraceDocType(" Vehicle_Inspection_Audit ")).toBe(
      "Vehicle_Inspection_Audit",
    );
  });

  it("buildSearchRequest canonicalizes legacy doc type casing before sending /api/search payloads", () => {
    const request = buildSearchRequest("Query", { docType: "safety_incident_log" });

    expect(request.filters?.docType).toBe("Safety_Incident_Log");
  });

  it("buildSearchRequest semantic_only omits typed filters and sets retrievalStrategy", () => {
    const request = buildSearchRequest(
      "Insurance lapse in NYC",
      { cityCode: "NYC-TLC", docType: "Safety_Incident_Log" },
      { retrievalStrategy: "semantic_only" },
    );
    expect(request.retrievalStrategy).toBe("semantic_only");
    expect(request.filters).toBeUndefined();
    expect(request.queryText).toBe("Insurance lapse in NYC");
  });

  it("formatDateBoundaryTimestamp ignores runtime timezone offsets for DST-adjacent dates", () => {
    const timezoneOffsetSpy = vi.spyOn(Date.prototype, "getTimezoneOffset");

    try {
      timezoneOffsetSpy.mockReturnValueOnce(300);
      const easternResult = formatDateBoundaryTimestamp("2026-03-08", "start");

      timezoneOffsetSpy.mockReturnValueOnce(-480);
      const pacificResult = formatDateBoundaryTimestamp("2026-03-08", "start");

      expect(easternResult).toBe("2026-03-08T00:00:00.000Z");
      expect(pacificResult).toBe("2026-03-08T00:00:00.000Z");
    } finally {
      timezoneOffsetSpy.mockRestore();
    }
  });

  it("formatDateBoundaryTimestamp returns null for impossible calendar dates", () => {
    expect(formatDateBoundaryTimestamp("2026-02-30", "start")).toBeNull();
  });

  it("validateSubmission rejects impossible calendar dates", () => {
    expect(
      validateSubmission("Query", {
        startDate: "2026-02-30",
      }),
    ).toBe("Start date is invalid.");
  });
});
