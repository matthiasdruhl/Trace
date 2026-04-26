import type { SearchFilters, SearchResult } from "../types";
import { EvidenceCard } from "./EvidenceCard";

type EvidenceLadderProps = {
  results: SearchResult[];
  filters: SearchFilters;
};

export function EvidenceLadder({ results, filters }: EvidenceLadderProps) {
  if (results.length === 0) {
    return null;
  }

  return (
    <section className="desk-card evidence-ladder" aria-labelledby="evidenceLadderHeading">
      <div className="section-heading">
        <p className="eyebrow">Evidence ladder</p>
        <h2 id="evidenceLadderHeading">Supporting records in ranked order.</h2>
      </div>

      <div className="evidence-ladder-list">
        {results.map((result, index) => (
          <EvidenceCard
            key={`${result.incident_id}-${result.timestamp}`}
            index={index}
            result={result}
            filters={filters}
          />
        ))}
      </div>
    </section>
  );
}
