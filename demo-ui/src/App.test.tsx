import { render, screen, waitFor, within } from "@testing-library/react";
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

function createSearchResponse(overrides: Record<string, unknown> = {}) {
  return {
    queryText: "safety incident reports in New York with supporting narrative",
    appliedFilter: {
      summary: "City NYC-TLC | Document type Safety_Incident_Log",
      filters: {
        cityCode: "NYC-TLC",
        docType: "Safety_Incident_Log",
      },
    },
    results: [
      {
        incident_id: "INC-NYC-101",
        timestamp: "2026-02-10T14:00:00.000Z",
        city_code: "NYC-TLC",
        doc_type: "Safety_Incident_Log",
        text_content: "Primary NYC safety evidence.",
        score: 0.92,
        why_this_matched: "The narrative references the same safety pattern.",
        sourceRecordId: "record-inc-nyc-101",
        sourceCollection: "nyc_tlc_incident_log",
        sourceExcerpt: "Primary NYC safety evidence.",
        dataClassification: "internal",
        redactionStatus: "none",
      },
      {
        incident_id: "INC-NYC-102",
        timestamp: "2026-02-09T11:00:00.000Z",
        city_code: "NYC-TLC",
        doc_type: "Safety_Incident_Log",
        text_content: "Supporting NYC safety evidence.",
        score: 0.81,
        why_this_matched: "It reinforces the same route-level issue.",
        sourceRecordId: "record-inc-nyc-102",
        sourceCollection: "nyc_tlc_incident_log",
        sourceExcerpt: "Supporting NYC safety evidence.",
        dataClassification: "internal",
        redactionStatus: "none",
      },
    ],
    meta: {
      tookMs: 92,
      resultCount: 2,
      queryMode: "scoped_hybrid",
      rankingStrategy: "score_desc",
      topLeadIncidentId: "INC-NYC-101",
      datasetLabel: "NYC TLC Incident Archive",
      datasetKind: "regulatory_archive",
      handoffReadiness: "ready",
      confidenceReasoning: ["Explicit dataset metadata present."],
      resultQuality: {
        status: "strong",
        summary: "Strong scoped match.",
        suggestions: [],
      },
    },
    ...overrides,
  };
}

function createInterpretScopePayload(overrides: Record<string, unknown> = {}) {
  return {
    queryText: "Chicago insurance lapse cases in March 2026",
    suggestedFilters: {
      cityCode: "CHI-BACP",
      docType: "Insurance_Lapse_Report",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    },
    summary: "Chicago insurance lapse cases narrowed to March 2026.",
    appliedSignals: [
      {
        field: "cityCode",
        sourceText: "Chicago",
        normalizedValue: "CHI-BACP",
        rationale: "Mapped the city reference to the canonical Trace city code.",
      },
    ],
    unresolvedSignals: [],
    warnings: [],
    ...overrides,
  };
}

const recommendedAuditCasePayload = {
  caseId: "nyc-safety-incident",
  label: "NYC safety incident",
  subtitle: "Explicit scope preserved",
  description:
    "Use city and document-type filters to narrow a semantic query to the exact regulatory slice.",
  queryText: "safety incident reports in New York with supporting narrative",
  filters: {
    cityCode: "NYC-TLC",
    docType: "Safety_Incident_Log",
  },
  fixtureAvailable: true,
};

const semanticOnlyCasePayload = {
  caseId: "overdue-inspection-audit",
  label: "Overdue inspection audit",
  subtitle: "Semantic-only win",
  description:
    "Show the archive can retrieve overdue inspection audit cases without a metadata prefilter.",
  queryText: "recent vehicle inspection audit with overdue paperwork",
  filters: {},
  fixtureAvailable: true,
};

function createRecommendedCasesResponse() {
  return [recommendedAuditCasePayload, semanticOnlyCasePayload];
}

