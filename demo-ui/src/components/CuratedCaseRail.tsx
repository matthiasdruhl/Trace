import { findRecommendedAuditCase } from "../judgeProof";
import type { CuratedCase } from "../types";

type CuratedCaseRailProps = {
  cases: CuratedCase[];
  onApplyCase: (curatedCase: CuratedCase) => void;
};

function describeAuditObjective(curatedCase: CuratedCase): string {
  if (curatedCase.description.trim().length > 0) {
    return curatedCase.description;
  }

  return `Review this archive path for ${curatedCase.title.toLowerCase()}.`;
}

function describePreservedScope(curatedCase: CuratedCase): string | null {
  const parts: string[] = [];

  if (curatedCase.filters.cityCode) {
    parts.push(`City ${curatedCase.filters.cityCode}`);
  }
  if (curatedCase.filters.docType) {
    parts.push(`Document type ${curatedCase.filters.docType}`);
  }
  if (curatedCase.filters.startDate) {
    parts.push(`From ${curatedCase.filters.startDate}`);
  }
  if (curatedCase.filters.endDate) {
    parts.push(`Through ${curatedCase.filters.endDate}`);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

function CaseCard({
  curatedCase,
  recommended = false,
  onApplyCase,
}: {
  curatedCase: CuratedCase;
  recommended?: boolean;
  onApplyCase: (curatedCase: CuratedCase) => void;
}) {
  const preservedScope = describePreservedScope(curatedCase);

  return (
    <button
      className="case-card"
      type="button"
      onClick={() => onApplyCase(curatedCase)}
    >
      <div className="case-header">
        <span className="case-title">{curatedCase.title}</span>
        <span className="case-subtitle">
          {recommended
            ? "Recommended first run"
            : curatedCase.subtitle ?? "Alternate audit scenario"}
        </span>
      </div>
      <span className="block-label">Audit objective</span>
      <span className="case-description">{describeAuditObjective(curatedCase)}</span>
      {preservedScope ? (
        <>
          <span className="block-label">Preserved scope</span>
          <span className="case-description">{preservedScope}</span>
        </>
      ) : null}
      <span className="block-label">Starter query</span>
      <span className="case-query">{curatedCase.queryText}</span>
    </button>
  );
}

export function CuratedCaseRail({ cases, onApplyCase }: CuratedCaseRailProps) {
  const recommendedCase = findRecommendedAuditCase(cases);

  if (!recommendedCase) {
    return null;
  }

  const alternateCases = cases.filter(
    (curatedCase) => curatedCase.id !== recommendedCase.id,
  );

  return (
    <section
      className="workbench-card curated-case-rail"
      aria-labelledby="curatedCasesHeading"
    >
      <div className="section-heading">
        <p className="eyebrow">Audit demo paths</p>
        <h2 id="curatedCasesHeading">Start with one recommended audit response.</h2>
        <p className="support-copy">
          This is the primary judge path. Start here before opening alternate scenarios
          or drafting your own request.
        </p>
        <p className="support-copy">
          Manual exploration stays available in the composer below, and alternate
          scenarios stay collapsed until you need a contrast case.
        </p>
      </div>

      <div className="case-list">
        <CaseCard
          curatedCase={recommendedCase}
          recommended
          onApplyCase={onApplyCase}
        />
      </div>

      {alternateCases.length > 0 ? (
        <details className="judge-disclosure curated-case-disclosure">
          <summary>Other audit scenarios</summary>
          <div className="case-list">
            {alternateCases.map((curatedCase) => (
              <CaseCard
                key={curatedCase.id}
                curatedCase={curatedCase}
                onApplyCase={onApplyCase}
              />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
