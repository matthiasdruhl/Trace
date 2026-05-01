import type { DatasetKind, HandoffReadiness, ResultQualityStatus } from "../types";

type ReasoningStripProps = {
  investigationRequest: string;
  activeScope: string;
  timeWindow: string;
  queryModeLabel: string;
  resultCount: number;
  latencyLabel: string;
  datasetLabel?: string;
  datasetKind?: DatasetKind;
  handoffReadiness?: HandoffReadiness;
  confidenceReasoning?: string[];
  resultQualityStatus?: ResultQualityStatus;
  resultQualitySummary?: string;
  provenanceDisclosureTitle?: string;
  provenanceDisclosureBody?: string;
  /** When true, retrieval counters are withheld (e.g. server low_confidence with results returned). */
  suppressRetrievalTelemetry?: boolean;
};

function humanizeDatasetKind(datasetKind: DatasetKind | undefined): string {
  switch (datasetKind) {
    case "regulatory_archive":
      return "Regulatory archive";
    case "curated_case_fixture":
      return "Curated case fixture";
    case "mixed":
      return "Mixed evidence set";
    default:
      return "Dataset kind not supplied";
  }
}

function describeHandoffReadiness(
  handoffReadiness: HandoffReadiness | undefined,
  resultCount: number,
) {
  switch (handoffReadiness) {
    case "ready":
      return {
        label: "Ready for handoff",
        body: "Trace considers this package scoped enough for a reviewer briefing.",
        tone: "ready",
      } as const;
    case "not_trustworthy":
      return {
        label: "Handoff blocked",
        body:
          resultCount === 0
            ? "Trace did not surface evidence in this scope, so there is no result package to pass forward."
            : "Trace is withholding a briefing-grade conclusion until the evidence is safer to trust.",
        tone: "blocked",
      } as const;
    default:
      return {
        label: "Review required",
        body:
          resultCount === 0
            ? "Trace did not surface evidence yet, and a person needs to tighten the request before retrying."
            : "Trace surfaced useful material, but a person still needs to tighten or validate the result package.",
        tone: "review",
      } as const;
  }
}

export function ReasoningStrip({
  investigationRequest,
  activeScope,
  timeWindow,
  queryModeLabel,
  resultCount,
  latencyLabel,
  datasetLabel,
  datasetKind,
  handoffReadiness,
  confidenceReasoning = [],
  resultQualityStatus,
  resultQualitySummary,
  provenanceDisclosureTitle,
  provenanceDisclosureBody,
  suppressRetrievalTelemetry = false,
}: ReasoningStripProps) {
  const modeDisplay = suppressRetrievalTelemetry
    ? "Withheld until scope is tightened"
    : queryModeLabel;
  const countDisplay = suppressRetrievalTelemetry
    ? "Withheld pending confidence review"
    : `${resultCount} result${resultCount === 1 ? "" : "s"}`;
  const latencyDisplay = suppressRetrievalTelemetry
    ? "Withheld until scope is tightened"
    : latencyLabel;
  const readiness = describeHandoffReadiness(handoffReadiness, resultCount);
  const showTrustSummary =
    datasetLabel !== undefined ||
    datasetKind !== undefined ||
    handoffReadiness !== undefined ||
    confidenceReasoning.length > 0 ||
    resultQualityStatus !== undefined ||
    resultQualitySummary !== undefined ||
    provenanceDisclosureBody !== undefined;

  return (
    <section className="desk-card reasoning-strip" aria-labelledby="reasoningHeading">
      <div className="reasoning-header">
        <p className="eyebrow">Search frame</p>
        <h2 id="reasoningHeading">What Trace is currently trying to prove.</h2>
      </div>

      {showTrustSummary ? (
        <section className="trust-strip" aria-label="Trust summary">
          <div className="trust-strip-header">
            <div>
              <p className="block-label">Trust summary</p>
              <p className="trust-strip-title">
                What this result package is grounded in before anyone treats it as evidence.
              </p>
            </div>
            <span className={`trust-status-pill trust-status-pill-${readiness.tone}`}>
              {readiness.label}
            </span>
          </div>

          <div className="trust-grid">
            <div className="trust-item">
              <span className="reasoning-label">Dataset in play</span>
              <p className="reasoning-value">
                {datasetLabel ?? "Dataset label unavailable"}
              </p>
              <p className="trust-item-copy">{humanizeDatasetKind(datasetKind)}</p>
            </div>
            <div className="trust-item">
              <span className="reasoning-label">Handoff posture</span>
              <p className="reasoning-value">{readiness.label}</p>
              <p className="trust-item-copy">{readiness.body}</p>
            </div>
            <div className="trust-item">
              <span className="reasoning-label">Backend trust call</span>
              <p className="reasoning-value">
                {resultQualityStatus ? resultQualityStatus.replace(/_/g, " ") : "Not supplied"}
              </p>
              <p className="trust-item-copy">
                {resultQualitySummary ?? "Trace did not return a result quality summary for this run."}
              </p>
            </div>
            <div className="trust-item">
              <span className="reasoning-label">
                {provenanceDisclosureTitle ?? "Readable result provenance"}
              </span>
              <p className="reasoning-value">Trace-rendered reviewer text</p>
              <p className="trust-item-copy">
                {provenanceDisclosureBody ??
                  "Verify source record identifiers and collections before reusing any readable excerpt or briefing text outside Trace."}
              </p>
            </div>
          </div>

          <div className="trust-reasoning">
            <p className="block-label">Confidence reasoning</p>
            {confidenceReasoning.length > 0 ? (
              <ul className="confidence-reasoning-list">
                {confidenceReasoning.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p className="trust-item-copy">
                Trace did not return additional confidence reasoning for this run.
              </p>
            )}
          </div>
        </section>
      ) : null}

      <div className="reasoning-grid">
        <div className="reasoning-item reasoning-item-wide">
          <span className="reasoning-label">Question</span>
          <p className="reasoning-value">{investigationRequest}</p>
        </div>
        <div className="reasoning-item reasoning-item-wide">
          <span className="reasoning-label">Active scope</span>
          <p className="reasoning-value">{activeScope}</p>
        </div>
        <div className="reasoning-item">
          <span className="reasoning-label">Time window</span>
          <p className="reasoning-value reasoning-meta">{timeWindow}</p>
        </div>
        <div className="reasoning-item">
          <span className="reasoning-label">Current result set</span>
          <p className="reasoning-value reasoning-meta">{countDisplay}</p>
        </div>
      </div>

      <details className="details-panel">
        <summary>Show run details</summary>
        <div className="details-panel-body">
          <p>
            <strong>Retrieval mode:</strong> {modeDisplay}
          </p>
          <p>
            <strong>Latency:</strong> {latencyDisplay}
          </p>
        </div>
      </details>
    </section>
  );
}
