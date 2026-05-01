import {
  judgeArchitectureSteps,
  judgeArchitectureWhyItMatters,
  judgeAuditStoryExplainer,
  judgeDeployedClaimCards,
  judgeDeployedMetrics,
  judgeDemoPresets,
  judgeHeroChips,
  judgeOfflineClaimCards,
  judgeOfflineMetrics,
  judgeStorySections,
} from "../judgeProof";
import type { SearchFilters } from "../types";
import { humanizeDocType } from "../utils";

type RecommendedDemoCard = {
  title: string;
  subtitle: string;
  queryText: string;
  filters: SearchFilters;
  scopeLine: string;
};

type JudgeProofPanelProps = {
  recommendedDemoCard: RecommendedDemoCard | null;
  onReplayRecommended: () => void;
};

function formatScopeLine(filters: SearchFilters): string {
  const parts: string[] = [];

  if (filters.cityCode) {
    parts.push(`City ${filters.cityCode.toUpperCase()}`);
  }
  if (filters.docType) {
    parts.push(`Document ${humanizeDocType(filters.docType)}`);
  }
  if (filters.startDate) {
    parts.push(`From ${filters.startDate}`);
  }
  if (filters.endDate) {
    parts.push(`Through ${filters.endDate}`);
  }
  return parts.length > 0 ? `Audit slice: ${parts.join(" | ")}` : "Audit slice: No typed filters";
}

