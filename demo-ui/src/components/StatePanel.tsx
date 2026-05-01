import type { ReactNode } from "react";

type StatePanelProps = {
  eyebrow: string;
  title: string;
  body: string;
  tone?: "default" | "warning" | "danger";
  steps?: string[];
  footer?: ReactNode;
};

function getStateLabel(
  eyebrow: string,
  title: string,
  tone: NonNullable<StatePanelProps["tone"]>,
) {
  const source = `${eyebrow} ${title}`.toLowerCase();

  if (tone === "danger") {
    return "Service issue";
  }
  if (source.includes("interpreting")) {
    return "Scope review in progress";
  }
  if (source.includes("live run") || source.includes("assembling")) {
    return "Search in progress";
  }
  if (source.includes("no defensible match") || source.includes("nothing strong enough")) {
    return "No handoff-ready lead";
  }
  if (source.includes("not confident enough") || source.includes("narrower request")) {
    return "Confidence blocked";
  }
  if (source.includes("operator review") || source.includes("needs a tighter boundary")) {
    return "Review before handoff";
  }
  if (source.includes("draft ready") || source.includes("ready to run")) {
    return "Ready to search";
  }
  if (source.includes("input issue") || source.includes("fix the request")) {
    return "Fix required";
  }

  return "Exploratory state";
}

function getWithholdingNotice(
  eyebrow: string,
  title: string,
  tone: NonNullable<StatePanelProps["tone"]>,
): string | null {
  if (tone !== "warning") {
    return null;
  }

  const source = `${eyebrow} ${title}`.toLowerCase();

  if (source.includes("not confident enough") || source.includes("narrower request")) {
    return "Trace is withholding certainty because the current request is still broad enough that a plausible match could mislead the next reviewer.";
  }

  if (source.includes("operator review") || source.includes("tighter boundary")) {
    return "Trace is surfacing the lead for inspection, but withholding a clean handoff signal until the audit boundary is specific enough to defend.";
  }

  if (source.includes("no defensible match") || source.includes("nothing strong enough")) {
    return "Trace is not presenting any result as evidence because this scope did not produce a defensible record set.";
  }

  return null;
}

export function StatePanel({
  eyebrow,
  title,
  body,
  tone = "default",
  steps,
  footer,
}: StatePanelProps) {
  const className =
    tone === "warning"
      ? "state-panel state-panel-warning"
      : tone === "danger"
        ? "state-panel state-panel-danger"
        : "state-panel";
  const stateLabel = getStateLabel(eyebrow, title, tone);
  const withholdingNotice = getWithholdingNotice(eyebrow, title, tone);
  const stepHeading =
    tone === "danger"
      ? "Recovery path"
      : tone === "warning"
        ? "Best next move"
        : "Current action";

  return (
    <section className={className} role={tone === "danger" ? "alert" : undefined}>
      <p className="eyebrow">{eyebrow}</p>
      <p className="block-label">{stateLabel}</p>
      <h2>{title}</h2>
      <p>{body}</p>
      {withholdingNotice ? (
        <div className="state-advisory">
          <p className="block-label">Why Trace is holding back</p>
          <p>{withholdingNotice}</p>
        </div>
      ) : null}
      {steps && steps.length > 0 ? (
        <>
          <p className="block-label">{stepHeading}</p>
          <ol className="state-steps">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      ) : null}
      {footer ? <div className="state-panel-footer">{footer}</div> : null}
    </section>
  );
}
