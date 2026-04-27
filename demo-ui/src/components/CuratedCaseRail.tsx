import type { CuratedCase } from "../types";

type CuratedCaseRailProps = {
  cases: CuratedCase[];
  onApplyCase: (curatedCase: CuratedCase) => void;
};

export function CuratedCaseRail({ cases, onApplyCase }: CuratedCaseRailProps) {
  return (
    <section className="workbench-card curated-case-rail" aria-labelledby="curatedCasesHeading">
      <div className="section-heading">
        <p className="eyebrow">Investigation starting points</p>
        <h2 id="curatedCasesHeading">Start from a known pressure case.</h2>
      </div>

      <div className="case-list">
        {cases.map((curatedCase) => {
          const isUnavailable = curatedCase.fixtureAvailable === false;

          return (
            <button
              key={curatedCase.id}
              className={`case-card${isUnavailable ? " case-card-unavailable" : ""}`}
              type="button"
              onClick={() => onApplyCase(curatedCase)}
              disabled={isUnavailable}
              aria-describedby={isUnavailable ? `${curatedCase.id}-availability` : undefined}
            >
              <div className="case-header">
                <span className="case-title">{curatedCase.title}</span>
                {isUnavailable ? (
                  <span className="case-status" id={`${curatedCase.id}-availability`}>
                    Fixture unavailable
                  </span>
                ) : curatedCase.subtitle ? (
                  <span className="case-subtitle">{curatedCase.subtitle}</span>
                ) : null}
              </div>
              <span className="case-description">{curatedCase.description}</span>
              {isUnavailable ? (
                <span className="case-availability-note">
                  This starting point is shown for demo completeness, but its fixture is not
                  loaded in this environment.
                </span>
              ) : null}
              <span className="case-query">{curatedCase.queryText}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
