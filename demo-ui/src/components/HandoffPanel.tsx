import { useEffect, useRef, useState } from "react";
import type { HandoffSummary } from "../types";

type HandoffPanelProps = {
  summary: HandoffSummary;
  supportingCount: number;
  allowExport: boolean;
};

function buildSummaryText(summary: HandoffSummary): string {
  return [
    `Investigation goal: ${summary.goal}`,
    `Applied scope: ${summary.appliedScope}`,
    `Lead to verify: ${summary.primaryEvidence}`,
    `Recommended handoff: ${summary.suggestedHandoff}`,
  ].join("\n");
}

function buildEvidenceTrailText(summary: HandoffSummary): string {
  return [
    "Trace evidence trail",
    `Goal: ${summary.goal}`,
    `Scope: ${summary.appliedScope}`,
    `Lead: ${summary.primaryEvidence}`,
    `Carry forward: ${summary.suggestedHandoff}`,
  ].join("\n");
}

const COPY_FEEDBACK_MS = 4000;

function buildBriefingPreview(summary: HandoffSummary, supportingCount: number): string {
  const supportingLabel =
    supportingCount > 0
      ? `${supportingCount} supporting record${supportingCount === 1 ? "" : "s"}`
      : "no supporting records";

  return `Trace scoped the request to ${summary.appliedScope}. The current lead is ${summary.primaryEvidence}, with ${supportingLabel} attached for review. ${summary.suggestedHandoff}`;
}

function buildImpactCopy(supportingCount: number): string {
  if (supportingCount > 0) {
    return `The next reviewer inherits one primary lead plus ${supportingCount} supporting record${supportingCount === 1 ? "" : "s"}, so they can validate the pattern instead of rebuilding the search.`;
  }

  return "The next reviewer inherits a scoped question and a named lead, even if they still need to validate it without supporting records.";
}

export function HandoffPanel({
  summary,
  supportingCount,
  allowExport,
}: HandoffPanelProps) {
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  async function handleCopy(label: string, value: string) {
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
    }

    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (copied) {
      setCopiedMessage(`${label} copied.`);
    } else {
      setCopiedMessage("Clipboard access is unavailable in this environment.");
    }

    clearTimerRef.current = setTimeout(() => {
      setCopiedMessage(null);
      clearTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  }

  return (
    <section className="desk-card handoff-panel" aria-labelledby="handoffHeading">
      <div className="section-heading">
        <p className="eyebrow">Handoff draft</p>
        <h2 id="handoffHeading">What this run is ready to pass forward.</h2>
      </div>

      <p className="support-copy">
        Use this as a scoped briefing for the next reviewer. It is meant to
        speed up verification, not replace it.
      </p>

      <p className="support-copy">
        The briefing preview and copy actions are synthesized by Trace from the
        backend response. Verify the cited source record IDs and collections
        before sharing it outside this workspace.
      </p>

      <div className="handoff-outcome-row">
        <div className="handoff-briefing-card">
          <p className="block-label">Briefing preview</p>
          <p>{buildBriefingPreview(summary, supportingCount)}</p>
        </div>
        <div className="handoff-impact-card">
          <p className="block-label">Immediate payoff</p>
          <p>{buildImpactCopy(supportingCount)}</p>
        </div>
      </div>

      <div className="handoff-grid">
        <div className="handoff-item">
          <p className="block-label">Investigation goal</p>
          <p>{summary.goal}</p>
        </div>
        <div className="handoff-item">
          <p className="block-label">Applied scope</p>
          <p>{summary.appliedScope}</p>
        </div>
        <div className="handoff-item">
          <p className="block-label">Lead to verify</p>
          <p>{summary.primaryEvidence}</p>
        </div>
        <div className="handoff-item">
          <p className="block-label">Recommended next action</p>
          <p>{summary.suggestedHandoff}</p>
        </div>
      </div>

      {allowExport ? (
        <div className="handoff-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => handleCopy("Briefing", buildSummaryText(summary))}
          >
            Copy briefing
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => handleCopy("Evidence trail", buildEvidenceTrailText(summary))}
          >
            Copy evidence trail
          </button>
        </div>
      ) : null}

      {copiedMessage ? (
        <p className="support-copy" role="status">
          {copiedMessage}
        </p>
      ) : null}
    </section>
  );
}
