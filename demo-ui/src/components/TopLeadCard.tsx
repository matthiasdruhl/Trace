import { useEffect, useRef, useState } from "react";
import type { HandoffReadiness, SearchFilters, SearchResult, SearchResponse } from "../types";
import {
  appliedFilterChipsFromApi,
  buildRequestScopeCopyMarkdown,
  buildTopLeadBriefingMarkdown,
  buildTrustRecapBullets,
} from "../trustBriefing";
import {
  buildExcerpt,
  buildFilterMatchChips,
  formatScore,
  formatTimestamp,
  humanizeDocType,
} from "../utils";

type TopLeadCardProps = {
  result: SearchResult;
  filters: SearchFilters;
  searchResponse: SearchResponse;
  handoffReadiness?: HandoffReadiness;
  resultQualitySummary?: string;
};

const COPY_FEEDBACK_MS = 4000;

function copyViaExecCommand(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
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

function describeLeadPosture(handoffReadiness: HandoffReadiness | undefined) {
  switch (handoffReadiness) {
    case "ready":
      return {
        badge: "Handoff-ready lead",
        nextMove:
          "Validate this source record and excerpt first, then confirm the supporting records reinforce the same pattern before passing the briefing forward.",
        payoff:
          "A reviewer can start from one named source record, inspect the excerpt in plain language, and carry a scoped evidence package forward without rerunning Trace.",
      } as const;
    case "review_only":
      return {
        badge: "Review-only lead",
        nextMove:
          "Trace is surfacing this lead for inspection, but withholding a clean handoff signal until the audit boundary is specific enough to defend.",
        payoff:
          "A reviewer can inspect one named source record without rerunning Trace, but should tighten scope before carrying the result package forward.",
      } as const;
    case "not_trustworthy":
      return {
        badge: "Trust blocked",
        nextMove:
          "Trace is withholding certainty because this lead still needs a narrower request or stronger agreement with the stated scope before it should influence a handoff.",
        payoff:
          "This card is useful for diagnosing why the search drifted, not for carrying a conclusion forward.",
      } as const;
    default:
      return {
        badge: "Lead under review",
        nextMove:
          "Validate this source record and excerpt before treating it as defensible evidence.",
        payoff:
          "A reviewer can inspect the strongest record first, then decide whether more scope or corroboration is needed.",
      } as const;
  }
}

function describeExcerptProvenance(result: SearchResult): string {
  switch (result.provenanceSource) {
    case "backend":
      return "Backend supplied this readable excerpt directly.";
    case "synthesized":
      return "Trace synthesized this readable excerpt from available source text or metadata.";
    default:
      return "This build did not label excerpt provenance. Treat the readable excerpt as a Trace-rendered convenience view and verify the source record directly.";
  }
}

export function TopLeadCard({
  result,
  filters,
  searchResponse,
  handoffReadiness,
  resultQualitySummary,
}: TopLeadCardProps) {
  const chips = buildFilterMatchChips(result, filters);
  const locationAndTime = `${result.city_code} | ${formatTimestamp(result.timestamp)}`;
  const sourceExcerpt = result.sourceExcerpt.trim() || buildExcerpt(result);
  const posture = describeLeadPosture(handoffReadiness);

  const appliedScopeChips = appliedFilterChipsFromApi(searchResponse.appliedFilter.filters);
  const recapBullets = buildTrustRecapBullets(result, searchResponse);
  const leadBriefingMd = buildTopLeadBriefingMarkdown(result, searchResponse);
  const requestScopeMd = buildRequestScopeCopyMarkdown(
    searchResponse.queryText,
    searchResponse.appliedFilter.summary,
  );
  const copyTargetMarkdown = leadBriefingMd ?? requestScopeMd;
  const copyButtonLabel = leadBriefingMd ? "Copy lead briefing" : "Copy request + scope";

  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  async function handleCopyBriefing() {
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
    }
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyTargetMarkdown);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      copied = copyViaExecCommand(copyTargetMarkdown);
    }
    if (copied) {
      setCopiedMessage(
        leadBriefingMd
          ? "Lead briefing copied as Markdown. Review before sharing."
          : "Request and scope copied. This omits match narrative when briefing data was incomplete.",
      );
    } else {
      setCopiedMessage("Clipboard access is unavailable in this environment.");
    }
    clearTimerRef.current = setTimeout(() => {
      setCopiedMessage(null);
      clearTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  }

  return (
    <article className="desk-card top-lead-card">
      <div className="lead-banner">
        <span className="lead-badge">Top lead</span>
        <span className="lead-score">{posture.badge}</span>
      </div>

      <div className="lead-header">
        <div>
          <h3>{humanizeDocType(result.doc_type)}</h3>
          <p className="lead-subhead">{locationAndTime}</p>
        </div>
      </div>

      <div className="badge-row">
        <span className="badge">{humanizeDocType(result.doc_type)}</span>
        {chips.map((chip, chipIndex) => (
          <span className="match-chip" key={`${chip}-${chipIndex}`}>
            {chip}
          </span>
        ))}
      </div>

      <section className="lead-panel lead-panel-wide" aria-label="Applied scope recap">
        <p className="block-label">Applied scope and trust recap</p>
        {appliedScopeChips.length > 0 ? (
          <div className="trust-scope-row">
            {appliedScopeChips.map((chip) => (
              <span className="match-chip" key={chip}>
                {chip}
              </span>
            ))}
          </div>
        ) : (
          <p className="support-copy">
            No typed metadata filters were applied on the server for this retrieval arm.
          </p>
        )}
        {recapBullets.length > 0 ? (
          <ul className="trust-recap">
            {recapBullets.map((b) => (
              <li key={b.key}>{b.text}</li>
            ))}
          </ul>
        ) : null}
        <p className="trust-recap-disclosure">
          Bullets are filled only from deterministic API fields (scope summary, lead ids, match line,
          mode, ranking, counts). A reviewer still validates citations and legal posture — this is
          not an automatic sign-off.
        </p>
        <div className="lead-trust-actions">
          <button className="secondary-button" type="button" onClick={() => void handleCopyBriefing()}>
            {copyButtonLabel}
          </button>
        </div>
        {copiedMessage ? (
          <p className="support-copy" role="status">
            {copiedMessage}
          </p>
        ) : null}
      </section>

      <div className="lead-grid">
        <div className="lead-panel">
          <p className="block-label">Fast read</p>
          <p>{result.why_this_matched}</p>
        </div>
        <div className="lead-panel">
          <p className="block-label">Most useful excerpt</p>
          <p>{sourceExcerpt}</p>
        </div>
        <div className="lead-panel lead-panel-wide">
          <p className="block-label">Recommended next move</p>
          <p>{posture.nextMove}</p>
        </div>
        <div className="lead-panel lead-panel-wide lead-impact-card">
          <p className="block-label">Immediate payoff</p>
          <p>{posture.payoff}</p>
        </div>
        {resultQualitySummary ? (
          <div className="lead-panel lead-panel-wide">
            <p className="block-label">Backend trust summary</p>
            <p>{resultQualitySummary}</p>
          </div>
        ) : null}
        <div className="lead-panel lead-panel-wide">
          <p className="block-label">Readable excerpt provenance</p>
          <p>{describeExcerptProvenance(result)}</p>
        </div>
      </div>

      <section className="source-inspection-panel" aria-label="Source inspection">
        <div className="source-inspection-header">
          <div>
            <p className="block-label">Source inspection</p>
            <p className="support-copy source-inspection-copy">
              These are the source details a reviewer should verify before
              treating the lead as defensible evidence.
            </p>
          </div>
          <div className="badge-row">
            <span className="source-badge">{humanizeClassification(result.dataClassification)} classification</span>
            <span className="source-badge">{humanizeRedactionStatus(result.redactionStatus)}</span>
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
          <div className="source-fact source-fact-wide">
            <p className="block-label">Readable excerpt shown in Trace</p>
            <p>{sourceExcerpt}</p>
          </div>
        </div>
      </section>

      <details className="details-panel">
        <summary>Show lead details</summary>
        <div className="details-panel-body">
          <p>
            <strong>Incident:</strong> {result.incident_id}
          </p>
          <p>
            <strong>Recorded:</strong> {result.timestamp}
          </p>
          <p>
            <strong>Document type:</strong> {result.doc_type}
          </p>
          <p>
            <strong>Relevance score:</strong> {formatScore(result.score)}
          </p>
          <p>
            <strong>Source record:</strong> {result.sourceRecordId}
          </p>
        </div>
      </details>
    </article>
  );
}
