const recordFamilies = [
  "Safety incidents",
  "Insurance lapses",
  "Inspection audits",
  "Permit renewals",
  "Background flags",
  "Privacy requests",
];

type AuditArchiveFrameProps = {
  recommendedScenarioLabel?: string | null;
};

export function AuditArchiveFrame({
  recommendedScenarioLabel,
}: AuditArchiveFrameProps) {
  return (
    <section
      className="workbench-card"
      aria-labelledby="auditArchiveHeading"
    >
      <div className="section-heading">
        <p className="eyebrow">What you&apos;re auditing</p>
        <h2 id="auditArchiveHeading">Synthetic ride-hailing compliance archive</h2>
        <p className="support-copy">
          This demo archive is synthetic. It frames preserved compliance records from a
          ride-hailing operation so the judge path can show how Trace scopes, reviews, and
          hands off audit evidence without changing the backend contract.
        </p>
        <p className="support-copy">
          You are auditing how Trace handles this synthetic archive request, not judging
          dataset realism or backend internals.
        </p>
      </div>

      <div className="handoff-grid" aria-label="Archive record families">
        {recordFamilies.map((family) => (
          <article key={family} className="handoff-item">
            <p className="block-label">Record family</p>
            <p>{family}</p>
          </article>
        ))}
      </div>

      <div className="workspace-proof-line">
        <span className="workspace-proof-chip">
          Recommended judge path: {recommendedScenarioLabel ?? "Recommended archive audit demo"}
        </span>
        <span className="workspace-proof-note">
          Use the recommended path to see the synthetic archive flow first, then use the
          manual workspace for contrast if you need it.
        </span>
      </div>
    </section>
  );
}
