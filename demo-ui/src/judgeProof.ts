import type {
  CuratedCase,
  JudgeArchitectureStep,
  JudgeClaimCard,
  JudgeDemoPreset,
  JudgeHeroChip,
  JudgeMetric,
  JudgeStorySection,
} from "./types";

export const judgeHeroChips: JudgeHeroChip[] = [
  { label: "Vague audit request received" },
  { label: "Audit slice kept visible" },
  { label: "Reviewer-ready briefing out" },
];

export const judgeAuditStoryExplainer =
  "Start with the same audit story as the hero: a vague archive request comes in, Trace keeps the requested slice visible, and the run ends with narrowed evidence plus a reviewer-ready briefing.";

export const judgeStorySections: JudgeStorySection[] = [
  {
    id: "rag-gap",
    eyebrow: "Why generic RAG slips",
    title: "Cold archives punish plausible-but-loose answers.",
    body:
      "Ops teams usually get a vague audit or oversight request, not a neat analytic prompt. Generic RAG can retrieve passages that sound related without staying inside the archive slice the reviewer actually needs to defend.",
    bullets: [
      "Keyword search misses older records when the wording drifted over time.",
      "Broad semantic search can surface plausible incidents that do not belong in the audit slice.",
      "Cold archives need retrieval plus boundaries, not just a polished answer.",
    ],
  },
  {
    id: "trace-fit",
    eyebrow: "What Trace changes",
    title: "Trace narrows the request before the result becomes evidence.",
    body:
      "Trace is built for audit response work on cold archives. It keeps the requested slice visible, returns a bounded working set, and creates a briefing another operator can review without repeating the search.",
    bullets: [
      "It retrieves semantically related records without needing exact keyword overlap.",
      "It keeps city, document type, and date scope visible through the result set.",
      "It outputs ranked evidence plus a handoff-ready briefing instead of just answer text.",
    ],
  },
];

export const judgeArchitectureSteps: JudgeArchitectureStep[] = [
  {
    id: "browser-ui",
    label: "01",
    title: "Browser UI",
    body:
      "The judge-facing app frames the investigation, shows the active scope, and exposes the live workflow that can be run directly in the browser.",
  },
  {
    id: "node-app-api",
    label: "02",
    title: "Node app API",
    body:
      "The app API shapes requests, can optionally interpret scope when that helper is available, and keeps credentials server-side so the browser only talks to the public app surface.",
  },
  {
    id: "rust-lambda",
    label: "03",
    title: "Rust Lambda search engine",
    body:
      "The Rust Lambda is the source of truth for search execution: it validates requests, applies safe filters, and runs nearest-neighbor retrieval against the archive dataset.",
  },
  {
    id: "lance-s3",
    label: "04",
    title: "Lance dataset on S3",
    body:
      "The archive lives in Lance on S3, so retrieval happens on demand from durable storage instead of requiring the full corpus to stay resident in application memory.",
  },
];

export const judgeArchitectureWhyItMatters = [
  "The archive stays in durable storage until someone actually needs to answer an audit request.",
  "Request-time retrieval matches sporadic archive work better than keeping a chat system warm around the full corpus.",
  "Visible scope and bounded search execution are part of why the handoff is more trustworthy than a generic RAG answer.",
];

export const judgeOfflineMetrics: JudgeMetric[] = [
  {
    value: "1.000",
    label: "Recall@5 on cold-archive proof set",
    detail:
      "Checked on 2026-04-29 against the labeled proof set used for the demo review (8 total cases; selected artifact uses 3 labeled positives, k=5).",
  },
  {
    value: "1.000",
    label: "In-scope evidence rate",
    detail:
      "Checked on 2026-04-29 on the same proof set. The scope-control artifact kept all 5 returned rows inside the requested slice.",
  },
];

export const judgeDeployedMetrics: JudgeMetric[] = [
  {
    value: "188 ms",
    label: "Warm HTTP median",
    detail:
      "Checked on 2026-04-29 on the deployed trace-eval stack. This is a warm-path snapshot median, not an SLA.",
  },
  {
    value: "82 MB",
    label: "Observed max memory used",
    detail:
      "Checked on 2026-04-29 on the deployed Trace Lambda runtime under the demo workload. This is a snapshot, not a capacity guarantee.",
  },
];

