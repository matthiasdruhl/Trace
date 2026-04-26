import type { HandoffSummary } from "../types";

type HandoffPanelProps = {
  summary: HandoffSummary;
};

export function HandoffPanel({ summary }: HandoffPanelProps) {
  return (
    <section className="desk-card handoff-panel" aria-labelledby="handoffHeading">
      <div className="section-heading">
        <p className="eyebrow">Defensible handoff</p>
        <h2 id="handoffHeading">What to carry forward from this run.</h2>
      </div>

      <div className="handoff-grid">
        <div className="handoff-item">
          <p className="block-label">Investigation goal</p>
          <p>{summary.goal}</p>
        </div>
        <div className="handoff-item">
          <p className="block-label">Applied scope</p>
          <p>{summary.appliedScope}</p>
        </div>
        <div className="handoff-item">
          <p className="block-label">Primary evidence</p>
          <p>{summary.primaryEvidence}</p>
        </div>
        <div className="handoff-item">
          <p className="block-label">Suggested handoff</p>
          <p>{summary.suggestedHandoff}</p>
        </div>
      </div>
    </section>
  );
}
