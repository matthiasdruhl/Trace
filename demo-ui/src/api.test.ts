import { buildApiUrl, fetchCases, interpretScope, searchTrace } from "./api";
import { SCOPE_INTERPRETATION_HTTP_TIMEOUT_MS } from "./httpSearch";
import type { ApiSearchRequest } from "./types";

type MockJsonOptions = {
  ok?: boolean;
  status?: number;
  statusText?: string;
};

function jsonResponse(data: unknown, options: MockJsonOptions = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? (options.ok === false ? 500 : 200),
    statusText: options.statusText ?? (options.ok === false ? "Error" : "OK"),
    json: async () => data,
  } as Response;
}

describe("api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not double /api when the pathname already includes /api and the base ends with /api", () => {
    expect(buildApiUrl("/api/search", "https://trace.example.com/api")).toBe(
      "https://trace.example.com/api/search",
    );
  });

  it("downgrades search payloads where topLeadIncidentId is missing from results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          queryText: "test",
          appliedFilter: { summary: "Scope.", filters: {} },
          results: [
            {
              incident_id: "a",
              timestamp: "2026-01-01T00:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              score: 0.5,
              why_this_matched: "x",
              sourceRecordId: "record-a",
              sourceCollection: "nyc_tlc_incident_log",
              sourceExcerpt: "x",
              dataClassification: "internal",
              redactionStatus: "none",
            },
          ],
          meta: {
            tookMs: 1,
            resultCount: 1,
            queryMode: "scoped_hybrid",
            rankingStrategy: "score_desc",
            topLeadIncidentId: "missing-id",
            datasetLabel: "NYC TLC Incident Archive",
            datasetKind: "regulatory_archive",
            handoffReadiness: "ready",
            confidenceReasoning: ["Explicit dataset metadata present."],
            resultQuality: { status: "strong", summary: "ok", suggestions: [] },
          },
        }),
      ),
    );

    const response = await searchTrace({ queryText: "test" } as ApiSearchRequest);

    expect(response.meta.topLeadIncidentId).toBeUndefined();
    expect(response.meta.resultQuality.status).toBe("review");
    expect(response.meta.handoffReadiness).toBe("review_only");
  });

  it("downgrades backend trust posture while still clamping impossible display scores", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          queryText: "safety incident reports in New York with supporting narrative",
          appliedFilter: { summary: "Scope.", filters: {} },
          results: [
            {
              incident_id: "a",
              timestamp: "2026-01-01T00:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "Primary NYC safety evidence.",
              score: 1.18,
              why_this_matched: "The safety incident narrative overlaps the request.",
              sourceRecordId: "record-a",
              sourceCollection: "nyc_tlc_incident_log",
              sourceExcerpt: "Primary NYC safety evidence.",
              dataClassification: "confidential",
              redactionStatus: "partial",
            },
          ],
          meta: {
            tookMs: 1,
            resultCount: 1,
            queryMode: "scoped_hybrid",
            rankingStrategy: "score_desc",
            topLeadIncidentId: "a",
            datasetLabel: "NYC TLC Incident Archive",
            datasetKind: "regulatory_archive",
            handoffReadiness: "ready",
            confidenceReasoning: ["Explicit dataset metadata present."],
            resultQuality: { status: "strong", summary: "ok", suggestions: [] },
          },
        }),
      ),
    );

    const response = await searchTrace({ queryText: "test" } as ApiSearchRequest);

    expect(response.results[0]?.score).toBe(1);
    expect(response.results[0]?.sourceRecordId).toBe("record-a");
    expect(response.meta.datasetKind).toBe("regulatory_archive");
    expect(response.meta.resultQuality.status).toBe("low_confidence");
    expect(response.meta.handoffReadiness).toBe("not_trustworthy");
  });

  it("fills stable fallback trust fields when older search payloads omit them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          queryText: "test",
          appliedFilter: { summary: "Scope.", filters: {} },
          results: [
            {
              incident_id: "legacy-a",
              timestamp: "2026-01-01T00:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "Legacy backend excerpt.",
              score: 0.5,
              why_this_matched: "Legacy payload without trust fields.",
            },
          ],
          meta: {
            tookMs: 1,
            resultCount: 1,
            queryMode: "scoped_hybrid",
            rankingStrategy: "score_desc",
            topLeadIncidentId: "legacy-a",
            resultQuality: { status: "review", summary: "ok", suggestions: [] },
          },
        }),
      ),
    );

    const response = await searchTrace({ queryText: "test" } as ApiSearchRequest);

    expect(response.results[0]?.sourceRecordId).toBe("legacy-a");
    expect(response.results[0]?.sourceCollection).toBe("trace-demo-regulatory-archive");
    expect(response.results[0]?.sourceExcerpt).toBe("Legacy backend excerpt.");
    expect(response.results[0]?.dataClassification).toBe("unknown");
    expect(response.results[0]?.redactionStatus).toBe("unknown");
    expect(response.results[0]?.provenanceSource).toBe("synthesized");
    expect(response.meta.datasetLabel).toBe("Trace Regulatory Demo Archive");
    expect(response.meta.datasetKind).toBe("regulatory_archive");
    expect(response.meta.hasFallbackProvenance).toBe(true);
    expect(response.meta.handoffReadiness).toBe("review_only");
    expect(response.meta.confidenceReasoning).toEqual([]);
  });

  it("matches curated fallback content by normalized case id instead of payload order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            caseId: "NYC Safety Incident",
            label: "NYC safety incident",
            queryText: "safety incident reports in New York with supporting narrative",
            filters: {
              cityCode: "NYC-TLC",
              docType: "Safety_Incident_Log",
            },
            fixtureAvailable: true,
          },
          {
            caseId: "Overdue Inspection Audit",
            label: "Overdue inspection audit",
            queryText: "recent vehicle inspection audit with overdue paperwork",
            filters: {},
            fixtureAvailable: true,
          },
        ]),
      ),
    );

    const cases = await fetchCases();

    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({
      id: "nyc-safety-incident",
      subtitle: "Recommended first run",
      description:
        "Use preserved city and document scope to narrow a vague audit request to the exact regulatory records worth handing off.",
    });
    expect(cases[1]).toMatchObject({
      id: "overdue-inspection-audit",
      subtitle: "Semantic-only alternate",
      description:
        "Show the archive can still retrieve overdue inspection audit cases without a metadata prefilter.",
    });
  });

  it("fills missing curated-case fields from the matching fallback when the backend returns a partial payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          cases: [
            {
              caseId: "nyc_safety_incident",
              label: "NYC safety incident",
              queryText: "safety incident reports in New York with supporting narrative",
              filters: {},
              fixtureAvailable: true,
            },
          ],
        }),
      ),
    );

    const cases = await fetchCases();

    expect(cases).toEqual([
      {
        id: "nyc-safety-incident",
        title: "NYC safety incident",
        subtitle: "Recommended first run",
        description:
          "Use preserved city and document scope to narrow a vague audit request to the exact regulatory records worth handing off.",
        queryText: "safety incident reports in New York with supporting narrative",
        filters: {
          cityCode: "NYC-TLC",
          docType: "Safety_Incident_Log",
          startDate: undefined,
          endDate: undefined,
        },
        fixtureAvailable: true,
      },
    ]);
  });

  it("canonicalizes mixed-case legacy curated-case filters before handing them to the composer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          cases: [
            {
              caseId: "legacy-filter-case",
              label: "Legacy filter case",
              queryText: "legacy search",
              filters: {
                cityCode: "nyc-tlc",
                docType: "safety_incident_log",
                startTimestamp: "2026-02-03T12:34:56.000Z",
                endTimestamp: "2026-02-04T08:00:00.000Z",
              },
              fixtureAvailable: true,
            },
          ],
        }),
      ),
    );

    const cases = await fetchCases();

    expect(cases).toEqual([
      {
        id: "legacy-filter-case",
        title: "Legacy filter case",
        subtitle: undefined,
        description: "",
        queryText: "legacy search",
        filters: {
          cityCode: "NYC-TLC",
          docType: "Safety_Incident_Log",
          startDate: "2026-02-03",
          endDate: "2026-02-04",
        },
        fixtureAvailable: true,
      },
    ]);
  });

  it("maps a raw scope interpretation 404 into a product-quality unavailable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ message: "Not Found" }, { ok: false, status: 404, statusText: "Not Found" }),
      ),
    );

    await expect(
      interpretScope({ queryText: "safety incidents in New York" }),
    ).rejects.toThrow(/scope interpretation is unavailable/i);
  });

  it("maps malformed scope interpretation payloads into a safe failure message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ summary: "missing required fields" })),
    );

    await expect(
      interpretScope({ queryText: "safety incidents in New York" }),
    ).rejects.toThrow(/could not interpret the scope right now/i);
  });

  it("times out a hanging scope interpretation request and maps it into an unavailable message", async () => {
    vi.useFakeTimers();

    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_input, init) => {
          const signal = init?.signal;

          return new Promise<Response>((_resolve, reject) => {
            if (!signal) {
              return;
            }
            if (signal.aborted) {
              reject(new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted.", "AbortError")),
              { once: true },
            );
          });
        }),
      );

      const pending = interpretScope({ queryText: "safety incidents in New York" });
      const assertion = expect(pending).rejects.toThrow(/scope interpretation is unavailable/i);

      await vi.advanceTimersByTimeAsync(SCOPE_INTERPRETATION_HTTP_TIMEOUT_MS + 1);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
