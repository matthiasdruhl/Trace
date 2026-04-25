import { useEffect, useMemo, useRef, useState } from "react";
import { fetchCases, fetchHealth, searchTrace } from "./api";
import type {
  CuratedCase,
  HealthState,
  SearchFilters,
  SearchResponse,
  SearchStatus,
} from "./types";
import {
  buildExcerpt,
  buildSearchRequest,
  formatLatency,
  formatScore,
  formatTimestamp,
  summarizeActiveFilters,
  validateSubmission,
} from "./utils";

const suggestedDocTypes = [
  "Safety_Incident_Log",
  "Insurance_Lapse_Report",
];

const emptyFilters: SearchFilters = {
  cityCode: "",
  docType: "",
  startDate: "",
  endDate: "",
};

function App() {
  const [queryText, setQueryText] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(emptyFilters);
  const [cases, setCases] = useState<CuratedCase[]>([]);
  const [health, setHealth] = useState<HealthState>({
    ready: false,
    label: "Checking backend",
  });
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void fetchCases(controller.signal).then((loadedCases) => {
      setCases(loadedCases);
    });

    void fetchHealth(controller.signal).then((loadedHealth) => {
      setHealth(loadedHealth);
    });

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
    };
  }, []);

  const activeFilterSummary = useMemo(() => {
    if (response) {
      return response.appliedFilter.summary;
    }

    return summarizeActiveFilters(filters);
  }, [filters, response]);

  async function runSearch(nextQuery: string, nextFilters: SearchFilters) {
    const validationError = validateSubmission(nextQuery, nextFilters);
    setValidationMessage(validationError);
    setErrorMessage(null);

    if (validationError) {
      setStatus("idle");
      setResponse(null);
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setStatus("loading");
    setResponse(null);

    try {
      const payload = buildSearchRequest(nextQuery, nextFilters);
      const searchResponse = await searchTrace(payload, controller.signal);
      setResponse(searchResponse);
      setStatus("success");
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      setStatus("error");
      setResponse(null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Trace could not complete the investigation request.",
      );
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch(queryText, filters);
  }

  function applyCase(curatedCase: CuratedCase) {
    setQueryText(curatedCase.queryText);
    setFilters({
      cityCode: curatedCase.filters.cityCode ?? "",
      docType: curatedCase.filters.docType ?? "",
      startDate: curatedCase.filters.startDate ?? "",
      endDate: curatedCase.filters.endDate ?? "",
    });
    setValidationMessage(null);
    setErrorMessage(null);
    setResponse(null);
    setStatus("idle");
  }

  const hasResults = (response?.results.length ?? 0) > 0;

  return (
    <div className="app-shell">
      <div className="background-radial background-radial-a" />
      <div className="background-radial background-radial-b" />
      <main className="app-panel">
        <header className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Trace investigation desk</p>
            <h1>Turn natural-language archive search into defensible action.</h1>
            <p className="hero-lede">
              Ask one investigation question, tighten the search with safe
              metadata filters, and review evidence cards that show the search
              and record context for each result.
            </p>
          </div>

          <div
            className={`health-pill ${health.ready ? "health-pill-ready" : "health-pill-down"}`}
            aria-live="polite"
          >
            <span className="health-indicator" aria-hidden="true" />
            {health.label}
          </div>
        </header>

        <section className="composer-card">
          <form className="search-form" onSubmit={handleSubmit}>
            <label className="field-label" htmlFor="queryText">
              Investigation request
            </label>
            <textarea
              id="queryText"
              name="queryText"
              className="query-input"
              rows={4}
              placeholder="Example: Find records that suggest a repeat safety problem in NYC that needs follow-up this quarter."
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
            />

            <div className="filter-grid" aria-label="Structured filters">
              <div className="field-group">
                <label className="field-label" htmlFor="cityCode">
                  City code
                </label>
                <input
                  id="cityCode"
                  name="cityCode"
                  className="text-input"
                  type="text"
                  inputMode="text"
                  autoCapitalize="characters"
                  placeholder="NYC-TLC"
                  value={filters.cityCode ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      cityCode: event.target.value.toUpperCase(),
                    }))
                  }
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="docType">
                  Document type
                </label>
                <input
                  id="docType"
                  name="docType"
                  className="text-input"
                  type="text"
                  list="docTypeSuggestions"
                  placeholder="Safety_Incident_Log"
                  value={filters.docType ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      docType: event.target.value,
                    }))
                  }
                />
                <datalist id="docTypeSuggestions">
                  {suggestedDocTypes.map((docType) => (
                    <option key={docType} value={docType} />
                  ))}
                </datalist>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="startDate">
                  Start date
                </label>
                <input
                  id="startDate"
                  name="startDate"
                  className="text-input"
                  type="date"
                  value={filters.startDate ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      startDate: event.target.value,
                    }))
                  }
                />
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="endDate">
                  End date
                </label>
                <input
                  id="endDate"
                  name="endDate"
                  className="text-input"
                  type="date"
                  value={filters.endDate ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      endDate: event.target.value,
                    }))
                  }
                />
              </div>
            </div>

            <div className="search-actions">
              <button className="primary-button" type="submit" disabled={status === "loading"}>
                {status === "loading" ? "Investigating..." : "Run Trace"}
              </button>
              <p className="support-copy">
                The browser only sends a search request to the app API. Secrets
                stay server-side.
              </p>
            </div>
          </form>
        </section>

        <section className="cases-section" aria-labelledby="curatedCasesHeading">
          <div className="section-heading">
            <p className="eyebrow">Curated paths</p>
            <h2 id="curatedCasesHeading">Start with a known investigation.</h2>
          </div>

          <div className="case-grid">
            {cases.map((curatedCase) => (
              <button
                key={curatedCase.id}
                className="case-card"
                type="button"
                onClick={() => applyCase(curatedCase)}
              >
                <span className="case-title">{curatedCase.title}</span>
                <span className="case-description">{curatedCase.description}</span>
                <span className="case-query">{curatedCase.queryText}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="results-section" aria-labelledby="resultsHeading">
          <div className="section-heading">
            <p className="eyebrow">Evidence trail</p>
            <h2 id="resultsHeading">Review the records that Trace surfaced.</h2>
          </div>

          <div className="status-bar" aria-live="polite">
            <span>
              {response
                ? `${response.meta.resultCount} result${response.meta.resultCount === 1 ? "" : "s"}`
                : "No search run yet"}
            </span>
            <span>{response ? `${response.meta.queryMode} mode` : "Awaiting query"}</span>
            <span>{response ? formatLatency(response.meta.tookMs) : "Timing unavailable"}</span>
            <span>{activeFilterSummary}</span>
          </div>

          {validationMessage ? (
            <div className="notice notice-warning" role="alert">
              {validationMessage}
            </div>
          ) : null}

          {status === "error" && errorMessage ? (
            <div className="notice notice-danger" role="alert">
              {errorMessage}
            </div>
          ) : null}

          {status === "idle" && !validationMessage ? (
            <div className="empty-state">
              <p className="empty-title">Choose a curated path or write your own investigation prompt.</p>
              <p>
                Trace is strongest when you describe the incident pattern, risk,
                or compliance question in plain language and then add only the
                filters you can defend.
              </p>
            </div>
          ) : null}

          {status === "loading" ? (
            <div className="empty-state">
              <p className="empty-title">Searching the archive...</p>
              <p>
                Trace is ranking candidate records and assembling evidence cards
                for review.
              </p>
            </div>
          ) : null}

          {status === "success" && !hasResults ? (
            <div className="empty-state">
              <p className="empty-title">No results matched this request.</p>
              <p>
                Relax the date range, remove a structured filter, or broaden the
                investigation wording to widen the evidence trail.
              </p>
            </div>
          ) : null}

          {status === "success" && hasResults ? (
            <div className="results-grid">
              {response?.results.map((result) => (
                <article className="result-card" key={`${result.incident_id}-${result.timestamp}`}>
                  <div className="result-meta-row">
                    <span className="result-id">{result.incident_id}</span>
                    <div className="badge-row">
                      <span className="badge">{result.city_code}</span>
                      <span className="badge">{result.doc_type}</span>
                    </div>
                  </div>

                  <p className="timestamp">{formatTimestamp(result.timestamp)}</p>

                  <div className="excerpt-block">
                    <p className="block-label">Excerpt</p>
                    <p>{buildExcerpt(result)}</p>
                  </div>

                  <div className="explanation-block">
                    <p className="block-label">Result context</p>
                    <p>{result.why_this_matched}</p>
                  </div>

                  <div className="score-row">
                    <span>Relevance score</span>
                    <span>{formatScore(result.score)}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

export default App;
