import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  curatedCaseFallbacks,
  fetchCases,
  fetchHealth,
  interpretScope,
  searchTrace,
} from "./api";
import { buildQueryRefinementHint } from "./queryGuardrails";
import { AuditArchiveFrame } from "./components/AuditArchiveFrame";
import { ComparisonStrip } from "./components/ComparisonStrip";
import { CuratedCaseRail } from "./components/CuratedCaseRail";
import { EvidenceLadder } from "./components/EvidenceLadder";
import { GuidedDemoStrip, type GuidedDemoScopeState } from "./components/GuidedDemoStrip";
import { HandoffPanel } from "./components/HandoffPanel";
import { InvestigationComposer } from "./components/InvestigationComposer";
import { JudgeProofPanel } from "./components/JudgeProofPanel";
import { ReasoningStrip } from "./components/ReasoningStrip";
import { StatePanel } from "./components/StatePanel";
import { TopBar } from "./components/TopBar";
import { TopLeadCard } from "./components/TopLeadCard";
import { findRecommendedAuditCase } from "./judgeProof";
import type {
  CuratedCase,
  HealthState,
  QueryRefinementHint,
  SearchFilters,
  SearchResponse,
  SearchStatus,
  ScopeInterpretationSuggestion,
  SubmittedSearchContext,
} from "./types";
import {
  buildSearchRequest,
  deriveInvestigationWorkspaceModel,
  formatTimestamp,
  mergeInterpretedSuggestionIntoDraftFilters,
  normalizeSearchFilters,
  validateSubmission,
} from "./utils";
import { shouldRetrySearchOnce } from "./httpSearch";
import { isScopeInterpretationUnavailableMessage } from "./scopeInterpretGuards";

const ZERO_RESULT_CASE_ID = "narrow-slice-zero-results";

const emptyFilters: SearchFilters = {
  cityCode: "",
  docType: "",
  startDate: "",
  endDate: "",
};

function toDraftFilters(filters: SearchFilters): SearchFilters {
  return {
    cityCode: filters.cityCode ?? "",
    docType: filters.docType ?? "",
    startDate: filters.startDate ?? "",
    endDate: filters.endDate ?? "",
  };
}

type JudgeRunProvenance = {
  sourceCaseId: string;
  demoTitle: string;
  demoQueryText: string;
  requestedScope: string;
  startedAtLabel: string;
  startedAtState: string;
  resultModeLabel?: string;
  latencyLabel?: string;
  appliedScope?: string;
  errorMessage?: string;
  guardrailSummary?: string;
};

type RecommendedDemoConfig = {
  sourceCaseId: string;
  title: string;
  subtitle: string;
  queryText: string;
  filters: SearchFilters;
  scopeLine: string;
};

type OffScriptReason =
  | "none"
  | "manual_edit"
  | "alternate_case"
  | "manual_submit"
  | "example_prompt";

function formatJudgePresetScope(filters: SearchFilters): string {
  const normalizedFilters = normalizeSearchFilters(filters);
  const parts: string[] = [];

  if (normalizedFilters.cityCode) {
    parts.push(`City ${normalizedFilters.cityCode}`);
  }
  if (normalizedFilters.docType) {
    parts.push(`Document type ${normalizedFilters.docType}`);
  }
  if (normalizedFilters.startDate) {
    parts.push(`From ${normalizedFilters.startDate}`);
  }
  if (normalizedFilters.endDate) {
    parts.push(`Through ${normalizedFilters.endDate}`);
  }

  return parts.length > 0 ? parts.join(" ; ") : "No structured scope";
}

function buildRecommendedDemoConfig(curatedCase: CuratedCase): RecommendedDemoConfig {
  const nextFilters = toDraftFilters(curatedCase.filters);

  return {
    sourceCaseId: curatedCase.id,
    title: "Recommended audit demo",
    subtitle: curatedCase.subtitle ?? "Recommended first run",
    queryText: curatedCase.queryText,
    filters: nextFilters,
    scopeLine: formatJudgePresetScope(nextFilters),
  };
}

