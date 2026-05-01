import type { SearchFilters, ScopeInterpretationSuggestion } from "../types";

type ScopeSuggestionPanelProps = {
  suggestion: ScopeInterpretationSuggestion;
  onApplySuggestion: () => void;
};

function buildSuggestedFilterBadges(filters: SearchFilters): string[] {
  const badges: string[] = [];

  if (filters.cityCode) {
    badges.push(`City ${filters.cityCode}`);
  }

  if (filters.docType) {
    badges.push(`Document type ${filters.docType}`);
  }

  if (filters.startDate) {
    badges.push(`From ${filters.startDate}`);
  }

  if (filters.endDate) {
    badges.push(`Through ${filters.endDate}`);
  }

  return badges;
}

export function ScopeSuggestionPanel({
  suggestion,
  onApplySuggestion,
}: ScopeSuggestionPanelProps) {
  const suggestedBadges = buildSuggestedFilterBadges(suggestion.suggestedFilters);
  const canApplySuggestion = suggestedBadges.length > 0;

  return (
    <section className="scope-suggestion-card" aria-live="polite">
      <div className="scope-suggestion-header">
        <p className="eyebrow">Scope suggestion</p>
        <h3>
          {canApplySuggestion
            ? "Scope suggestion ready for review"
            : "Interpretation outcome"}
        </h3>
      </div>

      <p className="scope-suggestion-summary">{suggestion.summary}</p>

      {suggestedBadges.length > 0 ? (
        <div className="badge-row scope-badge-row" aria-label="Suggested filters">
          {suggestedBadges.map((badge) => (
            <span key={badge} className="scope-badge">
              {badge}
            </span>
          ))}
        </div>
      ) : (
        <div className="notice notice-neutral" role="status">
          Trace did not find a safe structured scope to copy into the filters.
        </div>
      )}

      {suggestion.appliedSignals.length > 0 ? (
        <div className="scope-detail-block">
          <span className="block-label">Why Trace suggested this scope</span>
          <div className="scope-signal-list">
            {suggestion.appliedSignals.map((signal) => (
              <div
                key={`${signal.field}-${signal.sourceText}-${signal.normalizedValue}`}
                className="scope-signal"
              >
                <p className="scope-signal-heading">
                  <strong>{signal.sourceText}</strong> {"\u2192"} {signal.normalizedValue}
                </p>
                <p className="scope-signal-copy">{signal.rationale}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {suggestion.unresolvedSignals.length > 0 || suggestion.warnings.length > 0 ? (
        <div className="notice notice-warning" role="status">
          {suggestion.unresolvedSignals.length > 0 ? (
            <>
              <strong>Needs operator judgment:</strong>{" "}
              {suggestion.unresolvedSignals.join(", ")}
            </>
          ) : null}
          {suggestion.unresolvedSignals.length > 0 && suggestion.warnings.length > 0 ? <br /> : null}
          {suggestion.warnings.length > 0 ? (
            <>
              <strong>Warnings:</strong>{" "}
              {suggestion.warnings.join(" \u2022 ")}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="scope-suggestion-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={onApplySuggestion}
          disabled={!canApplySuggestion}
        >
          Apply suggestion
        </button>
        <p className="support-copy">
          Review the scope first. Applying the suggestion only updates the filter
          inputs and never runs search automatically.
        </p>
      </div>
    </section>
  );
}
