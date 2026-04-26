import type { SearchFilters, SearchResult } from "../types";
import {
  buildExcerpt,
  buildFilterMatchChips,
  formatScore,
  formatTimestamp,
} from "../utils";

type TopLeadCardProps = {
  result: SearchResult;
  filters: SearchFilters;
};

export function TopLeadCard({ result, filters }: TopLeadCardProps) {
  const chips = buildFilterMatchChips(result, filters);

  return (
    <article className="desk-card top-lead-card">
      <div className="lead-banner">
        <span className="lead-badge">Top lead</span>
        <span className="lead-score">Score {formatScore(result.score)}</span>
      </div>

      <div className="lead-header">
        <div>
          <p className="lead-id">{result.incident_id}</p>
          <h3>Primary evidence surfaced for review.</h3>
        </div>
        <p className="timestamp">{formatTimestamp(result.timestamp)}</p>
      </div>

      <div className="badge-row">
        <span className="badge">{result.city_code}</span>
        <span className="badge">{result.doc_type}</span>
        {chips.map((chip) => (
          <span className="match-chip" key={chip}>
            {chip}
          </span>
        ))}
      </div>

      <div className="lead-grid">
        <div className="lead-panel">
          <p className="block-label">Why it matters</p>
          <p>{result.why_this_matched}</p>
        </div>
        <div className="lead-panel">
          <p className="block-label">Excerpt</p>
          <p>{buildExcerpt(result)}</p>
        </div>
      </div>
    </article>
  );
}
