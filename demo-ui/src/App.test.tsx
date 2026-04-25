import { render, screen } from "@testing-library/react";
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

  it("normalizes curated cases from the app API", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse({
          cases: [
            {
              caseId: "nyc-safety-incident",
              title: "NYC safety incident",
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

    await user.click(
      await screen.findByRole("button", { name: /insurance lapse \/ coverage gap/i }),
    );

    expect(screen.getByLabelText(/investigation request/i)).toHaveValue(
      "insurance lapse or coverage gap for fleet vehicles",
    );
    expect(screen.getByLabelText(/city code/i)).toHaveValue("CHI-BACP");
    expect(screen.getByLabelText(/document type/i)).toHaveValue("Insurance_Lapse_Report");
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

    await user.click(screen.getByRole("button", { name: /run trace/i }));

    expect(await screen.findByText(/enter an investigation question/i)).toBeInTheDocument();
  });

  it("renders results and the status row after a successful search", async () => {
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
                'Search request: "Find safety incidents in NYC". Record: INC-104, Safety_Incident_Log, NYC-TLC, 2026-02-10T14:00:00.000Z. Search filters: city NYC-TLC. Text preview: "A repeat safety escalation reached the operations desk."',
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

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "Find safety incidents in NYC",
    );
    await user.type(screen.getByLabelText(/city code/i), "NYC-TLC");
    await user.click(screen.getByRole("button", { name: /run trace/i }));

    expect(await screen.findByText(/search request: "find safety incidents in nyc"/i)).toBeInTheDocument();
    expect(screen.getByText(/result context/i)).toBeInTheDocument();
    expect(screen.getByText(/1 result/i)).toBeInTheDocument();
    expect(screen.getByText(/124 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/^City NYC-TLC$/i)).toBeInTheDocument();
  });

  it("shows the no-results state", async () => {
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
    await user.click(screen.getByRole("button", { name: /run trace/i }));

    expect(await screen.findByText(/no results matched this request/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /run trace/i }));

    expect(
      await screen.findByText(/trace received an incomplete response from the app api/i),
    ).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /run trace/i }));

    expect(await screen.findByText(/backend is down/i)).toBeInTheDocument();
  });
});
