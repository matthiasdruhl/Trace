import type { SearchFilters, SearchResult } from "../types";
import {
  buildExcerpt,
  buildFilterMatchChips,
  formatScore,
  formatTimestamp,
  humanizeDocType,
} from "../utils";

type EvidenceCardProps = {
  index: number;
  result: SearchResult;
  filters: SearchFilters;
};

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

export function EvidenceCard({ index, result, filters }: EvidenceCardProps) {
  const chips = buildFilterMatchChips(result, filters);
  const sourceExcerpt = result.sourceExcerpt.trim() || buildExcerpt(result);

  return (
    <article className="evidence-card">
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
          <p className="block-label">Evidence excerpt</p>
          <p>{sourceExcerpt}</p>
        </div>
      </div>

      <div className="source-grid">
        <div className="source-fact">
          <p className="block-label">Source record</p>
          <p>{result.sourceRecordId}</p>
        </div>
        <div className="source-fact">
          <p className="block-label">Collection</p>
          <p>{result.sourceCollection}</p>
        </div>
        <div className="source-fact">
          <p className="block-label">Handling</p>
          <p>
            {humanizeClassification(result.dataClassification)} with{" "}
            {humanizeRedactionStatus(result.redactionStatus).toLowerCase()}.
          </p>
        </div>
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
