import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchCases, fetchHealth, searchTrace } from "./api";
import { CuratedCaseRail } from "./components/CuratedCaseRail";
import { EvidenceLadder } from "./components/EvidenceLadder";
import { HandoffPanel } from "./components/HandoffPanel";
import { InvestigationComposer } from "./components/InvestigationComposer";
import { ReasoningStrip } from "./components/ReasoningStrip";
import { StatePanel } from "./components/StatePanel";
import { TopBar } from "./components/TopBar";
import { TopLeadCard } from "./components/TopLeadCard";
import type {
  CuratedCase,
  HealthState,
  SearchFilters,
  SearchResponse,
  SearchStatus,
  SubmittedSearchContext,
} from "./types";
import {
  buildSearchRequest,
  deriveInvestigationWorkspaceModel,
  normalizeSearchFilters,
  validateSubmission,
} from "./utils";

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
  const [submittedSearchContext, setSubmittedSearchContext] =
    useState<SubmittedSearchContext | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchEpochRef = useRef(0);

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

  const workspaceModel = useMemo(
    () =>
      deriveInvestigationWorkspaceModel(
        queryText,
        filters,
        response,
        submittedSearchContext,
      ),
    [filters, queryText, response, submittedSearchContext],
  );

  function invalidateSearchState() {
    searchEpochRef.current += 1;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setValidationMessage(null);
    setErrorMessage(null);
    setResponse(null);
    setSubmittedSearchContext(null);
    setStatus("idle");
  }

  function clearDraftFeedback() {
    setValidationMessage(null);
    setErrorMessage(null);
  }

  function handleQueryChange(nextQuery: string) {
    setQueryText(nextQuery);
    if (status === "loading") {
      invalidateSearchState();
      return;
    }

    clearDraftFeedback();
  }

  function handleFiltersChange(updater: (current: SearchFilters) => SearchFilters) {
    setFilters((current) => updater(current));
    if (status === "loading") {
      invalidateSearchState();
      return;
    }

    clearDraftFeedback();
  }

  async function runSearch(nextQuery: string, nextFilters: SearchFilters) {
    const validationError = validateSubmission(nextQuery, nextFilters);
    setValidationMessage(validationError);
    setErrorMessage(null);

    if (validationError) {
      setStatus("idle");
      setResponse(null);
      setSubmittedSearchContext(null);
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    const searchEpoch = searchEpochRef.current + 1;
    searchEpochRef.current = searchEpoch;
    searchAbortRef.current = controller;

    setStatus("loading");
    setResponse(null);
    setSubmittedSearchContext(null);

    try {
      const payload = buildSearchRequest(nextQuery, nextFilters);
      const nextSubmittedSearchContext = {
        queryText: nextQuery.trim(),
        filters: normalizeSearchFilters(nextFilters),
      };
      const searchResponse = await searchTrace(payload, controller.signal);
      if (controller.signal.aborted || searchEpoch !== searchEpochRef.current) {
        return;
      }

      searchAbortRef.current = null;
      setSubmittedSearchContext(nextSubmittedSearchContext);
      setResponse(searchResponse);
      setStatus("success");
    } catch (error) {
      if (controller.signal.aborted || searchEpoch !== searchEpochRef.current) {
        return;
      }

      searchAbortRef.current = null;
      setStatus("error");
      setResponse(null);
      setSubmittedSearchContext(null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Trace could not complete the investigation request.",
      );
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
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
    invalidateSearchState();
  }

  const hasResults = (response?.results.length ?? 0) > 0;

  return (
    <div className="app-shell">
      <div className="background-radial background-radial-a" />
      <div className="background-radial background-radial-b" />
      <main className="app-panel">
        <TopBar health={health} />

        <div className="workspace-grid">
          <div className="workspace-column workspace-column-left">
            <InvestigationComposer
              queryText={queryText}
              filters={filters}
              status={status}
              validationMessage={validationMessage}
              onQueryChange={handleQueryChange}
              onFiltersChange={handleFiltersChange}
              onSubmit={handleSubmit}
            />

            <CuratedCaseRail cases={cases} onApplyCase={applyCase} />
          </div>

          <div className="workspace-column workspace-column-right">
            <ReasoningStrip
              investigationRequest={workspaceModel.investigationRequest}
              activeScope={workspaceModel.activeScope}
              timeWindow={workspaceModel.timeWindow}
              queryModeLabel={workspaceModel.queryModeLabel}
              resultCount={workspaceModel.resultCount}
              latencyLabel={workspaceModel.latencyLabel}
            />

            {status === "idle" && !validationMessage ? (
              <StatePanel
                eyebrow="Ready state"
                title="Start an investigation"
                body="Choose a curated path or write your own request. Trace is strongest when the question is specific and the filters are limited to scope you can defend."
              />
            ) : null}

            {status === "loading" ? (
              <StatePanel
                eyebrow="Live run"
                title="Assembling the evidence trail"
                body="Trace is interpreting the request, tightening the scope, and ranking the strongest records for review."
                steps={[
                  "Interpreting request",
                  "Narrowing scope",
                  "Assembling evidence trail",
                ]}
              />
            ) : null}

            {status === "error" && errorMessage ? (
              <StatePanel
                eyebrow="Degraded state"
                title="Search interrupted"
                body={`${errorMessage} Adjust the request or retry once backend access is restored.`}
                tone="danger"
              />
            ) : null}

            {status === "success" && !hasResults ? (
              <StatePanel
                eyebrow="No defensible match"
                title="No defensible match in current scope"
                body="Relax the date range, remove a structured filter, or broaden the investigation wording to widen the evidence trail."
                tone="warning"
              />
            ) : null}

                {status === "success" && workspaceModel.topLead ? (
              <>
                <TopLeadCard
                  result={workspaceModel.topLead}
                  filters={workspaceModel.submittedFilters}
                />
                <EvidenceLadder
                  results={workspaceModel.supportingResults}
                  filters={workspaceModel.submittedFilters}
                />
                {workspaceModel.handoffSummary ? (
                  <HandoffPanel summary={workspaceModel.handoffSummary} />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