function App() {
  const [queryText, setQueryText] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(emptyFilters);
  const [cases, setCases] = useState<CuratedCase[]>(curatedCaseFallbacks);
  const [health, setHealth] = useState<HealthState>({
    ready: false,
    label: "Checking system status",
    capabilities: {
      scopeInterpretation: false,
    },
  });
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [queryHint, setQueryHint] = useState<QueryRefinementHint | null>(null);
  const [interpretationStatus, setInterpretationStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [interpretationErrorMessage, setInterpretationErrorMessage] = useState<
    string | null
  >(null);
  const [interpretationSuggestion, setInterpretationSuggestion] =
    useState<ScopeInterpretationSuggestion | null>(null);
  const [scopeInterpretationSessionUnavailable, setScopeInterpretationSessionUnavailable] =
    useState(false);
  const [submittedSearchContext, setSubmittedSearchContext] =
    useState<SubmittedSearchContext | null>(null);
  const [judgeRunProvenance, setJudgeRunProvenance] =
    useState<JudgeRunProvenance | null>(null);
  const [searchRunPhase, setSearchRunPhase] = useState<
    "idle" | "connecting" | "searching" | "assembling"
  >("idle");
  const [searchAutoRetrying, setSearchAutoRetrying] = useState(false);
  const [contrastBaselineResponse, setContrastBaselineResponse] = useState<SearchResponse | null>(
    null,
  );
  const [activeCuratedCaseId, setActiveCuratedCaseId] = useState<string | null>(null);
  const [hasStartedRecommendedDemo, setHasStartedRecommendedDemo] = useState(false);
  const [hasAcknowledgedOffScript, setHasAcknowledgedOffScript] = useState(false);
  const [offScriptReason, setOffScriptReason] = useState<OffScriptReason>("none");

  const searchAbortRef = useRef<AbortController | null>(null);
  const searchEpochRef = useRef(0);
  const lastSearchParamsRef = useRef<{
    query: string;
    filters: SearchFilters;
    demoLaunch?: RecommendedDemoConfig;
    semanticContrast?: boolean;
  } | null>(null);
  const interpretationAbortRef = useRef<AbortController | null>(null);
  const interpretationEpochRef = useRef(0);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

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
      interpretationAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (status !== "running") {
      setSearchRunPhase("idle");
      return;
    }
    setSearchRunPhase("connecting");
    const t1 = window.setTimeout(() => setSearchRunPhase("searching"), 450);
    const t2 = window.setTimeout(() => setSearchRunPhase("assembling"), 1300);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [status]);

  const responseForFrozenWorkspace =
    status === "running" && contrastBaselineResponse ? contrastBaselineResponse : response;

  const workspaceModel = useMemo(
    () =>
      deriveInvestigationWorkspaceModel(
        queryText,
        filters,
        responseForFrozenWorkspace,
        submittedSearchContext,
      ),
    [filters, queryText, responseForFrozenWorkspace, submittedSearchContext],
  );
  const recommendedCuratedCase = useMemo(
    () => findRecommendedAuditCase(cases),
    [cases],
  );
  const recommendedDemo = useMemo(
    () => (recommendedCuratedCase ? buildRecommendedDemoConfig(recommendedCuratedCase) : null),
    [recommendedCuratedCase],
  );
  const interpretationAvailable =
    health.capabilities.scopeInterpretation && !scopeInterpretationSessionUnavailable;
  const interpretationUnavailableMessage = !health.capabilities.scopeInterpretation
    ? health.ready
      ? "Scope interpretation is unavailable until the backend reports support for it. Manual filters and search still work normally."
      : null
    : scopeInterpretationSessionUnavailable
      ? "Scope interpretation is temporarily unavailable for this session. Manual filters and live search still work normally."
      : null;

  function focusWorkspace() {
    window.requestAnimationFrame(() => {
      workspaceRef.current?.focus?.({ preventScroll: true });
      workspaceRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    });
  }

  function invalidateSearchState(nextStatus: SearchStatus = "idle") {
    searchEpochRef.current += 1;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setValidationMessage(null);
    setErrorMessage(null);
    setResponse(null);
    setSubmittedSearchContext(null);
    setContrastBaselineResponse(null);
    setStatus(nextStatus);
  }

  function clearInterpretationState() {
    interpretationEpochRef.current += 1;
    interpretationAbortRef.current?.abort();
    interpretationAbortRef.current = null;
    setInterpretationStatus("idle");
    setInterpretationErrorMessage(null);
    setInterpretationSuggestion(null);
  }

  function clearDraftFeedback() {
    setValidationMessage(null);
    setErrorMessage(null);
  }

  function deriveDraftStatus(nextQuery: string, nextFilters: SearchFilters): SearchStatus {
    const normalizedFilters = normalizeSearchFilters(nextFilters);
    const hasDraftScope = Object.values(normalizedFilters).some(
      (value) => value.trim().length > 0,
    );

    return nextQuery.trim().length > 0 || hasDraftScope ? "ready" : "idle";
  }

  function markOffScript(reason: Exclude<OffScriptReason, "none">) {
    if (hasStartedRecommendedDemo) {
      return;
    }

    setOffScriptReason(reason);
  }

  function clearOffScriptState() {
    setHasAcknowledgedOffScript(false);
    setOffScriptReason("none");
  }

  function handleContinueManualExploration() {
    if (hasStartedRecommendedDemo || offScriptReason === "none") {
      return;
    }

    setHasAcknowledgedOffScript(true);
  }

  function handleQueryChange(
    nextQuery: string,
    source: "manual_edit" | "example_prompt" = "manual_edit",
  ) {
    markOffScript(source);
    setQueryText(nextQuery);
    setJudgeRunProvenance(null);
    setActiveCuratedCaseId(null);
    clearInterpretationState();
    setQueryHint(buildQueryRefinementHint(nextQuery, filters));
    if (status === "running") {
      invalidateSearchState(deriveDraftStatus(nextQuery, filters));
      return;
    }

    if (status === "completed" || status === "no_results" || status === "low_confidence") {
      setResponse(null);
      setSubmittedSearchContext(null);
    }

    setStatus(deriveDraftStatus(nextQuery, filters));
    clearDraftFeedback();
  }

  function handleFiltersChange(
    updater: (current: SearchFilters) => SearchFilters,
    source: "manual_edit" | "example_prompt" = "manual_edit",
  ) {
    markOffScript(source);
    clearInterpretationState();
    setJudgeRunProvenance(null);
    setActiveCuratedCaseId(null);
    const nextFilters = updater(filtersRef.current);
    setFilters(nextFilters);
    setQueryHint(buildQueryRefinementHint(queryText, nextFilters));

    if (status === "running") {
      invalidateSearchState(deriveDraftStatus(queryText, nextFilters));
    } else {
      if (
        status === "completed" ||
        status === "no_results" ||
        status === "low_confidence"
      ) {
        setResponse(null);
        setSubmittedSearchContext(null);
      }
      setStatus(deriveDraftStatus(queryText, nextFilters));
      clearDraftFeedback();
    }
  }

  async function handleInterpretScope() {
    if (!interpretationAvailable) {
      setInterpretationStatus("idle");
      setInterpretationSuggestion(null);
      setInterpretationErrorMessage(null);
      return;
    }

    const normalizedQuery = queryText.trim();
    if (!normalizedQuery) {
      setInterpretationStatus("error");
      setInterpretationSuggestion(null);
      setInterpretationErrorMessage(
        "Enter an investigation question before asking Trace to interpret the scope.",
      );
      return;
    }

    interpretationAbortRef.current?.abort();
    const controller = new AbortController();
    const interpretationEpoch = interpretationEpochRef.current + 1;
    interpretationEpochRef.current = interpretationEpoch;
    interpretationAbortRef.current = controller;

    setStatus("interpreting");
    setInterpretationStatus("loading");
    setInterpretationErrorMessage(null);
    setInterpretationSuggestion(null);

    try {
      const suggestion = await interpretScope(
        {
          queryText: normalizedQuery,
        },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        interpretationEpoch !== interpretationEpochRef.current
      ) {
        return;
      }

      interpretationAbortRef.current = null;
      setInterpretationSuggestion(suggestion);
      setInterpretationStatus("success");
      setScopeInterpretationSessionUnavailable(false);
      setStatus("ready");
    } catch (error) {
      if (
        controller.signal.aborted ||
        interpretationEpoch !== interpretationEpochRef.current
      ) {
        return;
      }

      interpretationAbortRef.current = null;
      setInterpretationSuggestion(null);
      setStatus("ready");
      const nextMessage =
        error instanceof Error
          ? error.message
          : "Trace could not interpret the investigation scope.";
      const unavailable = isScopeInterpretationUnavailableMessage(nextMessage);
      setScopeInterpretationSessionUnavailable(unavailable);
      setInterpretationStatus(unavailable ? "idle" : "error");
      setInterpretationErrorMessage(unavailable ? null : nextMessage);
    }
  }

  function handleApplySuggestion() {
    if (!interpretationSuggestion) {
      return;
    }

    const nextFilters = mergeInterpretedSuggestionIntoDraftFilters(
      filters,
      interpretationSuggestion.suggestedFilters,
    );
    setFilters(nextFilters);
    setQueryHint(buildQueryRefinementHint(queryText, nextFilters));
    setJudgeRunProvenance(null);
    clearInterpretationState();
    invalidateSearchState(deriveDraftStatus(queryText, nextFilters));
  }

  async function runSearch(
    nextQuery: string,
    nextFilters: SearchFilters,
    options?: { demoLaunch?: RecommendedDemoConfig; semanticContrast?: boolean },
  ) {
    const demoLaunch = options?.demoLaunch;
    const semanticContrast = options?.semanticContrast ?? false;

    // Cancel any in-flight interpretation before proceeding. Without this,
    // an interpretation that completes after the search starts would call
    // setStatus("ready") and wipe the search results from view.
    clearInterpretationState();

    const validationError = validateSubmission(nextQuery, nextFilters);
    const nextHint = buildQueryRefinementHint(nextQuery, nextFilters);
    setQueryHint(nextHint);
    setValidationMessage(validationError);
    setErrorMessage(null);

    if (validationError) {
      setStatus("invalid_input");
      setResponse(null);
      setSubmittedSearchContext(null);
      setContrastBaselineResponse(null);
      return;
    }

    if (nextHint?.blocking) {
      setStatus("low_confidence");
      setResponse(null);
      setSubmittedSearchContext({
        queryText: nextQuery.trim(),
        filters: normalizeSearchFilters(nextFilters),
      });
      if (!semanticContrast) {
        setJudgeRunProvenance(null);
      }
      setContrastBaselineResponse(null);
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    const searchEpoch = searchEpochRef.current + 1;
    searchEpochRef.current = searchEpoch;
    searchAbortRef.current = controller;

    lastSearchParamsRef.current = {
      query: nextQuery,
      filters: nextFilters,
      demoLaunch,
      semanticContrast,
    };

    if (demoLaunch) {
      setJudgeRunProvenance({
        sourceCaseId: demoLaunch.sourceCaseId,
        demoTitle: demoLaunch.title,
        demoQueryText: demoLaunch.queryText,
        requestedScope: demoLaunch.scopeLine,
        startedAtLabel: formatTimestamp(new Date().toISOString()),
        startedAtState: health.label,
      });
    } else if (!semanticContrast) {
      setJudgeRunProvenance(null);
    }

    setSearchAutoRetrying(false);
    setStatus("running");
    if (!semanticContrast) {
      setContrastBaselineResponse(null);
      setResponse(null);
      setSubmittedSearchContext(null);
    }

    const nextSubmittedSearchContext: SubmittedSearchContext = semanticContrast
      ? { queryText: nextQuery.trim(), filters: {} }
      : {
          queryText: nextQuery.trim(),
          filters: normalizeSearchFilters(nextFilters),
        };

    const payload = semanticContrast
      ? buildSearchRequest(nextQuery, nextFilters, { retrievalStrategy: "semantic_only" })
      : buildSearchRequest(nextQuery, nextFilters);

    const executeOnce = async () =>
      searchTrace(payload, controller.signal);

    try {
      let searchResponse: SearchResponse;
      try {
        searchResponse = await executeOnce();
      } catch (firstError) {
        if (controller.signal.aborted || searchEpoch !== searchEpochRef.current) {
          return;
        }
        if (!shouldRetrySearchOnce(firstError)) {
          throw firstError;
        }
        setSearchAutoRetrying(true);
        try {
          searchResponse = await executeOnce();
        } finally {
          setSearchAutoRetrying(false);
        }
      }

      if (controller.signal.aborted || searchEpoch !== searchEpochRef.current) {
        return;
      }

      searchAbortRef.current = null;
      setContrastBaselineResponse(null);
      setSubmittedSearchContext(nextSubmittedSearchContext);
      setResponse(searchResponse);

      if (searchResponse.results.length === 0) {
        setStatus("no_results");
      } else if (searchResponse.meta.resultQuality.status === "low_confidence") {
        setStatus("low_confidence");
      } else {
        setStatus("completed");
      }

      if (demoLaunch) {
        const lowConfidence = searchResponse.meta.resultQuality.status === "low_confidence";
        setJudgeRunProvenance((current) =>
          current?.sourceCaseId === demoLaunch.sourceCaseId
            ? {
                ...current,
                ...(lowConfidence
                  ? {
                      resultModeLabel: undefined,
                      latencyLabel: undefined,
                      appliedScope: undefined,
                      guardrailSummary: searchResponse.meta.resultQuality.summary,
                    }
                  : {
                      resultModeLabel: searchResponse.meta.queryMode,
                      latencyLabel: `${Math.round(searchResponse.meta.tookMs)} ms`,
                      appliedScope: searchResponse.appliedFilter.summary,
                      guardrailSummary: undefined,
                    }),
                errorMessage: undefined,
              }
            : current,
        );
      } else if (semanticContrast) {
        setJudgeRunProvenance(null);
      }
    } catch (error) {
      if (controller.signal.aborted || searchEpoch !== searchEpochRef.current) {
        return;
      }

      searchAbortRef.current = null;
      setSearchAutoRetrying(false);
      setContrastBaselineResponse(null);
      setStatus("service_error");
      if (!semanticContrast) {
        setResponse(null);
        setSubmittedSearchContext(null);
      }
      const nextErrorMessage =
        error instanceof Error
          ? error.message
          : "Trace could not complete the investigation request.";
      setErrorMessage(nextErrorMessage);
      if (demoLaunch) {
        setJudgeRunProvenance((current) =>
          current?.sourceCaseId === demoLaunch.sourceCaseId
            ? {
                ...current,
                errorMessage: nextErrorMessage,
              }
            : current,
        );
      } else if (semanticContrast) {
        setJudgeRunProvenance(null);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasStartedRecommendedDemo && !hasAcknowledgedOffScript) {
      markOffScript("manual_submit");
      focusWorkspace();
      return;
    }
    void runSearch(queryText, filters);
  }

  function handleSemanticContrast() {
    if (!response || !submittedSearchContext) {
      return;
    }
    setContrastBaselineResponse(response);
    void runSearch(submittedSearchContext.queryText, filters, { semanticContrast: true });
  }

  function applyNarrowSliceRefinement() {
    const nextFilters = { ...filtersRef.current, docType: "" };
    setFilters(nextFilters);
    void runSearch(queryText, nextFilters);
  }

  function handleRetryLastSearch() {
    const last = lastSearchParamsRef.current;
    if (!last) {
      return;
    }
    void runSearch(last.query, last.filters, {
      demoLaunch: last.demoLaunch,
      semanticContrast: last.semanticContrast,
    });
  }

  function applyCase(curatedCase: CuratedCase) {
    if (curatedCase.id !== recommendedDemo?.sourceCaseId) {
      markOffScript("alternate_case");
    }
    setQueryText(curatedCase.queryText);
    setFilters(toDraftFilters(curatedCase.filters));
    setJudgeRunProvenance(null);
    clearInterpretationState();
    setQueryHint(buildQueryRefinementHint(curatedCase.queryText, curatedCase.filters));
    invalidateSearchState("ready");
    setActiveCuratedCaseId(curatedCase.id);
    focusWorkspace();
  }

  function handleRunRecommendedDemo() {
    if (!recommendedDemo) {
      focusWorkspace();
      return;
    }

    setHasStartedRecommendedDemo(true);
    clearOffScriptState();
    const nextFilters = toDraftFilters(recommendedDemo.filters);
    setQueryText(recommendedDemo.queryText);
    setFilters(nextFilters);
    setActiveCuratedCaseId(recommendedDemo.sourceCaseId);
    clearInterpretationState();
    setQueryHint(buildQueryRefinementHint(recommendedDemo.queryText, nextFilters));
    focusWorkspace();
    void runSearch(recommendedDemo.queryText, nextFilters, { demoLaunch: recommendedDemo });
  }

  const resultsPackage = responseForFrozenWorkspace;
  const hasResults = (resultsPackage?.results.length ?? 0) > 0;
  const resultQuality = resultsPackage?.meta.resultQuality;
  const topLead = workspaceModel.topLead;
  const handoffReadiness = resultsPackage?.meta.handoffReadiness;
  const guidedDemoActive = judgeRunProvenance?.sourceCaseId === recommendedDemo?.sourceCaseId;
  const hasAppliedStructuredScope = Boolean(
    resultsPackage?.appliedFilter.filters?.cityCode ||
      resultsPackage?.appliedFilter.filters?.docType ||
      resultsPackage?.appliedFilter.filters?.startTimestamp ||
      resultsPackage?.appliedFilter.filters?.endTimestamp,
  );
  const hasRequestedStructuredScope =
    guidedDemoActive && judgeRunProvenance?.requestedScope !== "No structured scope";
  const guidedDemoScopeState: GuidedDemoScopeState = hasAppliedStructuredScope
    ? "applied"
    : hasRequestedStructuredScope
      ? "requested"
      : "none";
  const shouldShowOffScriptBanner = !hasStartedRecommendedDemo && offScriptReason !== "none";
  const isHandoffReady = handoffReadiness === "ready";
  const showResults =
    hasResults &&
    topLead !== null &&
    (status === "completed" ||
      (status === "running" && contrastBaselineResponse !== null));
  const suppressRetrievalTelemetry =
    status === "low_confidence" && hasResults && resultQuality?.status === "low_confidence";
  const provenanceDisclosure = useMemo(() => {
    const results = responseForFrozenWorkspace?.results ?? [];
    if (results.length === 0) {
      return {
        title: "Readable result provenance",
        body: "Trace will disclose whether readable excerpts came from backend excerpts or Trace-rendered text when results are available.",
      };
    }

    const backendCount = results.filter(
      (result) => result.provenanceSource === "backend",
    ).length;
    const synthesizedCount = results.filter(
      (result) => result.provenanceSource === "synthesized",
    ).length;

    if (synthesizedCount > 0) {
      return {
        title: "Synthesized reviewer text present",
        body: `Trace synthesized readable excerpts for ${synthesizedCount} result${synthesizedCount === 1 ? "" : "s"} in this package. Verify source record IDs and collections before treating those renderings as evidence.`,
      };
    }

    if (backendCount === results.length) {
      return {
        title: "Backend excerpts supplied",
        body: "Readable excerpts in this package were labeled as backend-provided, but they should still be checked against the cited source records before handoff.",
      };
    }

    return {
      title: "Provenance labeling unavailable",
      body: "This build did not label whether readable excerpts were backend-provided or Trace-rendered. Treat the text as a convenience layer and verify the cited records directly.",
    };
  }, [responseForFrozenWorkspace]);

  return (
    <div className="app-shell">
      <div className="background-radial background-radial-a" />
      <div className="background-radial background-radial-b" />
      <main className="app-panel">
        <TopBar
          health={health}
          onRunRecommended={handleRunRecommendedDemo}
          onTryOwnQuery={focusWorkspace}
          recommendedScenarioLabel={recommendedCuratedCase?.title}
        />

        <AuditArchiveFrame recommendedScenarioLabel={recommendedCuratedCase?.title} />

        <ComparisonStrip />

        <section
          ref={workspaceRef}
          className="workspace-hero workbench-card"
          aria-labelledby="workspaceHeading"
          tabIndex={-1}
        >
          <div className="workspace-hero-copy">
            <p className="eyebrow">Judge instructions</p>
            <h2 id="workspaceHeading">Use the recommended audit path first, then judge the handoff package it produces.</h2>
            <ol className="guided-demo-steps">
              <li className="guided-demo-step guided-demo-step-complete">
                <span className="guided-demo-step-index">01</span>
                <div>
                  <p className="guided-demo-step-label">Run this first</p>
                  <p className="guided-demo-step-body">
                    Run the recommended audit demo first. Use custom search only after you have
                    seen the guided path once.
                  </p>
                </div>
              </li>
              <li className="guided-demo-step guided-demo-step-complete">
                <span className="guided-demo-step-index">02</span>
                <div>
                  <p className="guided-demo-step-label">Evaluate this</p>
                  <p className="guided-demo-step-body">
                    Judge whether Trace keeps the requested audit slice visible from intake through
                    evidence selection and into the reviewer handoff.
                  </p>
                </div>
              </li>
              <li className="guided-demo-step guided-demo-step-complete">
                <span className="guided-demo-step-index">03</span>
                <div>
                  <p className="guided-demo-step-label">Success / failure</p>
                  <p className="guided-demo-step-body">
                    Success: the same scope stays visible, the top evidence stays inside it, and
                    the run ends with a reviewer-ready briefing. Failure: scope disappears or
                    drifts, the evidence is plausible but out of slice, or the flow cannot produce
                    a trustworthy handoff packet.
                  </p>
                </div>
              </li>
            </ol>
            <p className="workspace-proof-note">
              If you skip the recommended path, your evaluation may miss the main claim this demo
              is designed to prove.
            </p>
          </div>
        </section>

        <div className="workspace-grid">
          <div className="workspace-column workspace-column-left">
            <CuratedCaseRail cases={cases} onApplyCase={applyCase} />
            <InvestigationComposer
              queryText={queryText}
              filters={filters}
              status={status}
              validationMessage={validationMessage}
              offScriptNoticeVisible={shouldShowOffScriptBanner}
              offScriptNoticeAcknowledged={hasAcknowledgedOffScript}
              interpretationAvailable={interpretationAvailable}
              interpretationUnavailableMessage={interpretationUnavailableMessage}
              interpretationStatus={interpretationStatus}
              interpretationErrorMessage={interpretationErrorMessage}
              interpretationSuggestion={interpretationSuggestion}
              queryHint={queryHint}
              onQueryChange={handleQueryChange}
              onFiltersChange={handleFiltersChange}
              onInterpretScope={handleInterpretScope}
              onApplySuggestion={handleApplySuggestion}
              onRunRecommended={handleRunRecommendedDemo}
              onContinueManual={handleContinueManualExploration}
              onSubmit={handleSubmit}
            />
          </div>

          <div className="workspace-column workspace-column-right">
            <GuidedDemoStrip
              active={guidedDemoActive}
              status={status}
              hasResults={hasResults}
              scopeState={guidedDemoScopeState}
              handoffReadiness={handoffReadiness}
              topLeadLabel={topLead?.sourceRecordId ?? topLead?.incident_id}
            />

            <ReasoningStrip
              investigationRequest={workspaceModel.investigationRequest}
              activeScope={workspaceModel.activeScope}
              timeWindow={workspaceModel.timeWindow}
              queryModeLabel={workspaceModel.queryModeLabel}
              resultCount={workspaceModel.resultCount}
              latencyLabel={workspaceModel.latencyLabel}
              datasetLabel={resultsPackage?.meta.datasetLabel}
              datasetKind={resultsPackage?.meta.datasetKind}
              handoffReadiness={handoffReadiness}
              confidenceReasoning={resultsPackage?.meta.confidenceReasoning}
              resultQualityStatus={resultQuality?.status}
              resultQualitySummary={resultQuality?.summary}
              provenanceDisclosureTitle={provenanceDisclosure.title}
              provenanceDisclosureBody={provenanceDisclosure.body}
              suppressRetrievalTelemetry={suppressRetrievalTelemetry}
            />

            {status === "completed" &&
            response &&
            submittedSearchContext &&
            response.meta.queryMode === "scoped_hybrid" &&
            normalizeSearchFilters(submittedSearchContext.filters).cityCode &&
            normalizeSearchFilters(submittedSearchContext.filters).docType ? (
              <div className="semantic-contrast-bar">
                <button type="button" className="secondary-button" onClick={handleSemanticContrast}>
                  Run semantic-only contrast
                </button>
                <p className="support-copy">
                  Re-runs the same investigation request with semantic retrieval only (no typed
                  metadata filters on the server). Your prior scoped hybrid results stay on screen
                  until this arm finishes. Compare labels carefully - this is not an automatic
                  legal review.
                </p>
              </div>
            ) : null}

            {status === "running" && contrastBaselineResponse ? (
              <div className="contrast-loading-banner" role="status">
                Running semantic-only contrast. Scoped hybrid results stay visible until Trace finishes
                this arm.
                {searchAutoRetrying ? " Retrying once..." : null}
              </div>
            ) : null}

            {judgeRunProvenance ? (
              <section
                className="desk-card provenance-card"
                aria-labelledby="liveRunProvenanceHeading"
              >
                <div className="section-heading">
                  <p className="eyebrow">Run provenance</p>
                  <h2 id="liveRunProvenanceHeading">What launched this audit demo run.</h2>
                </div>
                <div className="handoff-grid">
                  <div className="handoff-item">
                    <p className="block-label">Demo path</p>
                    <p>{judgeRunProvenance.demoTitle}</p>
                  </div>
                  <div className="handoff-item">
                    <p className="block-label">Requested scope</p>
                    <p>{judgeRunProvenance.requestedScope}</p>
                  </div>
                  <div className="handoff-item">
                    <p className="block-label">Backend path</p>
                    <p>Browser UI to /api/search to the deployed Trace backend.</p>
                  </div>
                  <div className="handoff-item">
                    <p className="block-label">System status at launch</p>
                    <p>{judgeRunProvenance.startedAtState}</p>
                  </div>
                  {judgeRunProvenance.resultModeLabel ? (
                    <div className="handoff-item">
                      <p className="block-label">Returned retrieval mode</p>
                      <p>{judgeRunProvenance.resultModeLabel}</p>
                    </div>
                  ) : null}
                  {judgeRunProvenance.latencyLabel ? (
                    <div className="handoff-item">
                      <p className="block-label">Returned latency</p>
                      <p>{judgeRunProvenance.latencyLabel}</p>
                    </div>
                  ) : null}
                  {judgeRunProvenance.appliedScope ? (
                    <div className="handoff-item">
                      <p className="block-label">Returned scope</p>
                      <p>{judgeRunProvenance.appliedScope}</p>
                    </div>
                  ) : null}
                  {judgeRunProvenance.errorMessage ? (
                    <div className="handoff-item">
                      <p className="block-label">Failure surfaced in UI</p>
                      <p>{judgeRunProvenance.errorMessage}</p>
                    </div>
                  ) : null}
                  {judgeRunProvenance.guardrailSummary ? (
                    <div className="handoff-item">
                      <p className="block-label">Confidence guardrail</p>
                      <p>{judgeRunProvenance.guardrailSummary}</p>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            {status === "idle" ? (
              <StatePanel
                eyebrow="Ready state"
                title="Start with the recommended audit demo or bring the request your ops team actually received."
                body="Trace is most useful when a vague audit ask becomes a visible scope, a ranked evidence set, and a briefing someone else can review without redoing the search."
              />
            ) : null}

            {status === "ready" ? (
              <StatePanel
                eyebrow="Draft ready"
                title="Ready to test whether this audit request can become defensible evidence."
                body="Run the search to see whether Trace can narrow the archive into a usable working set. If the request still feels loose, you can use Interpret scope first when that helper is available."
              />
            ) : null}

            {status === "interpreting" ? (
              <StatePanel
                eyebrow="Scope assist"
                title="Turning the audit ask into explicit scope."
                body="Trace is looking for clear city, document, and date signals it can safely turn into structured scope before treating the search as evidence."
                steps={[
                  "Read the audit request",
                  "Extract safe scope signals",
                  "Return a reviewable suggestion",
                ]}
              />
            ) : null}

            {status === "running" ? (
              <StatePanel
                eyebrow="Live run"
                title={
                  searchRunPhase === "connecting"
                    ? "Starting the live Trace request."
                    : searchRunPhase === "searching"
                      ? "Waiting on archive retrieval."
                      : "Waiting for ranked evidence and briefing signals."
                }
                body={
                  searchAutoRetrying
                    ? "Retrying once after a transient timeout or server error. You can still use manual retry if this pass fails."
                    : searchRunPhase === "connecting"
                      ? "Trace has sent the request and is waiting for the live demo backend to respond."
                      : searchRunPhase === "searching"
                        ? "The request is still in flight; retrieval and typed scope application happen server-side before results return."
                        : "The request is still in flight; Trace will show ranked evidence and reviewer-facing explanations when the API responds."
                }
                steps={[
                  "Execute retrieval against the archive",
                  "Keep typed scope aligned with the investigation",
                  "Surface signals the next reviewer can verify",
                ]}
              />
            ) : null}

            {status === "invalid_input" && validationMessage ? (
              <StatePanel
                eyebrow="Input issue"
                title="Fix the request before running Trace."
                body={validationMessage}
                tone="warning"
              />
            ) : null}

            {status === "service_error" && errorMessage ? (
              <StatePanel
                eyebrow="System degraded"
                title="Search interrupted."
                body={`${errorMessage} Trace attempts one automatic retry for transient timeouts, network faults, and 502/503/504 responses. After that, use manual retry or wait for the backend to recover.`}
                tone="danger"
                footer={
                  <button type="button" className="secondary-button" onClick={handleRetryLastSearch}>
                    Retry search
                  </button>
                }
              />
            ) : null}

            {status === "no_results" ? (
              <StatePanel
                eyebrow="No defensible match"
                title="No trustworthy evidence package surfaced for this request."
                body={
                  activeCuratedCaseId === ZERO_RESULT_CASE_ID
                    ? "This city and document type are valid demo literals, but that pairing can still produce zero rows when the archive does not hold matching records together."
                    : "Trace could not find evidence strong enough to present in this scope. Tighten the event wording, widen one filter, or switch back to the recommended audit demo before drawing a conclusion."
                }
                tone="warning"
                steps={
                  activeCuratedCaseId === ZERO_RESULT_CASE_ID
                    ? [
                        "Confirm both filters are supported literals in the demo vocabulary.",
                        "Widen the slice by clearing the document type, then rerun once to see whether broader NYC rows appear.",
                        "If you need insurance-lapse narratives, consider the Chicago slice where that document type is emphasized in offline proof cases.",
                      ]
                    : undefined
                }
                footer={
                  activeCuratedCaseId === ZERO_RESULT_CASE_ID ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => applyNarrowSliceRefinement()}
                    >
                      Clear document type and rerun
                    </button>
                  ) : undefined
                }
              />
            ) : null}

            {status === "low_confidence" ? (
              <StatePanel
                eyebrow="Need narrower request"
                title="Trace is not confident enough to present this as a handoff-ready result."
                body={
                  resultQuality?.summary ??
                  queryHint?.body ??
                  "Add a supported city, document type, or time window before trusting the retrieval output."
                }
                tone="warning"
                steps={
                  resultQuality?.suggestions?.length
                    ? resultQuality.suggestions
                    : undefined
                }
              />
            ) : null}

            {status === "completed" && hasResults && resultQuality?.status === "review" ? (
              <StatePanel
                eyebrow="Operator review"
                title="Useful lead, but tighten the audit boundary before handoff."
                body={resultQuality.summary}
                tone="warning"
                steps={resultQuality.suggestions}
              />
            ) : null}

            {showResults && topLead && resultsPackage ? (
              <>
                <TopLeadCard
                  result={topLead}
                  filters={workspaceModel.submittedFilters}
                  searchResponse={resultsPackage}
                  handoffReadiness={handoffReadiness}
                  resultQualitySummary={resultQuality?.summary}
                />
                <EvidenceLadder
                  results={workspaceModel.supportingResults}
                  filters={workspaceModel.submittedFilters}
                  handoffReadiness={handoffReadiness}
                />
                {workspaceModel.handoffSummary && isHandoffReady ? (
                  <HandoffPanel
                    summary={workspaceModel.handoffSummary}
                    supportingCount={workspaceModel.supportingResults.length}
                    allowExport={isHandoffReady}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        <JudgeProofPanel
          recommendedDemoCard={recommendedDemo}
          onReplayRecommended={handleRunRecommendedDemo}
        />
      </main>
    </div>
  );
}

export default App;
