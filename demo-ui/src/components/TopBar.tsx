import type { HealthState } from "../types";

type TopBarProps = {
  health: HealthState;
  onRunRecommended: () => void;
  onTryOwnQuery: () => void;
  recommendedScenarioLabel?: string | null;
};

function buildRecommendedActionLabel(recommendedScenarioLabel?: string | null): string {
  if (!recommendedScenarioLabel) {
    return "Run recommended audit demo";
  }

  return `Run recommended ${recommendedScenarioLabel}`;
}

export function TopBar({
  health,
  onRunRecommended,
  onTryOwnQuery,
  recommendedScenarioLabel,
}: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar-copy">
        <p className="eyebrow">Trace for operations teams</p>
        <h1>
          Turn a vague compliance audit request into narrowed evidence and a
          handoff-ready briefing.
        </h1>
        <p className="top-bar-lede">
          Trace is built for ops teams answering audit, compliance, and oversight
          asks against cold archives. It narrows the request, surfaces the strongest
          records, and packages the result for a fast handoff.
        </p>

        <div className="top-bar-actions">
          <button
            className="primary-button"
            type="button"
            onClick={onRunRecommended}
          >
            {buildRecommendedActionLabel(recommendedScenarioLabel)}
          </button>
          <button className="secondary-button" type="button" onClick={onTryOwnQuery}>
            Draft my own audit request
          </button>
        </div>
        <p className="support-copy">
          Start with the recommended judge path first, then use the judge instructions
          block below to evaluate whether Trace preserves scope through the guided audit
          flow. Manual exploration stays available, but it is intentionally secondary.
        </p>

        <div className="top-bar-facts" aria-label="What Trace is for">
          <article className="top-bar-fact">
            <p className="block-label">What it is</p>
            <p>A cold-archive audit response workflow, not a generic chat answer.</p>
          </article>
          <article className="top-bar-fact">
            <p className="block-label">Who it&apos;s for</p>
            <p>Ops and compliance teams handling rare, high-consequence archive requests.</p>
          </article>
          <article className="top-bar-fact">
            <p className="block-label">Why Codex mattered</p>
            <p>Codex sped up iteration on the live workflow, trust gating, reviewer handoff, and optional scope assist.</p>
          </article>
        </div>

        <p className="top-bar-proof">
          Best for occasional, high-consequence archive searches where staying inside
          the audit slice matters as much as retrieval quality.
        </p>
      </div>

      <div
        className={`health-pill ${health.ready ? "health-pill-ready" : "health-pill-down"}`}
        aria-live="polite"
      >
        <span className="health-indicator" aria-hidden="true" />
        <div>
          <span className="health-pill-label">System status</span>
          <span className="health-pill-value">{health.label}</span>
        </div>
      </div>
    </header>
  );
}
