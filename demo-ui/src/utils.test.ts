import { buildSearchRequest, formatDateBoundaryTimestamp, validateSubmission } from "./utils";

describe("utils", () => {
  it("buildSearchRequest serializes date-only filters to UTC day boundaries", () => {
    const request = buildSearchRequest("Query", {
      startDate: "2026-03-08",
      endDate: "2026-03-08",
    });

    expect(request.filters?.startTimestamp).toBe("2026-03-08T00:00:00.000Z");
    expect(request.filters?.endTimestamp).toBe("2026-03-08T23:59:59.999Z");
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
