import type { FormEvent } from "react";
import type { SearchFilters, SearchStatus } from "../types";

const suggestedDocTypes = [
  "Safety_Incident_Log",
  "Insurance_Lapse_Report",
];

type InvestigationComposerProps = {
  queryText: string;
  filters: SearchFilters;
  status: SearchStatus;
  validationMessage: string | null;
  onQueryChange: (value: string) => void;
  onFiltersChange: (updater: (current: SearchFilters) => SearchFilters) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function InvestigationComposer({
  queryText,
  filters,
  status,
  validationMessage,
  onQueryChange,
  onFiltersChange,
  onSubmit,
}: InvestigationComposerProps) {
  return (
    <section className="workbench-card composer-card">
      <div className="section-heading">
        <p className="eyebrow">Investigation composer</p>
        <h2>Frame the request and lock the scope you can defend.</h2>
      </div>

      <form className="search-form" onSubmit={onSubmit}>
        <label className="field-label" htmlFor="queryText">
          Investigation request
        </label>
        <textarea
          id="queryText"
          name="queryText"
          className="query-input"
          rows={5}
          placeholder="Example: Find records that suggest a repeat safety problem in NYC that needs follow-up this quarter."
          value={queryText}
          onChange={(event) => onQueryChange(event.target.value)}
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
                onFiltersChange((current) => ({
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
                onFiltersChange((current) => ({
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
                onFiltersChange((current) => ({
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
                onFiltersChange((current) => ({
                  ...current,
                  endDate: event.target.value,
                }))
              }
            />
          </div>
        </div>

        {validationMessage ? (
          <div className="notice notice-warning" role="alert">
            {validationMessage}
          </div>
        ) : null}

        <div className="search-actions">
          <button className="primary-button" type="submit" disabled={status === "loading"}>
            {status === "loading" ? "Running Trace..." : "Assemble evidence trail"}
          </button>
          <p className="support-copy">
            The browser only sends requests to the app API. Embeddings and
            backend credentials stay server-side.
          </p>
        </div>
      </form>
    </section>
  );
}
