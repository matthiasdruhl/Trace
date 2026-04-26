type ReasoningStripProps = {
  investigationRequest: string;
  activeScope: string;
  timeWindow: string;
  queryModeLabel: string;
  resultCount: number;
  latencyLabel: string;
};

export function ReasoningStrip({
  investigationRequest,
  activeScope,
  timeWindow,
  queryModeLabel,
  resultCount,
  latencyLabel,
}: ReasoningStripProps) {
  return (
    <section className="desk-card reasoning-strip" aria-labelledby="reasoningHeading">
      <div className="reasoning-header">
        <p className="eyebrow">Trace reasoning</p>
        <h2 id="reasoningHeading">Interpreted request and active scope.</h2>
      </div>

      <div className="reasoning-grid">
        <div className="reasoning-item reasoning-item-wide">
          <span className="reasoning-label">Investigation request</span>
          <p className="reasoning-value">{investigationRequest}</p>
        </div>
        <div className="reasoning-item reasoning-item-wide">
          <span className="reasoning-label">Applied scope</span>
          <p className="reasoning-value">{activeScope}</p>
        </div>
        <div className="reasoning-item">
          <span className="reasoning-label">Time window</span>
          <p className="reasoning-value reasoning-meta">{timeWindow}</p>
        </div>
        <div className="reasoning-item">
          <span className="reasoning-label">Retrieval mode</span>
          <p className="reasoning-value reasoning-meta">{queryModeLabel}</p>
        </div>
        <div className="reasoning-item">
          <span className="reasoning-label">Result count</span>
          <p className="reasoning-value reasoning-meta">
            {resultCount} result{resultCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="reasoning-item">
          <span className="reasoning-label">Latency</span>
          <p className="reasoning-value reasoning-meta">{latencyLabel}</p>
        </div>
      </div>
    </section>
  );
}
