import type { HandoffReadiness, SearchStatus } from "../types";

export type GuidedDemoScopeState = "none" | "requested" | "applied";

type GuidedDemoStripProps = {
  active: boolean;
  status: SearchStatus;
  hasResults: boolean;
  scopeState: GuidedDemoScopeState;
  handoffReadiness?: HandoffReadiness;
  topLeadLabel?: string;
};

type GuidedStepState = "upcoming" | "active" | "complete" | "blocked";

type GuidedStep = {
  label: string;
  state: GuidedStepState;
  body: string;
};

function describeGuidedMessage(
  status: SearchStatus,
  scopeState: GuidedDemoScopeState,
  handoffReadiness: HandoffReadiness | undefined,
): string {
  if (status === "running" || status === "interpreting" || status === "ready") {
    return scopeState === "requested"
      ? "Use this guided run to confirm three things: the requested scope stays visible, Trace surfaces evidence inside it, and the flow ends with a reviewer-ready briefing only after the backend confirms the applied boundaries."
      : "Use this guided run to confirm three things: scope stays visible, evidence surfaces inside it, and the flow only ends when a reviewer-ready briefing is justified.";
  }

  if (handoffReadiness === "ready") {
    return "This guided run preserved the requested scope, surfaced reviewable evidence inside it, and ended with a reviewer-ready briefing.";
  }

  if (status === "completed" || handoffReadiness === "review_only") {
    if (scopeState !== "applied") {
      return "Trace found a useful lead, but the run did not keep the requested scope visible strongly enough to justify reviewer handoff.";
    }
    return "Trace preserved useful boundaries and surfaced evidence, but the packet still needs a tighter audit conclusion before handoff.";
  }

  if (
    status === "low_confidence" ||
    status === "no_results" ||
    status === "service_error" ||
    handoffReadiness === "not_trustworthy"
  ) {
    if (scopeState === "requested") {
      return "This guided run asked for structured scope, but Trace stopped before it could prove a trustworthy scoped packet for the next reviewer.";
    }
    return "This guided run did not clear the threshold for scope-preserved evidence and a trustworthy briefing, so the demo stops instead of pretending the packet is ready.";
  }

  return "Run the guided audit demo to verify that one sample request keeps scope visible from intake through evidence selection and into briefing handoff.";
}

function buildSteps(
  status: SearchStatus,
  scopeState: GuidedDemoScopeState,
  hasResults: boolean,
  handoffReadiness: HandoffReadiness | undefined,
  topLeadLabel?: string,
): GuidedStep[] {
  const blocked =
    status === "low_confidence" ||
    status === "no_results" ||
    status === "service_error" ||
    handoffReadiness === "not_trustworthy";
  const hasReviewableLead = hasResults && (status === "completed" || handoffReadiness !== undefined);
  const runResolved = blocked || status === "completed" || handoffReadiness !== undefined;
  const scopeStepState: GuidedStepState =
    scopeState === "applied"
      ? "complete"
      : runResolved
        ? "blocked"
        : status !== "idle"
          ? "active"
          : "upcoming";
  const scopeStepBody =
    scopeState === "applied"
      ? "Trace returned explicit city, document type, or time boundaries so the judge can confirm the audit slice stayed visible."
      : scopeState === "requested"
        ? runResolved
          ? "This demo requested explicit boundaries, but the backend never returned a confirmed typed scope for the reviewer to trust."
          : "This demo requested explicit city, document type, or time boundaries. The guide waits for the backend to confirm them before claiming the scope stayed visible."
        : "Trace is still working toward a scope another reviewer could verify.";

  return [
    {
      label: "Audit request received",
      state: "complete",
      body: "The guided demo starts from one realistic audit request so the judge can follow a single evaluation path.",
    },
    {
      label: "Scope narrowed",
      state: scopeStepState,
      body: scopeStepBody,
    },
    {
      label: "Top evidence found",
      state: hasReviewableLead ? "complete" : blocked ? "blocked" : status === "running" ? "active" : "upcoming",
      body: hasReviewableLead
        ? `Trace surfaced ${topLeadLabel ?? "a top lead"} for the reviewer to inspect first without losing the audit slice.`
        : "Trace has not surfaced a trustworthy lead inside the requested audit slice yet.",
    },
    {
      label: "Briefing ready",
      state:
        handoffReadiness === "ready"
          ? "complete"
          : blocked
            ? "blocked"
            : hasReviewableLead
              ? "active"
              : "upcoming",
      body:
        handoffReadiness === "ready"
          ? "The sample run ended with a packet the next reviewer can pick up immediately."
          : blocked
            ? "Trace stopped short of a clean briefing because the run never cleared the trust threshold for handoff."
            : "Trace is withholding the handoff until the result package is tight enough for the next reviewer.",
    },
  ];
}

export function GuidedDemoStrip({
  active,
  status,
  hasResults,
  scopeState,
  handoffReadiness,
  topLeadLabel,
}: GuidedDemoStripProps) {
  if (!active) {
    return null;
  }

  const steps = buildSteps(
    status,
    scopeState,
    hasResults,
    handoffReadiness,
    topLeadLabel,
  );

  return (
    <section className="desk-card guided-demo-strip" aria-labelledby="guidedDemoHeading">
      <div className="guided-demo-header">
        <div>
          <p className="eyebrow">30-second guided demo</p>
          <h2 id="guidedDemoHeading">Scope preserved, evidence surfaced, briefing ready.</h2>
        </div>
        <span className="guided-demo-chip">Using sample data</span>
      </div>

      <p className="guided-demo-summary">{describeGuidedMessage(status, scopeState, handoffReadiness)}</p>

      <ol className="guided-demo-steps">
        {steps.map((step, index) => (
          <li key={step.label} className={`guided-demo-step guided-demo-step-${step.state}`}>
            <span className="guided-demo-step-index">0{index + 1}</span>
            <div>
              <p className="guided-demo-step-label">{step.label}</p>
              <p className="guided-demo-step-body">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
