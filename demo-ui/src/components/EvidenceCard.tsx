import type { SearchFilters, SearchResult } from "../types";
import {
  buildExcerpt,
  buildFilterMatchChips,
  formatScore,
  formatTimestamp,
} from "../utils";

type EvidenceCardProps = {
  index: number;
  result: SearchResult;
  filters: SearchFilters;
};

export function EvidenceCard({ index, result, filters }: EvidenceCardProps) {
  const chips = buildFilterMatchChips(result, filters);

  return (
    <article className="evidence-card">
      <div className="evidence-step">
        <span className="evidence-rank">Support {String(index + 1).padStart(2, "0")}</span>
        <span className="timestamp">{formatTimestamp(result.timestamp)}</span>
      </div>

      <div className="result-meta-row">
        <span className="result-id">{result.incident_id}</span>
        <div className="badge-row">
          <span className="badge">{result.city_code}</span>
          <span className="badge">{result.doc_type}</span>
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="badge-row match-chip-row">
          {chips.map((chip) => (
            <span className="match-chip" key={chip}>
              {chip}
            </span>
          ))}
        </div>
      ) : null}

      <div className="evidence-copy">
        <div>
          <p className="block-label">Excerpt</p>
          <p>{buildExcerpt(result)}</p>
        </div>
        <div>
          <p className="block-label">Result context</p>
          <p>{result.why_this_matched}</p>
        </div>
      </div>

      <div className="score-row">
        <span>Relevance score</span>
        <span>{formatScore(result.score)}</span>
      </div>
    </article>
  );
}
