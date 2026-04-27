type StatePanelProps = {
  eyebrow: string;
  title: string;
  body: string;
  tone?: "default" | "warning" | "danger";
  steps?: string[];
};

export function StatePanel({
  eyebrow,
  title,
  body,
  tone = "default",
  steps,
}: StatePanelProps) {
  const className =
    tone === "warning"
      ? "state-panel state-panel-warning"
      : tone === "danger"
        ? "state-panel state-panel-danger"
        : "state-panel";

  return (
    <section className={className} role={tone === "danger" ? "alert" : undefined}>
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{body}</p>
      {steps && steps.length > 0 ? (
        <ol className="state-steps">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