function normalizeMatchValue(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

function sameFilterValue(left?: string, right?: string): boolean {
  return normalizeMatchValue(left) === normalizeMatchValue(right);
}

function matchesPreset(card: RecommendedDemoCard, preset: (typeof judgeDemoPresets)[number]): boolean {
  return (
    sameFilterValue(card.queryText, preset.queryText) &&
    sameFilterValue(card.filters.cityCode, preset.filters.cityCode) &&
    sameFilterValue(card.filters.docType, preset.filters.docType) &&
    sameFilterValue(card.filters.startDate, preset.filters.startDate) &&
    sameFilterValue(card.filters.endDate, preset.filters.endDate)
  );
}

export function JudgeProofPanel({
  recommendedDemoCard,
  onReplayRecommended,
}: JudgeProofPanelProps) {
  const alternatePresets = judgeDemoPresets.slice(1);
  const recommendedPreset = recommendedDemoCard
    ? judgeDemoPresets.find((preset) => matchesPreset(recommendedDemoCard, preset)) ?? null
    : judgeDemoPresets[0] ?? null;
  const examplePromptChips = Array.from(
    new Set([
      recommendedDemoCard?.queryText,
      ...judgeDemoPresets.map((preset) => preset.queryText),
    ].filter((queryText): queryText is string => Boolean(queryText))),
  );
  const recommendedScopeLine = recommendedDemoCard
    ? formatScopeLine(recommendedDemoCard.filters)
    : formatScopeLine(recommendedPreset?.filters ?? {});
  const recommendedProofGoal = recommendedPreset
    ? recommendedPreset.proofGoal
    : "Replay the currently recommended audit path to inspect the live curated scenario that the app is guiding judges through first.";
  const recommendedWhatToLookFor = recommendedPreset
    ? recommendedPreset.whatToLookFor
    : "Use the replay path above to verify that the visible query, active audit slice, and resulting evidence stay aligned from search to handoff.";

  return (
    <section className="judge-proof-panel" aria-labelledby="proofPanelHeading">
      <div className="judge-proof-header">
        <div>
          <p className="eyebrow">Supporting proof</p>
          <h2 id="proofPanelHeading">
            Optional supporting notes for the audit-response story and cold-archive
            retrieval claim.
          </h2>
        </div>
        <p className="judge-proof-lede">
          Run the main judge path first. These notes are supporting evidence after the
          demo, not the primary evaluation path. Open them if you want retrieval proof,
          runtime context, or optional scope-assist background.
        </p>
      </div>

      <article className="judge-demo-card" aria-labelledby="judgeAuditStoryHeading">
        <div className="judge-demo-card-header">
          <div>
            <p className="eyebrow">Audit story recap</p>
            <h3 id="judgeAuditStoryHeading">What this demo is auditing.</h3>
          </div>
          <span className="judge-demo-scope-chip">{recommendedScopeLine}</span>
        </div>
        <p className="judge-story-copy">{judgeAuditStoryExplainer}</p>
        <div className="badge-row" aria-label="Audit story steps">
          {judgeHeroChips.map((chip) => (
            <span className="match-chip" key={chip.label}>
              {chip.label}
            </span>
          ))}
        </div>
        <div className="judge-architecture-matters">
          <span className="judge-block-label">Example archive asks</span>
          <div className="badge-row" aria-label="Example prompt chips">
            {examplePromptChips.map((queryText) => (
              <span
                className="match-chip match-chip-ellipsis"
                key={queryText}
                title={queryText}
              >
                {queryText}
              </span>
            ))}
          </div>
        </div>
      </article>

      {recommendedDemoCard ? (
        <div className="judge-proof-actions">
          <button
            className="secondary-button judge-proof-action"
            type="button"
            aria-label="Replay the recommended audit path"
            onClick={onReplayRecommended}
          >
            Replay the recommended audit path
          </button>
        </div>
      ) : null}

      <details className="judge-disclosure">
        <summary>Why Trace beats generic RAG on cold archives</summary>
        <div className="judge-proof-section">
          <div className="judge-section-header">
            <div>
              <p className="eyebrow">Compact proof</p>
              <h3>Retrieval quality matters, but staying inside the audit slice matters too.</h3>
            </div>
            <p className="judge-demo-note">
              These artifacts are supporting evidence, not the main demo. Use them after
              the guided run if you want extra proof that Trace is stronger than a
              broad-answer flow when the archive is cold and the request is vague.
            </p>
          </div>

          <div className="judge-story-grid">
            {judgeStorySections.map((section) => (
              <article className="judge-story-card" key={section.id}>
                <p className="eyebrow">{section.eyebrow}</p>
                <h3>{section.title}</h3>
                <p className="judge-story-copy">{section.body}</p>
                <ul className="judge-story-list">
                  {section.bullets.map((bullet, bulletIndex) => (
                    <li key={`${section.id}-bullet-${bulletIndex}`}>{bullet}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <div className="judge-metrics-grid judge-metrics-grid-compact">
            {judgeOfflineMetrics.map((metric, metricIndex) => (
              <article className="judge-metric-card" key={`offline-metric-${metricIndex}`}>
                <p className="eyebrow">Evidence snapshot</p>
                <p className="judge-metric-value">{metric.value}</p>
                <p className="judge-metric-label">{metric.label}</p>
                <p className="judge-metric-detail">{metric.detail}</p>
              </article>
            ))}
          </div>

          <div className="judge-claim-grid">
            {judgeOfflineClaimCards.map((card) => (
              <article className="judge-claim-card" key={card.id}>
                <h4>{card.claim}</h4>
                <p className="judge-claim-verified">{card.verified}</p>
                <p className="judge-story-copy">{card.evidenceSummary}</p>
                <ul className="judge-story-list">
                  {card.evidencePoints.map((point, pointIndex) => (
                    <li key={`${card.id}-point-${pointIndex}`}>{point}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </details>

      <details className="judge-disclosure">
        <summary>Architecture and runtime snapshot</summary>
        <div className="judge-proof-section judge-proof-section-deployed">
          <div className="judge-section-header">
            <div>
              <p className="eyebrow">Live stack snapshot</p>
              <h3>What the current deployed path looks like under warm conditions.</h3>
            </div>
            <p className="judge-demo-note">
              This stays secondary on purpose. It is runtime context for the demo path,
              not the core evaluation flow and not a requirement for the guided run.
            </p>
          </div>

          <div className="judge-metrics-grid judge-metrics-grid-compact">
            {judgeDeployedMetrics.map((metric, metricIndex) => (
              <article className="judge-metric-card" key={`deployed-metric-${metricIndex}`}>
                <p className="eyebrow">Observed snapshot</p>
                <p className="judge-metric-value">{metric.value}</p>
                <p className="judge-metric-label">{metric.label}</p>
                <p className="judge-metric-detail">{metric.detail}</p>
              </article>
            ))}
          </div>

          <div className="judge-claim-grid">
            {judgeDeployedClaimCards.map((card) => (
              <article className="judge-claim-card" key={card.id}>
                <h4>{card.claim}</h4>
                <p className="judge-claim-verified">{card.verified}</p>
                <p className="judge-story-copy">{card.evidenceSummary}</p>
                <ul className="judge-story-list">
                  {card.evidencePoints.map((point, pointIndex) => (
                    <li key={`${card.id}-point-${pointIndex}`}>{point}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>

        <div className="judge-architecture-grid">
          {judgeArchitectureSteps.map((step) => (
            <article className="judge-architecture-step" key={step.id}>
              <span className="judge-step-index">{step.label}</span>
              <h4>{step.title}</h4>
              <p>{step.body}</p>
            </article>
          ))}
        </div>

        <div className="judge-architecture-matters">
          <span className="judge-block-label">Why this setup fits the product</span>
          <ul className="judge-story-list">
            {judgeArchitectureWhyItMatters.map((item, itemIndex) => (
              <li key={`architecture-matters-${itemIndex}`}>{item}</li>
            ))}
          </ul>
        </div>

        {alternatePresets.length > 0 ? (
          <div className="judge-demo-grid">
            {alternatePresets.map((preset) => (
              <article className="judge-demo-card" key={preset.id}>
                <div className="judge-demo-card-header">
                  <div>
                    <h4>{preset.title}</h4>
                    <p className="judge-demo-subtitle">{preset.subtitle}</p>
                  </div>
                  <span className="judge-demo-scope-chip">{formatScopeLine(preset.filters)}</span>
                </div>
                <p className="judge-demo-query">{preset.queryText}</p>
                <p className="judge-demo-note">{preset.proofGoal}</p>
                <p className="support-copy">{preset.whatToLookFor}</p>
              </article>
            ))}
          </div>
        ) : null}

        {recommendedDemoCard ? (
          <article className="judge-demo-card">
            <div className="judge-demo-card-header">
              <div>
                <h4>{recommendedDemoCard.title}</h4>
                <p className="judge-demo-subtitle">{recommendedDemoCard.subtitle}</p>
              </div>
              <span className="judge-demo-scope-chip">{recommendedScopeLine}</span>
            </div>
            <p className="judge-demo-query">{recommendedDemoCard.queryText}</p>
            <p className="judge-demo-note">{recommendedProofGoal}</p>
            <p className="support-copy">{recommendedWhatToLookFor}</p>
          </article>
        ) : null}
      </details>
    </section>
  );
}
