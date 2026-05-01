export function ComparisonStrip() {
  return (
    <section
      className="comparison-strip workbench-card"
      aria-label="Value proof"
    >
      <div className="comparison-strip-copy">
        <p className="eyebrow">Before and after</p>
        <h2 className="comparison-strip-title">
          Manual audit review is slow and scattered. Trace compresses it into one visible workflow.
        </h2>
        <p className="comparison-strip-summary">
          The recommended demo uses sample archive data to show the same task move from
          vague request to narrowed evidence and reviewer briefing in one run.
        </p>
      </div>
      <div className="comparison-strip-inner">
        <article className="comparison-strip-item">
          <h3 className="comparison-strip-heading">Manual archive review</h3>
          <p className="comparison-strip-body">
            Open multiple systems, guess the audit slice by hand, collect record IDs in notes,
            and rewrite the same context for the next reviewer.
          </p>
        </article>
        <article className="comparison-strip-item">
          <h3 className="comparison-strip-heading">With Trace</h3>
          <p className="comparison-strip-body">
            Run one scoped search, inspect named records with source details, and hand the next
            reviewer a briefing without rebuilding the search context from scratch.
          </p>
        </article>
        <article className="comparison-strip-item">
          <h3 className="comparison-strip-heading">Why Codex mattered</h3>
          <p className="comparison-strip-body">
            Codex accelerated iteration on the hardest product surfaces at once:
            guided demo flow, trust gating, reviewer handoff, and optional scope assistance.
          </p>
        </article>
      </div>
    </section>
  );
}
