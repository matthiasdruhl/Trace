import type { HandoffReadiness, SearchFilters, SearchResult } from "../types";
import {
  buildExcerpt,
  buildFilterMatchChips,
  formatScore,
  formatTimestamp,
  humanizeDocType,
} from "../utils";

type EvidenceLadderProps = {
  results: SearchResult[];
  filters: SearchFilters;
  handoffReadiness?: HandoffReadiness;
};

function describeEvidenceLadderCopy(handoffReadiness: HandoffReadiness | undefined): string {
  switch (handoffReadiness) {
    case "ready":
      return "Records that reinforce the same lead before it leaves Trace.";
    case "review_only":
      return "Records that may reinforce the lead once a reviewer tightens the audit boundary.";
    case "not_trustworthy":
      return "Records worth inspecting while Trace is still blocking trust in the overall package.";
    default:
      return "Records that may strengthen the same lead.";
  }
}

function describeExcerptProvenance(result: SearchResult): string {
  switch (result.provenanceSource) {
    case "backend":
      return "Backend supplied this readable excerpt directly.";
    case "synthesized":
      return "Trace synthesized this readable excerpt from available source text or metadata.";
    default:
      return "This build did not label excerpt provenance. Verify the source record before reusing the excerpt.";
  }
}

function humanizeClassification(classification: SearchResult["dataClassification"]): string {
  switch (classification) {
    case "public":
      return "Public";
    case "internal":
      return "Internal";
    case "confidential":
      return "Confidential";
    case "restricted":
      return "Restricted";
    default:
      return "Classification unknown";
  }
}

function humanizeRedactionStatus(redactionStatus: SearchResult["redactionStatus"]): string {
  switch (redactionStatus) {
    case "none":
      return "No redaction";
    case "partial":
      return "Partial redaction";
    case "full":
      return "Full redaction";
    default:
      return "Redaction status unknown";
  }
}

function renderEvidenceRecord(
  result: SearchResult,
  index: number,
  filters: SearchFilters,
) {
  const chips = buildFilterMatchChips(result, filters);
  const sourceExcerpt = result.sourceExcerpt.trim() || buildExcerpt(result);

  return (
    <article className="evidence-card" key={`${result.incident_id}-${index}`}>
      <div className="evidence-step">
        <span className="evidence-rank">Support {String(index + 1).padStart(2, "0")}</span>
        <span className="timestamp">{formatTimestamp(result.timestamp)}</span>
      </div>

      <div className="result-meta-row">
        <div>
          <p className="result-title">{humanizeDocType(result.doc_type)}</p>
          <p className="result-subtitle">{result.city_code}</p>
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="badge-row match-chip-row">
          {chips.map((chip, chipIndex) => (
            <span className="match-chip" key={`${chip}-${chipIndex}`}>
              {chip}
            </span>
          ))}
        </div>
      ) : null}

      <div className="evidence-copy">
        <div>
          <p className="block-label">Why it matched</p>
          <p>{result.why_this_matched}</p>
        </div>
        <div>
          <p className="block-label">Readable excerpt shown in Trace</p>
          <p>{sourceExcerpt}</p>
        </div>
        <div>
          <p className="block-label">Readable excerpt provenance</p>
          <p>{describeExcerptProvenance(result)}</p>
        </div>
        <section className="evidence-source-panel" aria-label="Source inspection">
          <div className="evidence-source-header">
            <p className="block-label">Source inspection</p>
            <div className="badge-row">
              <span className="source-badge">
                {humanizeClassification(result.dataClassification)} classification
              </span>
              <span className="source-badge">
                {humanizeRedactionStatus(result.redactionStatus)}
              </span>
            </div>
          </div>

          <div className="evidence-source-grid">
            <div className="source-fact">
              <p className="block-label">Source record</p>
              <p>{result.sourceRecordId}</p>
            </div>
            <div className="source-fact">
              <p className="block-label">Collection</p>
              <p>{result.sourceCollection}</p>
            </div>
          </div>
        </section>
      </div>

      <div className="score-row">
        <span>Relevance score</span>
        <span>{formatScore(result.score)}</span>
      </div>

      <details className="details-panel">
        <summary>Details</summary>
        <div className="details-panel-body">
          <p>
            <strong>Incident ID:</strong> {result.incident_id}
          </p>
          <p>
            <strong>Timestamp:</strong> {result.timestamp}
          </p>
        </div>
      </details>
    </article>
  );
}

export function EvidenceLadder({
  results,
  filters,
  handoffReadiness,
}: EvidenceLadderProps) {
  if (results.length === 0) {
    return null;
  }

  const visibleResults = results.slice(0, 2);
  const overflowResults = results.slice(2);

  return (
    <section className="desk-card evidence-ladder" aria-labelledby="evidenceLadderHeading">
      <div className="section-heading">
        <p className="eyebrow">Supporting evidence</p>
        <h2 id="evidenceLadderHeading">{describeEvidenceLadderCopy(handoffReadiness)}</h2>
      </div>

      <div className="evidence-ladder-list">
        {visibleResults.map((result, index) => renderEvidenceRecord(result, index, filters))}
      </div>

      {overflowResults.length > 0 ? (
        <details className="details-panel">
          <summary>
            Show {overflowResults.length} more supporting record
            {overflowResults.length === 1 ? "" : "s"}
          </summary>
          <div className="evidence-ladder-list">
            {overflowResults.map((result, index) =>
              renderEvidenceRecord(result, index + visibleResults.length, filters),
            )}
          </div>
        </details>
      ) : null}
    </section>
  );
}
