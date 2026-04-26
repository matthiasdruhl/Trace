import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { buildApiUrl } from "./api";

type MockJsonOptions = {
  ok?: boolean;
  status?: number;
  statusText?: string;
};

function createJsonResponse(payload: unknown, options: MockJsonOptions = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    json: async () => payload,
  } as Response;
}

function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  vi.stubGlobal("fetch", vi.fn(handler));
}

function createDeferredResponse() {
  let resolveResponse: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });

  return {
    promise,
    resolve: resolveResponse,
  };
}

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("builds public app API URLs from an API-root base URL", () => {
    expect(buildApiUrl("/search", "https://trace.example.com")).toBe(
      "https://trace.example.com/api/search",
    );
    expect(buildApiUrl("cases", "https://trace.example.com/")).toBe(
      "https://trace.example.com/api/cases",
    );
    expect(buildApiUrl("/health", "https://trace.example.com")).not.toContain("/api/api/");
  });

  it("avoids duplicating /api when older config already includes it", () => {
    expect(buildApiUrl("/search", "https://trace.example.com/api")).toBe(
      "https://trace.example.com/api/search",
    );
    expect(buildApiUrl("cases", "https://trace.example.com/api/")).toBe(
      "https://trace.example.com/api/cases",
    );
    expect(buildApiUrl("/health", "https://trace.example.com/api")).not.toContain("/api/api/");
  });

  it("renders the new idle-state investigation framing", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);

    expect(await screen.findByText(/start an investigation/i)).toBeInTheDocument();
    expect(screen.getByText(/interpreted request and active scope/i)).toBeInTheDocument();
  });

  it("normalizes curated cases from the app API and surfaces the subtitle", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse({
          cases: [
            {
              caseId: "nyc-safety-incident",
              title: "NYC safety incident",
              subtitle: "Filtering win",
              narrative:
                "Use city and document-type filters to narrow a semantic query to the exact regulatory slice.",
              prompt: "safety incident reports in New York with supporting narrative",
              filters: {
                cityCode: "NYC-TLC",
                docType: "Safety_Incident_Log",
                startTimestamp: "2026-01-01T00:00:00.000Z",
                endTimestamp: "2026-01-31T23:59:59.999Z",
              },
            },
          ],
        });
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText(/filtering win/i)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /nyc safety incident/i }));

    expect(screen.getByLabelText(/investigation request/i)).toHaveValue(
      "safety incident reports in New York with supporting narrative",
    );
    expect(screen.getByLabelText(/city code/i)).toHaveValue("NYC-TLC");
    expect(screen.getByLabelText(/document type/i)).toHaveValue("Safety_Incident_Log");
    expect(screen.getByLabelText(/start date/i)).toHaveValue("2026-01-01");
    expect(screen.getByLabelText(/end date/i)).toHaveValue("2026-01-31");
  });

  it("uses backend-aligned fallback curated cases when /api/cases is unavailable", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(
          {
            error: {
              code: "UNAVAILABLE",
              message: "Cases unavailable",
            },
          },
          {
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
          },
        );
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /overdue inspection audit/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/investigation request/i)).toHaveValue(
        "recent vehicle inspection audit with overdue paperwork",
      );
    });
    expect(screen.getByLabelText(/city code/i)).toHaveValue("");
    expect(screen.getByLabelText(/document type/i)).toHaveValue("");
  });

  it("disables unavailable fallback curated cases and explains why they cannot run", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    const unavailableCase = await screen.findByRole("button", {
      name: /insurance lapse \/ coverage gap/i,
    });

    expect(unavailableCase).toBeDisabled();
    expect(screen.getByText(/fixture unavailable/i)).toBeInTheDocument();
    expect(
      screen.getByText(/shown for demo completeness, but its fixture is not loaded/i),
    ).toBeInTheDocument();

    await user.click(unavailableCase);

    expect(screen.getByLabelText(/investigation request/i)).toHaveValue("");
    expect(screen.getByLabelText(/city code/i)).toHaveValue("");
    expect(screen.getByLabelText(/document type/i)).toHaveValue("");
  });

  it("disables unavailable curated cases returned by the app API", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse({
          cases: [
            {
              caseId: "insurance-lapse-coverage-gap",
              title: "Insurance lapse / coverage gap",
              subtitle: "Operator-value case",
              narrative:
                "Surface insurance lapse cases that matter operationally when coverage gaps can suspend vehicles.",
              prompt: "insurance lapse or coverage gap for fleet vehicles",
              filters: {
                cityCode: "CHI-BACP",
                docType: "Insurance_Lapse_Report",
              },
              fixtureAvailable: false,
            },
          ],
        });
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);

    const unavailableCase = await screen.findByRole("button", {
      name: /insurance lapse \/ coverage gap/i,
    });

    expect(unavailableCase).toBeDisabled();
    expect(screen.getByText(/fixture unavailable/i)).toBeInTheDocument();
  });

  it("shows a validation message when the query is empty", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText(/enter an investigation question/i)).toBeInTheDocument();
  });

  it("promotes the top lead and preserves supporting evidence order after a successful search", async () => {
    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        expect(init?.method).toBe("POST");
        return createJsonResponse({
          queryText: "Find safety incidents in NYC",
          appliedFilter: {
            sqlFilter:
              "city_code = 'NYC-TLC' AND doc_type = 'Safety_Incident_Log'",
            summary: "City NYC-TLC | Document type Safety_Incident_Log",
          },
          results: [
            {
              incident_id: "INC-104",
              timestamp: "2026-02-10T14:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "A repeat safety escalation reached the operations desk.",
              score: 0.92,
              why_this_matched:
                'Search request: "Find safety incidents in NYC". Record: INC-104, Safety_Incident_Log, NYC-TLC, 2026-02-10T14:00:00.000Z. Search filters: city NYC-TLC. Text preview: "A repeat safety escalation reached the operations desk."',
            },
            {
              incident_id: "INC-205",
              timestamp: "2026-02-09T11:30:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "A second record confirms the same operator escalation pattern.",
              score: 0.84,
              why_this_matched:
                'Search request: "Find safety incidents in NYC". Record: INC-205, Safety_Incident_Log, NYC-TLC, 2026-02-09T11:30:00.000Z. Search filters: city NYC-TLC. Text preview: "A second record confirms the same operator escalation pattern."',
            },
          ],
          meta: {
            tookMs: 124,
            resultCount: 2,
            queryMode: "live",
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "Find safety incidents in NYC",
    );
    await user.type(screen.getByLabelText(/city code/i), "NYC-TLC");
    await user.type(screen.getByLabelText(/document type/i), "Safety_Incident_Log");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText(/primary evidence surfaced for review/i)).toBeInTheDocument();
    expect(screen.getByText(/supporting records in ranked order/i)).toBeInTheDocument();
    expect(screen.getByText(/defensible handoff/i)).toBeInTheDocument();
    expect(screen.getByText(/2 results/i)).toBeInTheDocument();
    expect(screen.getByText(/124 ms/i)).toBeInTheDocument();
    expect(
      screen.getAllByText(/^City NYC-TLC \| Document type Safety_Incident_Log$/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/city scope match/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/document type scope match/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /review incident INC-104 with 1 supporting record in this scope before escalation/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("INC-205")).toBeInTheDocument();
    expect(screen.getByText("Support 01")).toBeInTheDocument();
  });

  it("uses the actual returned result length when backend metadata overstates the count", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return createJsonResponse({
          queryText: "Find safety incidents in NYC",
          appliedFilter: {
            sqlFilter: "city_code = 'NYC-TLC'",
            summary: "City NYC-TLC",
          },
          results: [
            {
              incident_id: "INC-104",
              timestamp: "2026-02-10T14:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "Primary record.",
              score: 0.92,
              why_this_matched: "Context",
            },
            {
              incident_id: "INC-205",
              timestamp: "2026-02-09T11:30:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "Supporting record.",
              score: 0.84,
              why_this_matched: "Context",
            },
          ],
          meta: {
            tookMs: 124,
            resultCount: 9,
            queryMode: "live",
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "Find safety incidents in NYC",
    );
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText(/primary evidence surfaced for review/i)).toBeInTheDocument();
    expect(screen.getByText(/2 results/i)).toBeInTheDocument();
    expect(screen.queryByText(/9 results/i)).not.toBeInTheDocument();
  });

  it("uses the actual returned result length when backend metadata understates the count", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return createJsonResponse({
          queryText: "Find safety incidents in NYC",
          appliedFilter: {
            sqlFilter: "city_code = 'NYC-TLC'",
            summary: "City NYC-TLC",
          },
          results: [
            {
              incident_id: "INC-104",
              timestamp: "2026-02-10T14:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "Primary record.",
              score: 0.92,
              why_this_matched: "Context",
            },
          ],
          meta: {
            tookMs: 124,
            resultCount: 0,
            queryMode: "live",
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "Find safety incidents in NYC",
    );
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText(/primary evidence surfaced for review/i)).toBeInTheDocument();
    expect(screen.getByText(/1 result/i)).toBeInTheDocument();
    expect(screen.queryByText(/^0 results$/i)).not.toBeInTheDocument();
  });

  it("shows date-range match chips only when the result is within the requested range", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return createJsonResponse({
          queryText: "Query",
          appliedFilter: {
            sqlFilter: "timestamp BETWEEN ...",
            summary: "Date range 2026-02-01 to 2026-02-28",
          },
          results: [
            {
              incident_id: "INC-104",
              timestamp: "2026-02-10T14:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "Within range.",
              score: 0.92,
              why_this_matched: "Context",
            },
          ],
          meta: {
            tookMs: 124,
            resultCount: 1,
            queryMode: "live",
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "Query");
    await user.type(screen.getByLabelText(/start date/i), "2026-02-01");
    await user.type(screen.getByLabelText(/end date/i), "2026-02-28");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText(/within requested date range/i)).toBeInTheDocument();
  });

  it("keeps displayed scope chips and time window tied to the submitted search after draft edits", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return createJsonResponse({
          queryText: "Find safety incidents in NYC",
          appliedFilter: {
            sqlFilter:
              "city_code = 'NYC-TLC' AND doc_type = 'Safety_Incident_Log' AND timestamp BETWEEN ...",
            summary:
              "City NYC-TLC | Document type Safety_Incident_Log | Date range 2026-02-01 to 2026-02-28",
          },
          results: [
            {
              incident_id: "INC-104",
              timestamp: "2026-02-10T14:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "Within range.",
              score: 0.92,
              why_this_matched: "Context",
            },
            {
              incident_id: "INC-205",
              timestamp: "2026-02-09T11:30:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "Also within range.",
              score: 0.84,
              why_this_matched: "Context",
            },
          ],
          meta: {
            tookMs: 124,
            resultCount: 2,
            queryMode: "live",
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "Find safety incidents in NYC",
    );
    await user.type(screen.getByLabelText(/city code/i), "NYC-TLC");
    await user.type(screen.getByLabelText(/document type/i), "Safety_Incident_Log");
    await user.type(screen.getByLabelText(/start date/i), "2026-02-01");
    await user.type(screen.getByLabelText(/end date/i), "2026-02-28");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText("2026-02-01 to 2026-02-28")).toBeInTheDocument();
    expect(screen.getAllByText(/city scope match/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/document type scope match/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/within requested date range/i).length).toBeGreaterThan(0);

    await user.clear(screen.getByLabelText(/city code/i));
    await user.type(screen.getByLabelText(/city code/i), "SEA-FAS");
    await user.clear(screen.getByLabelText(/document type/i));
    await user.type(screen.getByLabelText(/document type/i), "Complaint_Report");
    await user.clear(screen.getByLabelText(/start date/i));
    await user.type(screen.getByLabelText(/start date/i), "2026-03-01");
    await user.clear(screen.getByLabelText(/end date/i));
    await user.type(screen.getByLabelText(/end date/i), "2026-03-31");

    expect(screen.getByText("2026-02-01 to 2026-02-28")).toBeInTheDocument();
    expect(screen.queryByText("2026-03-01 to 2026-03-31")).not.toBeInTheDocument();
    expect(screen.getAllByText(/city scope match/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/document type scope match/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/within requested date range/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/primary evidence surfaced for review/i)).toBeInTheDocument();
  });

  it("keeps date-range chips tied to the submitted request when the draft range changes", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return createJsonResponse({
          queryText: "Query",
          appliedFilter: {
            sqlFilter: "timestamp BETWEEN ...",
            summary: "Date range 2026-02-01 to 2026-02-28",
          },
          results: [
            {
              incident_id: "INC-104",
              timestamp: "2026-02-10T14:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "Within range.",
              score: 0.92,
              why_this_matched: "Context",
            },
          ],
          meta: {
            tookMs: 124,
            resultCount: 1,
            queryMode: "live",
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "Query");
    await user.type(screen.getByLabelText(/start date/i), "2026-02-01");
    await user.type(screen.getByLabelText(/end date/i), "2026-02-28");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText("2026-02-01 to 2026-02-28")).toBeInTheDocument();
    expect(screen.getByText(/within requested date range/i)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/start date/i));
    await user.type(screen.getByLabelText(/start date/i), "2026-03-01");
    await user.clear(screen.getByLabelText(/end date/i));
    await user.type(screen.getByLabelText(/end date/i), "2026-03-31");

    expect(screen.getByText("2026-02-01 to 2026-02-28")).toBeInTheDocument();
    expect(screen.queryByText("2026-03-01 to 2026-03-31")).not.toBeInTheDocument();
    expect(screen.getByText(/within requested date range/i)).toBeInTheDocument();
  });

  it("shows the top lead without an empty ladder when only one result is returned", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return createJsonResponse({
          queryText: "Find one record",
          appliedFilter: {
            sqlFilter: "city_code = 'NYC-TLC'",
            summary: "City NYC-TLC",
          },
          results: [
            {
              incident_id: "INC-104",
              timestamp: "2026-02-10T14:00:00.000Z",
              city_code: "NYC-TLC",
              doc_type: "Safety_Incident_Log",
              text_content: "A repeat safety escalation reached the operations desk.",
              score: 0.92,
              why_this_matched:
                'Search request: "Find one record". Record: INC-104, Safety_Incident_Log, NYC-TLC, 2026-02-10T14:00:00.000Z. Search filters: city NYC-TLC. Text preview: "A repeat safety escalation reached the operations desk."',
            },
          ],
          meta: {
            tookMs: 124,
            resultCount: 1,
            queryMode: "live",
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "Find one record");
    await user.type(screen.getByLabelText(/city code/i), "NYC-TLC");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText(/primary evidence surfaced for review/i)).toBeInTheDocument();
    expect(screen.queryByText(/supporting records in ranked order/i)).not.toBeInTheDocument();
  });

  it("shows the no-results state while keeping the reasoning strip visible", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return createJsonResponse({
          queryText: "Query",
          appliedFilter: {
            sqlFilter: "",
            summary: "No structured filters applied",
          },
          results: [],
          meta: {
            tookMs: 99,
            resultCount: 0,
            queryMode: "live",
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "Query");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText(/no defensible match in current scope/i)).toBeInTheDocument();
    expect(screen.getByText(/interpreted request and active scope/i)).toBeInTheDocument();
  });

  it("shows a controlled error when the search response is malformed", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return createJsonResponse({
          queryText: "Query",
          appliedFilter: {
            summary: "No structured filters applied",
          },
          results: [],
          meta: {
            tookMs: 99,
            resultCount: 0,
            queryMode: "live",
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "Query");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(
      await screen.findByText(/trace received an incomplete response from the app api/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/search interrupted/i)).toBeInTheDocument();
  });

  it("shows a backend failure state", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return createJsonResponse(
          {
            error: {
              code: "DOWNSTREAM_UNAVAILABLE",
              message: "Backend is down",
            },
          },
          {
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
          },
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "Query");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));

    expect(await screen.findByText(/backend is down/i)).toBeInTheDocument();
    expect(screen.getByText(/degraded state/i)).toBeInTheDocument();
  });

  it("ignores a stale search response after applying a curated case", async () => {
    const deferredSearch = createDeferredResponse();

    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse({
          cases: [
            {
              caseId: "nyc-safety-incident",
              title: "NYC safety incident",
              subtitle: "Filtering win",
              prompt: "safety incident reports in New York with supporting narrative",
              filters: {
                cityCode: "NYC-TLC",
                docType: "Safety_Incident_Log",
              },
            },
          ],
        });
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return deferredSearch.promise;
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "Original live search");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));
    expect(await screen.findByText(/assembling the evidence trail/i)).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /nyc safety incident/i }));

    expect(screen.getByLabelText(/investigation request/i)).toHaveValue(
      "safety incident reports in New York with supporting narrative",
    );
    expect(screen.queryByText(/assembling the evidence trail/i)).not.toBeInTheDocument();
    expect(screen.getByText(/start an investigation/i)).toBeInTheDocument();

    deferredSearch.resolve(
      createJsonResponse({
        queryText: "Original live search",
        appliedFilter: {
          sqlFilter: "city_code = 'SEA-FAS'",
          summary: "City SEA-FAS",
        },
        results: [
          {
            incident_id: "INC-999",
            timestamp: "2026-02-10T14:00:00.000Z",
            city_code: "SEA-FAS",
            doc_type: "Safety_Incident_Log",
            text_content: "Stale result",
            score: 0.92,
            why_this_matched: "Stale result",
          },
        ],
        meta: {
          tookMs: 124,
          resultCount: 1,
          queryMode: "live",
        },
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("INC-999")).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(/city code/i)).toHaveValue("NYC-TLC");
    expect(screen.getByLabelText(/document type/i)).toHaveValue("Safety_Incident_Log");
  });

  it("ignores a stale search response after the draft is edited mid-flight", async () => {
    const deferredSearch = createDeferredResponse();

    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return deferredSearch.promise;
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    const queryInput = screen.getByLabelText(/investigation request/i);
    await user.type(queryInput, "Original live search");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));
    expect(await screen.findByText(/assembling the evidence trail/i)).toBeInTheDocument();

    await user.type(queryInput, " updated");

    expect(queryInput).toHaveValue("Original live search updated");
    expect(screen.queryByText(/assembling the evidence trail/i)).not.toBeInTheDocument();
    expect(screen.getByText(/start an investigation/i)).toBeInTheDocument();

    deferredSearch.resolve(
      createJsonResponse({
        queryText: "Original live search",
        appliedFilter: {
          sqlFilter: "",
          summary: "No structured filters applied",
        },
        results: [
          {
            incident_id: "INC-888",
            timestamp: "2026-02-10T14:00:00.000Z",
            city_code: "SEA-FAS",
            doc_type: "Safety_Incident_Log",
            text_content: "Stale result",
            score: 0.92,
            why_this_matched: "Stale result",
          },
        ],
        meta: {
          tookMs: 124,
          resultCount: 1,
          queryMode: "live",
        },
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("INC-888")).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(/investigation request/i)).toHaveValue(
      "Original live search updated",
    );
  });

  it("ignores a stale search response after filters are edited mid-flight", async () => {
    const deferredSearch = createDeferredResponse();

    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }

      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }

      if (url.endsWith("/api/search")) {
        return deferredSearch.promise;
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "Original live search");
    await user.type(screen.getByLabelText(/city code/i), "NYC-TLC");
    await user.click(screen.getByRole("button", { name: /assemble evidence trail/i }));
    expect(await screen.findByText(/assembling the evidence trail/i)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/city code/i));
    await user.type(screen.getByLabelText(/city code/i), "SEA-FAS");

    expect(screen.getByLabelText(/city code/i)).toHaveValue("SEA-FAS");
    expect(screen.queryByText(/assembling the evidence trail/i)).not.toBeInTheDocument();
    expect(screen.getByText(/start an investigation/i)).toBeInTheDocument();

    deferredSearch.resolve(
      createJsonResponse({
        queryText: "Original live search",
        appliedFilter: {
          sqlFilter: "city_code = 'NYC-TLC'",
          summary: "City NYC-TLC",
        },
        results: [
          {
            incident_id: "INC-777",
            timestamp: "2026-02-10T14:00:00.000Z",
            city_code: "NYC-TLC",
            doc_type: "Safety_Incident_Log",
            text_content: "Stale result",
            score: 0.92,
            why_this_matched: "Stale result",
          },
        ],
        meta: {
          tookMs: 124,
          resultCount: 1,
          queryMode: "live",
        },
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("INC-777")).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(/city code/i)).toHaveValue("SEA-FAS");
  });
});
