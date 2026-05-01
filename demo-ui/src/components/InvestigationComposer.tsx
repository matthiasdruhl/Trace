import type { FormEvent } from "react";
import {
  archiveCityOptions,
  archiveComposerHelperCopy,
  archiveDocTypeOptions,
  archiveExamplePrompts,
} from "../archiveVocabulary";
import type { ArchiveExamplePrompt } from "../archiveVocabulary";
import type {
  QueryRefinementHint,
  SearchFilters,
  ScopeInterpretationSuggestion,
  SearchStatus,
} from "../types";
import { ScopeSuggestionPanel } from "./ScopeSuggestionPanel";

type InvestigationComposerProps = {
  queryText: string;
  filters: SearchFilters;
  status: SearchStatus;
  validationMessage: string | null;
  offScriptNoticeVisible: boolean;
  offScriptNoticeAcknowledged: boolean;
  interpretationAvailable: boolean;
  interpretationUnavailableMessage: string | null;
  interpretationStatus: "idle" | "loading" | "success" | "error";
  interpretationErrorMessage: string | null;
  interpretationSuggestion: ScopeInterpretationSuggestion | null;
  queryHint: QueryRefinementHint | null;
  onQueryChange: (value: string, source?: "manual_edit" | "example_prompt") => void;
  onFiltersChange: (
    updater: (current: SearchFilters) => SearchFilters,
    source?: "manual_edit" | "example_prompt",
  ) => void;
  onInterpretScope: () => void;
  onApplySuggestion: () => void;
  onRunRecommended: () => void;
  onContinueManual: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function InvestigationComposer({
  queryText,
  filters,
  status,
  validationMessage,
  offScriptNoticeVisible,
  offScriptNoticeAcknowledged,
  interpretationAvailable,
  interpretationUnavailableMessage,
  interpretationStatus,
  interpretationErrorMessage,
  interpretationSuggestion,
  queryHint,
  onQueryChange,
  onFiltersChange,
  onInterpretScope,
  onApplySuggestion,
  onRunRecommended,
  onContinueManual,
  onSubmit,
}: InvestigationComposerProps) {
  const hasQuery = queryText.trim().length > 0;
  const canInterpretScope =
    interpretationAvailable && interpretationStatus !== "loading" && hasQuery;
  const canRunSearch = hasQuery && status !== "running";

  function applyExamplePrompt(examplePrompt: ArchiveExamplePrompt) {
    onQueryChange(examplePrompt.queryText, "example_prompt");
    onFiltersChange((current) => ({
      cityCode: examplePrompt.filters.cityCode ?? "",
      docType: examplePrompt.filters.docType ?? "",
      startDate: examplePrompt.filters.startDate ?? current.startDate ?? "",
      endDate: examplePrompt.filters.endDate ?? current.endDate ?? "",
    }), "example_prompt");
  }

  return (
    <section className="workbench-card composer-card">
      <div className="section-heading">
        <p className="eyebrow">Manual workflow</p>
        <h2>Frame a request, tighten the scope, then run the search.</h2>
        <p className="composer-lede">
          Start with one concrete event pattern. Add filters only when they help
          you draw a narrower conclusion.
        </p>
        <p className="support-copy">
          Use manual workflow after the recommended demo or when intentionally testing deviation
          behavior.
        </p>
        <p className="support-copy">{archiveComposerHelperCopy}</p>
      </div>

      <form className="search-form" onSubmit={onSubmit}>
        {offScriptNoticeVisible ? (
          <div
            className={`notice composer-sticky-notice ${offScriptNoticeAcknowledged ? "notice-neutral" : "notice-warning"}`}
          >
            <strong>
              {offScriptNoticeAcknowledged
                ? "Manual exploration active."
                : "Recommended judge path not yet run."}
            </strong>{" "}
            {offScriptNoticeAcknowledged
              ? "Useful for contrast, but not the primary judge path."
              : "You can explore manually here, but that path may not show the core claim this demo is designed to prove. Run the recommended audit first if you want to evaluate whether Trace preserves scope all the way to a reviewer-ready briefing."}
            {!offScriptNoticeAcknowledged ? (
              <div className="search-action-row">
                <button className="primary-button" type="button" onClick={onRunRecommended}>
                  Run recommended demo
                </button>
                <button className="secondary-button" type="button" onClick={onContinueManual}>
                  Continue manual exploration
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="badge-row" aria-label="Example archive prompts">
          {archiveExamplePrompts.map((examplePrompt) => (
            <button
              key={examplePrompt.id}
              className="secondary-button"
              type="button"
              onClick={() => applyExamplePrompt(examplePrompt)}
            >
              {examplePrompt.label}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="queryText">
          Investigation request
        </label>
        <textarea
          id="queryText"
          name="queryText"
          className="query-input"
          rows={5}
          placeholder="Example: Safety incident narratives in New York that look like repeat reporting issues this quarter."
          value={queryText}
          onChange={(event) => onQueryChange(event.target.value, "manual_edit")}
        />

        <div className="filter-grid" aria-label="Structured filters">
          <div className="field-group">
            <label className="field-label" htmlFor="cityCode">
              City
            </label>
            <select
              id="cityCode"
              name="cityCode"
              className="text-input"
              value={filters.cityCode ?? ""}
              onChange={(event) =>
                onFiltersChange((current) => ({
                  ...current,
                  cityCode: event.target.value,
                }), "manual_edit")
              }
            >
              <option value="">Any city</option>
              {archiveCityOptions.map((cityOption) => (
                <option key={cityOption.value} value={cityOption.value}>
                  {cityOption.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label className="field-label" htmlFor="docType">
              Document type
            </label>
            <select
              id="docType"
              name="docType"
              className="text-input text-input-doc-type"
              value={filters.docType ?? ""}
              onChange={(event) =>
                onFiltersChange((current) => ({
                  ...current,
                  docType: event.target.value,
                }), "manual_edit")
              }
            >
              <option value="">Any document type</option>
              {archiveDocTypeOptions.map((docTypeOption) => (
                <option key={docTypeOption.value} value={docTypeOption.value}>
                  {docTypeOption.label}
                </option>
              ))}
            </select>
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
                onFiltersChange((current) => ({
                  ...current,
                  startDate: event.target.value,
                }), "manual_edit")
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
                onFiltersChange((current) => ({
                  ...current,
                  endDate: event.target.value,
                }), "manual_edit")
              }
            />
          </div>
        </div>

        {queryHint ? (
          <div
            className={`notice ${queryHint.blocking ? "notice-warning" : "notice-neutral"}`}
            role="status"
          >
            <strong>{queryHint.title}:</strong> {queryHint.body}
          </div>
        ) : null}

        {validationMessage ? (
          <div className="notice notice-warning" role="alert">
            {validationMessage}
          </div>
        ) : null}

        {interpretationErrorMessage ? (
          <div className="notice notice-warning" role="alert">
            {interpretationErrorMessage}
          </div>
        ) : null}

        {interpretationUnavailableMessage ? (
          <div className="notice notice-neutral" role="status">
            {interpretationUnavailableMessage}
          </div>
        ) : null}

        {interpretationSuggestion ? (
          <ScopeSuggestionPanel
            suggestion={interpretationSuggestion}
            onApplySuggestion={onApplySuggestion}
          />
        ) : null}

        <div className="search-actions">
          <div className="search-action-row">
            <button
              className="secondary-button"
              type="button"
              disabled={!canInterpretScope}
              onClick={onInterpretScope}
            >
              {interpretationStatus === "loading"
                ? "Interpreting scope..."
                : "Interpret scope"}
            </button>
            <button
              className={`primary-button${status === "running" ? " primary-button--loading" : ""}`}
              type="submit"
              disabled={!canRunSearch}
            >
              {status === "running" ? "Running Trace..." : "Run live search"}
            </button>
          </div>
          <p className="support-copy">
            The browser only talks to the app API. Embeddings, credentials, and
            archive access stay server-side.
          </p>
        </div>
      </form>
    </section>
  );
}