export const judgeOfflineClaimCards: JudgeClaimCard[] = [
  {
    id: "keyword-gap",
    claim: "Trace finds the right historical records even when the exact words do not match.",
    verified:
      "Checked 2026-04-29 on the local labeled eval corpus. Artifact `insurance-keyword-gap` uses 3 labeled positives with k=5.",
    scope:
      "No structured filters. This artifact isolates the retrieval benefit on a cold-archive investigation query.",
    evidenceSummary:
      "This offline comparison shows that Trace recovers every labeled positive in the top 5 while lexical matching misses them entirely.",
    evidencePoints: [
      "Trace hybrid returned 3 of 3 labeled positives in the top 5.",
      "Keyword-only returned 0 of 3 labeled positives in the top 5.",
      "The query asks for insurance lapse history using wording that does not need to appear exactly in the archived records.",
    ],
    comparison: {
      traceLabel: "Trace hybrid",
      traceOutcome: "3 of 3 labeled positives surfaced in the top 5 without exact keyword overlap.",
      weakerLabel: "Keyword only",
      weakerOutcome: "0 of 3 labeled positives surfaced in the top 5 on the same artifact.",
    },
    boundary:
      "This is selected offline evidence from the approved proof set. It is not a broad benchmark claim and not a live deployed replay.",
  },
  {
    id: "scope-gap",
    claim: "Trace keeps the result set usable by enforcing explicit scope.",
    verified:
      "Checked 2026-04-29 on the local labeled eval corpus. Artifact `insurance-scope-gap` evaluates 5 returned rows in the requested slice.",
    scope:
      "Requested slice: city CHI-BACP | document type Insurance_Lapse_Report.",
    evidenceSummary:
      "This offline comparison shows that semantic retrieval alone can find relevant incidents, but Trace is the mode that keeps the returned evidence inside the requested boundary.",
    evidencePoints: [
      "Trace hybrid kept 5 of 5 returned rows inside the requested scope.",
      "Semantic-only kept only 3 of 5 returned rows inside scope while still surfacing labeled positives.",
      "This is the difference between plausible retrieval and a working set you can hand off.",
    ],
    comparison: {
      traceLabel: "Trace hybrid",
      traceOutcome: "3 of 3 labeled positives surfaced while 5 of 5 returned rows stayed inside scope.",
      weakerLabel: "Semantic only",
      weakerOutcome: "3 of 3 labeled positives surfaced, but only 3 of 5 returned rows stayed inside scope.",
    },
    boundary:
      "This is offline comparison evidence for the scope-control claim. It does not claim that every semantic baseline always loses or that this exact comparison was reproduced live.",
  },
];

export const judgeDeployedClaimCards: JudgeClaimCard[] = [
  {
    id: "deployed-envelope",
    claim:
      "The current deployed Trace stack shows a bounded warm-path runtime snapshot for cold-archive retrieval.",
    verified:
      "Checked 2026-04-29 on the deployed trace-eval browser/app API/Rust Lambda path.",
    scope:
      "Measured on the current deployed stack: browser UI -> Node app API -> Rust Lambda search engine -> Lance dataset on S3.",
    evidenceSummary:
      "The deployed evidence supports a specific runtime snapshot for the current serverless path. It shows that this configuration can retrieve from durable storage without needing the full archive resident in app memory, not that every workload or future deploy will do the same.",
    evidencePoints: [
      "Warm HTTP median latency: 187.761 ms; median reported took_ms: 92.000 ms.",
      "Configured Lambda memory: 512 MB; measured max memory used: 82 MB.",
      "The snapshot reflects the live browser -> app API -> Rust Lambda -> Lance on S3 path used in the demo.",
    ],
    boundary:
      "These are deployed snapshot metrics on the current configuration. They are not a universal SLA and do not claim the same envelope for every future dataset, runtime, or query mix.",
  },
];

export const recommendedAuditCaseId = "nyc-safety-incident";

export const recommendedAuditFilters = {
  cityCode: "NYC-TLC",
  docType: "Safety_Incident_Log",
} as const;

function hasRecommendedAuditScope(curatedCase: CuratedCase): boolean {
  return (
    curatedCase.filters.cityCode === recommendedAuditFilters.cityCode &&
    curatedCase.filters.docType === recommendedAuditFilters.docType
  );
}

export function isRecommendedAuditCase(curatedCase: CuratedCase): boolean {
  return curatedCase.id === recommendedAuditCaseId || hasRecommendedAuditScope(curatedCase);
}

export function findRecommendedAuditCase(
  cases: CuratedCase[],
): CuratedCase | undefined {
  return (
    cases.find(
      (curatedCase) =>
        curatedCase.fixtureAvailable !== false && isRecommendedAuditCase(curatedCase),
    ) ??
    cases.find((curatedCase) => curatedCase.fixtureAvailable !== false) ??
    cases[0]
  );
}

export const judgeDemoPresets: JudgeDemoPreset[] = [
  {
    id: "recommended-audit-demo",
    title: "Recommended first audit path",
    subtitle: "NYC safety archive slice carried through to handoff",
    queryText: "safety incident reports in New York with supporting narrative",
    filters: {
      ...recommendedAuditFilters,
    },
    proofGoal:
      "Show the primary audit story end to end: vague request in, NYC safety slice held visible, narrowed evidence out, reviewer-ready briefing delivered.",
    whatToLookFor:
      "Look for NYC-TLC and the Safety Incident Log slice staying visible through the result stack, provenance block, and final handoff copy.",
  },
  {
    id: "semantic-audit-alternate",
    title: "Semantic-only contrast path",
    subtitle: "Broader retrieval without a declared audit slice",
    queryText: "recent vehicle inspection audit with overdue paperwork",
    filters: {},
    proofGoal:
      "Show the weaker comparison path: plausible retrieval without the same visible audit slice or handoff confidence as the recommended run.",
    whatToLookFor:
      "Look for a plausible lead and readable evidence, but treat this as the secondary contrast path rather than the primary audit-response story.",
  },
];