function readPostedJson(init?: RequestInit) {
  expect(init?.body).toEqual(expect.any(String));
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function createDeferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

function activeElementIsWithin(target: HTMLElement | null) {
  const activeElement = document.activeElement;

  return (
    activeElement instanceof HTMLElement &&
    target instanceof HTMLElement &&
    (activeElement === target || target.contains(activeElement))
  );
}

async function continueManualExplorationIfPrompted(user: ReturnType<typeof userEvent.setup>) {
  const continueButton = screen.queryByRole("button", {
    name: /continue manual exploration/i,
  });

  if (continueButton) {
    await user.click(continueButton);
  }
}

function getCuratedCaseRail() {
  const rail = screen
    .getByRole("heading", {
      name: /start with (one )?recommended audit (response|demo)/i,
    })
    .closest("section");

  expect(rail).not.toBeNull();
  return rail as HTMLElement;
}

function createSearchResponseForCase(casePayload: {
  queryText: string;
  filters: Record<string, string>;
}) {
  const summaryParts = [
    casePayload.filters.cityCode ? `City ${casePayload.filters.cityCode}` : null,
    casePayload.filters.docType ? `Document type ${casePayload.filters.docType}` : null,
  ].filter((part): part is string => part !== null);

  return createSearchResponse({
    queryText: casePayload.queryText,
    appliedFilter: {
      summary: summaryParts.length > 0 ? summaryParts.join(" | ") : "No structured filters applied",
      filters: casePayload.filters,
    },
  });
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

  it("renders the audit-response entry surface", async () => {
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

    expect(
      await screen.findByRole("heading", {
        name: /turn a vague compliance audit request into narrowed evidence and a handoff-ready briefing/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /run recommended /i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /draft my own audit request/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/cold-archive audit response workflow/i)).toBeInTheDocument();
    expect(screen.getByText(/ops and compliance teams/i)).toBeInTheDocument();
    expect(screen.getByText(/codex sped up iteration on the live workflow, trust gating, reviewer handoff, and optional scope assist/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /best for occasional, high-consequence archive searches where staying inside the audit slice matters as much as retrieval quality/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /manual audit review is slow and scattered\. trace compresses it into one visible workflow/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/manual archive review/i)).toBeInTheDocument();
    expect(screen.getByText(/with trace/i)).toBeInTheDocument();
    expect(screen.getAllByText(/why codex mattered/i).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", {
        name: /use the recommended audit path first, then judge the handoff package it produces/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^run this first$/i)).toBeInTheDocument();
    expect(screen.getByText(/^evaluate this$/i)).toBeInTheDocument();
    expect(screen.getByText(/^success \/ failure$/i)).toBeInTheDocument();
    expect(
      screen.getByText(/start with the recommended judge path first/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /start with (one )?recommended audit (response|demo)/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/frame a request, tighten the scope, then run the search/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /optional supporting notes for the audit-response story and cold-archive retrieval claim/i,
      }),
    ).toBeInTheDocument();
  });

  it("renders the dedicated judge instructions block with run-first, evaluation, and success/failure guidance", async () => {
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

    const instructionsHeading = await screen.findByRole("heading", {
      name: /use the recommended audit path first, then judge the handoff package it produces/i,
    });
    const instructionsSection = instructionsHeading.closest("section");

    expect(instructionsSection).not.toBeNull();
    expect(within(instructionsSection as HTMLElement).getByRole("list")).toBeInTheDocument();
    expect(within(instructionsSection as HTMLElement).getByText(/^run this first$/i)).toBeInTheDocument();
    expect(within(instructionsSection as HTMLElement).getByText(/^evaluate this$/i)).toBeInTheDocument();
    expect(
      within(instructionsSection as HTMLElement).getByText(/^success \/ failure$/i),
    ).toBeInTheDocument();
    expect(
      within(instructionsSection as HTMLElement).getByText(
        /if you skip the recommended path, your evaluation may miss the main claim this demo is designed to prove/i,
      ),
    ).toBeInTheDocument();
  });

  it("uses fallback guided examples without showing an unavailable fixture", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([], { ok: false, status: 503, statusText: "Unavailable" });
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    const curatedCaseRail = getCuratedCaseRail();
    expect(
      await within(curatedCaseRail).findByRole("button", {
        name: /nyc safety audit response/i,
      }),
    ).toBeInTheDocument();

    await user.click(
      within(curatedCaseRail).getByText(/other audit scenarios/i, { selector: "summary" }),
    );

    expect(
      within(curatedCaseRail).getByRole("button", { name: /nyc safety audit response/i }),
    ).toBeInTheDocument();
    expect(
      within(curatedCaseRail).getByRole("button", { name: /overdue inspection audit/i }),
    ).toBeInTheDocument();
    expect(
      within(curatedCaseRail).queryByRole("button", { name: /insurance lapse\/coverage gap/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the scoped audit slice as the recommended curated case and keeps the semantic-only demo secondary", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    const recommendedCase = await within(getCuratedCaseRail()).findByRole("button", {
      name: /nyc safety incident/i,
    });

    expect(recommendedCase).toBeInTheDocument();
    expect(
      within(recommendedCase).getByText(/recommended first run/i),
    ).toBeInTheDocument();
    expect(
      within(recommendedCase).getByText(
        /safety incident reports in new york with supporting narrative/i,
      ),
    ).toBeInTheDocument();
    const alternateSummary = within(getCuratedCaseRail()).getByText(/other audit scenarios/i, {
      selector: "summary",
    });
    const alternateDetails = alternateSummary.closest("details");
    expect(alternateDetails).not.toBeNull();
    expect(alternateDetails).not.toHaveAttribute("open");
    await user.click(alternateSummary);
    expect(alternateDetails).toHaveAttribute("open");
    const alternateCase = screen.getByRole("button", {
      name: /overdue inspection audit/i,
    });
    expect(within(alternateCase).getByText(/semantic-only win/i)).toBeInTheDocument();
  });

  it("keeps prefill-only recommended actions separate from actually launching the guided run", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await within(getCuratedCaseRail()).findByRole("button", {
        name: /nyc safety incident/i,
      }),
    );

    expect(screen.queryByText(/top lead/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: /scope preserved, evidence surfaced, briefing ready/i,
      }),
    ).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/search"),
      expect.anything(),
    );
  });

  it("loads a guided example into the composer", async () => {
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

    await user.click(await screen.findByText(/other audit scenarios/i));
    await user.click(
      await within(getCuratedCaseRail()).findByRole("button", {
        name: /nyc safety audit response/i,
      }),
    );

    expect(screen.getByLabelText(/investigation request/i)).toHaveValue(
      "safety incident reports in New York with supporting narrative",
    );
    expect(screen.getByLabelText(/^city$/i)).toHaveValue("NYC-TLC");
    expect(screen.getByLabelText(/document type/i)).toHaveValue("Safety_Incident_Log");
  });

  it("offers labeled archive selects and example chips without changing canonical filters", async () => {
    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        expect(readPostedJson(init)).toEqual({
          queryText: "safety incident reports in New York with supporting narrative",
          filters: {
            cityCode: "NYC-TLC",
            docType: "Safety_Incident_Log",
          },
          limit: 5,
        });
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByText(/best for transportation compliance audits grounded in archived safety incidents/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /new york \(nyc-tlc\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /safety incident log/i }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /recommended: nyc safety audit/i }),
    );

    expect(screen.getByLabelText(/investigation request/i)).toHaveValue(
      "safety incident reports in New York with supporting narrative",
    );
    expect(screen.getByLabelText(/^city$/i)).toHaveValue("NYC-TLC");
    expect(screen.getByLabelText(/document type/i)).toHaveValue("Safety_Incident_Log");

    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));
    expect(await screen.findByText(/top lead/i)).toBeInTheDocument();
  });

  it("preserves user-entered date scope when an example prompt chip updates the query and canonical filters", async () => {
    let searchRequestCount = 0;

    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        searchRequestCount += 1;
        expect(readPostedJson(init)).toEqual({
          queryText: "safety incident reports in New York with supporting narrative",
          filters: {
            cityCode: "NYC-TLC",
            docType: "Safety_Incident_Log",
            startDate: "2026-02-01",
            endDate: "2026-02-28",
          },
          limit: 5,
        });
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "initial request");
    await user.type(screen.getByLabelText(/start date/i), "2026-02-01");
    await user.type(screen.getByLabelText(/end date/i), "2026-02-28");

    await user.click(
      screen.getByRole("button", { name: /recommended: nyc safety audit/i }),
    );

    expect(screen.getByLabelText(/investigation request/i)).toHaveValue(
      "safety incident reports in New York with supporting narrative",
    );
    expect(screen.getByLabelText(/^city$/i)).toHaveValue("NYC-TLC");
    expect(screen.getByLabelText(/document type/i)).toHaveValue("Safety_Incident_Log");
    expect(screen.getByLabelText(/start date/i)).toHaveValue("2026-02-01");
    expect(screen.getByLabelText(/end date/i)).toHaveValue("2026-02-28");

    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));

    await waitFor(() => expect(searchRequestCount).toBe(1));
  });

  it("shows the off-script banner when manual editing starts before the recommended demo is launched", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "manual probe");

    expect(
      await screen.findByText(/recommended judge path not yet run\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /run recommended demo/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /continue manual exploration/i }),
    ).toBeInTheDocument();
  });

  it("runs a search and renders the handoff-ready artifact", async () => {
    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true, capabilities: { scopeInterpretation: true } });
      }
      if (url.endsWith("/api/search")) {
        expect(init?.method).toBe("POST");
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });

    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "safety incident reports in New York with supporting narrative",
    );
    await user.selectOptions(screen.getByLabelText(/^city$/i), "NYC-TLC");
    await user.selectOptions(
      screen.getByLabelText(/document type/i),
      "Safety_Incident_Log",
    );
    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));

    expect(await screen.findByText(/top lead/i)).toBeInTheDocument();
    expect(screen.getByText(/support 01/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy briefing/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/trust summary/i)).toBeInTheDocument();
    expect(screen.getByText(/nyc tlc incident archive/i)).toBeInTheDocument();
    expect(screen.getAllByText(/ready for handoff/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/explicit dataset metadata present/i)).toBeInTheDocument();
    expect(screen.getAllByText(/source inspection/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/record-inc-nyc-101/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/internal classification/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/no redaction/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/immediate payoff/i).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", { name: /what this run is ready to pass forward/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /copy briefing/i }));
    expect(await screen.findByText(/briefing copied/i)).toBeInTheDocument();
  });

  it("runs the recommended audit demo from the hero CTA", async () => {
    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        expect(readPostedJson(init)).toEqual({
          queryText: recommendedAuditCasePayload.queryText,
          filters: {
            cityCode: "NYC-TLC",
            docType: "Safety_Incident_Log",
          },
          limit: 5,
        });
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: /run recommended /i }),
    );

    expect(
      await screen.findByRole("heading", {
        name: /scope preserved, evidence surfaced, briefing ready/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === "Audit request received"),
    ).toBeInTheDocument();
    expect(screen.getByText(/^scope narrowed$/i)).toBeInTheDocument();
    expect(screen.getByText(/^top evidence found$/i)).toBeInTheDocument();
    expect(screen.getByText(/^briefing ready$/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /this guided run preserved the requested scope, surfaced reviewable evidence inside it, and ended with a reviewer-ready briefing/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/audit slice: city nyc-tlc \| document safety incident log/i).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText(/top lead/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /what this run is ready to pass forward/i }),
    ).toBeInTheDocument();
    const provenanceCard = screen.getByRole("heading", {
      name: /what launched this audit demo run/i,
    }).closest("section");
    expect(provenanceCard).not.toBeNull();
    expect(
      within(provenanceCard as HTMLElement).getByText(/^Recommended audit demo$/),
    ).toBeInTheDocument();
    expect(
      within(provenanceCard as HTMLElement).getAllByText(
        /city nyc-tlc \| document type safety_incident_log/i,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("keeps hero and replay entry points aligned with the backend-recommended audit case", async () => {
    const backendRecommendedCase = {
      caseId: "chicago-insurance-review",
      label: "Chicago insurance review",
      subtitle: "Backend-recommended first run",
      description: "Use the backend-provided recommended case instead of a stale local preset.",
      queryText: "Chicago insurance lapse cases in March 2026",
      filters: {
        cityCode: "CHI-BACP",
        docType: "Insurance_Lapse_Report",
      },
      fixtureAvailable: true,
    };
    const postedRequests: Array<Record<string, unknown>> = [];

    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([backendRecommendedCase, semanticOnlyCasePayload]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        const request = readPostedJson(init);
        postedRequests.push(request);
        return createJsonResponse(createSearchResponseForCase(backendRecommendedCase));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    const curatedCaseRail = getCuratedCaseRail();
    expect(
      await within(curatedCaseRail).findByRole("button", { name: /chicago insurance review/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /run recommended /i }));
    await waitFor(() => expect(postedRequests).toHaveLength(1));

    await user.click(
      screen.getByRole("button", { name: /replay the recommended audit path/i }),
    );

    await waitFor(() => expect(postedRequests).toHaveLength(2));
    expect(postedRequests).toEqual([
      {
        queryText: backendRecommendedCase.queryText,
        filters: backendRecommendedCase.filters,
        limit: 5,
      },
      {
        queryText: backendRecommendedCase.queryText,
        filters: backendRecommendedCase.filters,
        limit: 5,
      },
    ]);
  });

  it("does not mark guided scope as confirmed until the backend returns the applied scope", async () => {
    const deferredSearch = createDeferredResponse();

    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
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

    await user.click(
      await screen.findByRole("button", { name: /run recommended /i }),
    );

    try {
      expect(
        await screen.findByRole("heading", {
          name: /scope preserved, evidence surfaced, briefing ready/i,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /this demo requested explicit city, document type, or time boundaries\. the guide waits for the backend to confirm them before claiming the scope stayed visible/i,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(
          /trace returned explicit city, document type, or time boundaries so the judge can confirm the audit slice stayed visible/i,
        ),
      ).not.toBeInTheDocument();
    } finally {
      deferredSearch.resolve(createJsonResponse(createSearchResponse()));
    }

    expect(await screen.findByText(/top lead/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /trace returned explicit city, document type, or time boundaries so the judge can confirm the audit slice stayed visible/i,
      ),
    ).toBeInTheDocument();
  });

  it("keeps the handoff-ready UI exclusive to the scoped recommended scenario", async () => {
    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        const request = readPostedJson(init);
        const queryText = request.queryText;
        const filters =
          typeof request.filters === "object" && request.filters !== null
            ? request.filters
            : undefined;

        if (
          queryText === recommendedAuditCasePayload.queryText &&
          JSON.stringify(filters) ===
            JSON.stringify({
              cityCode: "NYC-TLC",
              docType: "Safety_Incident_Log",
            })
        ) {
          return createJsonResponse(createSearchResponse());
        }

        if (queryText === semanticOnlyCasePayload.queryText) {
          return createJsonResponse(
            createSearchResponse({
              queryText: semanticOnlyCasePayload.queryText,
              appliedFilter: {
                summary: "No structured filters applied",
                filters: {},
              },
              meta: {
                tookMs: 92,
                resultCount: 2,
                queryMode: "scoped_hybrid",
                rankingStrategy: "score_desc",
                topLeadIncidentId: "INC-NYC-101",
                datasetLabel: "NYC TLC Incident Archive",
                datasetKind: "regulatory_archive",
                handoffReadiness: "not_trustworthy",
                confidenceReasoning: ["Top lead city does not match implied scope."],
                resultQuality: {
                  status: "low_confidence",
                  summary: "Top lead city does not match implied scope.",
                  suggestions: ["Tighten filters"],
                },
              },
            }),
          );
        }

        throw new Error(`Unexpected search request: ${JSON.stringify(request)}`);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /run recommended /i }));

    expect(
      await screen.findByRole("heading", { name: /what this run is ready to pass forward/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy briefing/i })).toBeInTheDocument();

    await user.click(screen.getByText(/other audit scenarios/i));
    await user.click(
      within(getCuratedCaseRail()).getByRole("button", {
        name: /overdue inspection audit/i,
      }),
    );

    expect(
      screen.queryByRole("heading", { name: /what this run is ready to pass forward/i }),
    ).not.toBeInTheDocument();

    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));

    expect(
      await screen.findByRole("heading", {
        name: /trace is not confident enough to present this as a handoff-ready result/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy briefing/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /what this run is ready to pass forward/i }),
    ).not.toBeInTheDocument();
  });

  it("uses topLeadIncidentId instead of the first array item when choosing the primary lead", async () => {
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
          createSearchResponse({
            results: [
              {
                incident_id: "INC-NYC-102",
                timestamp: "2026-02-09T11:00:00.000Z",
                city_code: "NYC-TLC",
                doc_type: "Safety_Incident_Log",
                text_content: "Supporting NYC safety evidence.",
                score: 0.81,
                why_this_matched: "It reinforces the same route-level issue.",
                sourceRecordId: "record-inc-nyc-102",
                sourceCollection: "nyc_tlc_incident_log",
                sourceExcerpt: "Supporting NYC safety evidence.",
                dataClassification: "internal",
                redactionStatus: "none",
              },
              {
                incident_id: "INC-NYC-101",
                timestamp: "2026-02-10T14:00:00.000Z",
                city_code: "NYC-TLC",
                doc_type: "Safety_Incident_Log",
                text_content: "Primary NYC safety evidence.",
                score: 0.92,
                why_this_matched: "The narrative references the same safety pattern.",
                sourceRecordId: "record-inc-nyc-101",
                sourceCollection: "nyc_tlc_incident_log",
                sourceExcerpt: "Primary NYC safety evidence.",
                dataClassification: "internal",
                redactionStatus: "none",
              },
            ],
            meta: {
              tookMs: 92,
              resultCount: 2,
              queryMode: "scoped_hybrid",
              rankingStrategy: "score_desc",
              topLeadIncidentId: "INC-NYC-101",
              datasetLabel: "NYC TLC Incident Archive",
              datasetKind: "regulatory_archive",
              handoffReadiness: "ready",
              confidenceReasoning: ["Explicit dataset metadata present."],
              resultQuality: {
                status: "strong",
                summary: "Strong scoped match.",
                suggestions: [],
              },
            },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "safety incident reports in New York with supporting narrative",
    );
    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));

    const topLeadCard = (await screen.findByText(/top lead/i)).closest(
      "article",
    );
    expect(topLeadCard).not.toBeNull();
    expect(
      within(topLeadCard as HTMLElement).getByText(/nyc-tlc\s+\|\s+feb 10, 2026/i),
    ).toBeInTheDocument();
    expect(within(topLeadCard as HTMLElement).queryByText(/feb 9, 2026/i)).not.toBeInTheDocument();
  });

  it("shows a low-confidence guardrail instead of polished results for unsupported scope", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    installFetchMock(fetchSpy);

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "license complaints in Boston with repeat drivers",
    );
    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));

    expect(
      await screen.findByText(/trace is not confident enough to present this as a handoff-ready result/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/top lead/i)).not.toBeInTheDocument();
    // Verify the client-side guardrail actually blocked the network request.
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/search"),
      expect.anything(),
    );
  });

  it("shows a review warning when results still need tighter scope", async () => {
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
          createSearchResponse({
            meta: {
              tookMs: 92,
              resultCount: 2,
              queryMode: "scoped_hybrid",
              rankingStrategy: "score_desc",
              topLeadIncidentId: "INC-NYC-101",
              datasetLabel: "NYC TLC Incident Archive",
              datasetKind: "regulatory_archive",
              handoffReadiness: "review_only",
              confidenceReasoning: ["Scope still needs tighter review."],
              resultQuality: {
                status: "review",
                summary: "Useful lead, but the request still needs a tighter boundary.",
                suggestions: ["Add a city filter", "Add a date window"],
              },
            },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "repeat driver complaints");
    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));

    expect(
      await screen.findByRole("heading", {
        name: /useful lead, but tighten the audit boundary before handoff/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/add a city filter/i)).toBeInTheDocument();
    expect(screen.getByText(/top lead/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /trace is surfacing the lead for inspection, but withholding a clean handoff signal until the audit boundary is specific enough to defend/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /what this run is ready to pass forward/i }),
    ).not.toBeInTheDocument();
  });

  it("runs scope interpretation and applies the suggested filters", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({
          ok: true,
          capabilities: { scopeInterpretation: true },
        });
      }
      if (url.endsWith("/api/interpret-scope")) {
        return createJsonResponse(createInterpretScopePayload());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "Chicago insurance lapse cases in March 2026",
    );
    await user.click(screen.getByRole("button", { name: /interpret scope/i }));

    expect(
      await screen.findByRole("heading", { name: /scope suggestion ready for review/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /apply suggestion/i }));

    expect(screen.getByLabelText(/^city$/i)).toHaveValue("CHI-BACP");
    expect(screen.getByLabelText(/document type/i)).toHaveValue("Insurance_Lapse_Report");
    expect(screen.getByLabelText(/start date/i)).toHaveValue("2026-03-01");
    expect(screen.getByLabelText(/end date/i)).toHaveValue("2026-03-31");
  });

  it("disables scope interpretation for the session when the backend reports it unavailable while search still works", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({
          ok: true,
          capabilities: { scopeInterpretation: true },
        });
      }
      if (url.endsWith("/api/interpret-scope")) {
        return createJsonResponse(
          {
            error: {
              message: "Scope interpretation is temporarily unavailable.",
            },
          },
          { ok: false, status: 503, statusText: "Service Unavailable" },
        );
      }
      if (url.endsWith("/api/search")) {
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "Show New York safety incidents",
    );
    await user.click(screen.getByRole("button", { name: /interpret scope/i }));

    expect(
      await screen.findByText(
        /scope interpretation is temporarily unavailable for this session\. manual filters and live search still work normally/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run live search/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /interpret scope/i })).toBeDisabled();

    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));
    expect(await screen.findByText(/top lead/i)).toBeInTheDocument();
  });

  it("disables scope interpretation for the rest of the session after an unavailable response", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({
          ok: true,
          capabilities: { scopeInterpretation: true },
        });
      }
      if (url.endsWith("/api/interpret-scope")) {
        return createJsonResponse(
          { message: "Not Found" },
          { ok: false, status: 404, statusText: "Not Found" },
        );
      }
      if (url.endsWith("/api/search")) {
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "Show New York safety incidents",
    );
    await user.click(screen.getByRole("button", { name: /interpret scope/i }));

    expect(
      await screen.findByText(
        /scope interpretation is temporarily unavailable for this session\. manual filters and live search still work normally/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /interpret scope/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /run live search/i })).toBeEnabled();

    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));
    expect(await screen.findByText(/top lead/i)).toBeInTheDocument();
  });

  it("does not overwrite search results when an in-flight interpretation completes after search is submitted", async () => {
    let resolveInterpretation!: (value: Response) => void;
    const interpretationPromise = new Promise<Response>((resolve) => {
      resolveInterpretation = resolve;
    });

    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true, capabilities: { scopeInterpretation: true } });
      }
      if (url.endsWith("/api/interpret-scope")) {
        return interpretationPromise;
      }
      if (url.endsWith("/api/search")) {
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText(/investigation request/i),
      "Chicago insurance lapse cases in March 2026",
    );

    // Start interpretation — do not resolve the promise yet so it stays in-flight.
    await user.click(screen.getByRole("button", { name: /interpret scope/i }));

    // Manual search stays available while interpretation is in flight. Submitting
    // the search must cancel interpretation so its eventual resolution cannot
    // overwrite the search status.
    expect(screen.getByRole("button", { name: /run live search/i })).toBeEnabled();
    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));

    // Wait for the search to complete and results to appear.
    expect(await screen.findByText(/top lead/i)).toBeInTheDocument();

    // Now resolve the interpretation with a valid suggestion. The epoch was
    // invalidated by clearInterpretationState() inside runSearch, so the
    // resolved suggestion must be silently discarded.
    resolveInterpretation(createJsonResponse(createInterpretScopePayload()));

    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    // Search results must still be visible — interpretation must not have
    // called setStatus("ready") and wiped the results.
    expect(screen.getByText(/top lead/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /scope suggestion ready for review/i }),
    ).not.toBeInTheDocument();
  });

  it("withholds retrieval telemetry in the reasoning strip when the server marks low_confidence but returns hits", async () => {
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
          createSearchResponse({
            meta: {
              tookMs: 92,
              resultCount: 2,
              queryMode: "scoped_hybrid",
              rankingStrategy: "score_desc",
              topLeadIncidentId: "INC-NYC-101",
              datasetLabel: "NYC TLC Incident Archive",
              datasetKind: "regulatory_archive",
              handoffReadiness: "not_trustworthy",
              confidenceReasoning: ["Top lead city does not match implied scope."],
              resultQuality: {
                status: "low_confidence",
                summary: "Top lead city does not match implied scope.",
                suggestions: ["Tighten filters"],
              },
            },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/investigation request/i), "probe query");
    await continueManualExplorationIfPrompted(user);
    await user.click(screen.getByRole("button", { name: /run live search/i }));

    expect(
      await screen.findByText(/trace is not confident enough to present this as a handoff-ready result/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/handoff blocked/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/top lead city does not match implied scope/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /trace is withholding certainty because the current request is still broad enough that a plausible match could mislead the next reviewer/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/withheld pending confidence review/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy briefing/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /what this run is ready to pass forward/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the compact provenance block for proof-path launches", async () => {
    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse([]);
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: /replay the recommended audit path/i }),
    );

    expect(
      await screen.findByRole("heading", { name: /what launched this audit demo run/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/browser ui to \/api\/search to the deployed trace backend/i)).toBeInTheDocument();
    expect(screen.getByText(/returned latency/i)).toBeInTheDocument();
  });

  it("keeps guided demo context and provenance visible while semantic-only contrast runs against frozen scoped results", async () => {
    const deferredContrast = createDeferredResponse();

    installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        const request = readPostedJson(init);

        if (request.retrievalStrategy === "semantic_only") {
          return deferredContrast.promise;
        }

        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: /replay the recommended audit path/i }),
    );

    expect(await screen.findByText(/top lead/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /what launched this audit demo run/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /run semantic-only contrast/i }));

    try {
      expect(
        await screen.findByText(
          /running semantic-only contrast\. scoped hybrid results stay visible until trace finishes this arm/i,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/top lead/i)).toBeInTheDocument();
      expect(
        screen.getByRole("heading", {
          name: /scope preserved, evidence surfaced, briefing ready/i,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /what launched this audit demo run/i }),
      ).toBeInTheDocument();
    } finally {
      deferredContrast.resolve(
        createJsonResponse(
          createSearchResponse({
            queryText: recommendedAuditCasePayload.queryText,
            appliedFilter: {
              summary: "No structured filters applied",
              filters: {},
            },
            meta: {
              tookMs: 103,
              resultCount: 2,
              queryMode: "semantic_only",
              rankingStrategy: "score_desc",
              topLeadIncidentId: "INC-NYC-101",
              datasetLabel: "NYC TLC Incident Archive",
              datasetKind: "regulatory_archive",
              handoffReadiness: "review_only",
              confidenceReasoning: ["Semantic-only contrast is still review-only."],
              resultQuality: {
                status: "review",
                summary: "Semantic-only contrast needs review before handoff.",
                suggestions: ["Restore typed scope before handoff."],
              },
            },
          }),
        ),
      );
    }
  });

  it("moves focus into the workspace when the hero CTA launches the recommended demo", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    const trigger = await screen.findByRole("button", { name: /run recommended /i });
    trigger.focus();
    await user.click(trigger);

    const workspaceHeading = await screen.findByRole("heading", {
      name: /use the recommended audit path first, then judge the handoff package it produces/i,
    });
    const guidedHeading = await screen.findByRole("heading", {
      name: /scope preserved, evidence surfaced, briefing ready/i,
    });
    const queryInput = screen.getByLabelText(/investigation request/i);

    await waitFor(() =>
      expect(
        activeElementIsWithin(workspaceHeading.closest("section")) ||
          activeElementIsWithin(guidedHeading.closest("section")) ||
          document.activeElement === queryInput,
      ).toBe(true),
    );
  });

  it("moves focus back into the workspace when replay restarts the recommended demo", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/search")) {
        return createJsonResponse(createSearchResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    const replayButton = screen.getByRole("button", {
      name: /replay the recommended audit path/i,
    });
    replayButton.focus();
    await user.click(replayButton);

    const workspaceHeading = await screen.findByRole("heading", {
      name: /use the recommended audit path first, then judge the handoff package it produces/i,
    });
    const guidedHeading = await screen.findByRole("heading", {
      name: /scope preserved, evidence surfaced, briefing ready/i,
    });
    const queryInput = screen.getByLabelText(/investigation request/i);

    await waitFor(() =>
      expect(
        activeElementIsWithin(workspaceHeading.closest("section")) ||
          activeElementIsWithin(guidedHeading.closest("section")) ||
          document.activeElement === queryInput,
      ).toBe(true),
    );
  });

  it("moves focus into the workspace without triggering an off-script warning when drafting a manual request", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    installFetchMock(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cases")) {
        return createJsonResponse(createRecommendedCasesResponse());
      }
      if (url.endsWith("/api/health")) {
        return createJsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<App />);

    const trigger = await screen.findByRole("button", {
      name: /draft my own audit request/i,
    });
    trigger.focus();
    await user.click(trigger);

    const workspaceHeading = await screen.findByRole("heading", {
      name: /use the recommended audit path first, then judge the handoff package it produces/i,
    });
    const queryInput = screen.getByLabelText(/investigation request/i);

    await waitFor(() =>
      expect(
        activeElementIsWithin(workspaceHeading.closest("section")) ||
          document.activeElement === queryInput,
      ).toBe(true),
    );
    expect(
      screen.queryByText(/manual exploration active\. useful for contrast, but not the primary judge path/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/you can explore manually here, but that path may not show the core claim this demo is designed to prove/i),
    ).not.toBeInTheDocument();
  });
});
