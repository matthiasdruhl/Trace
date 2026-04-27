import type { HealthState } from "../types";

type TopBarProps = {
  health: HealthState;
};

export function TopBar({ health }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar-copy">
        <p className="eyebrow">Trace investigation desk</p>
        <h1>Defensible archive investigations, assembled in one pass.</h1>
        <p className="top-bar-lede">
          Shape the request, constrain the scope, and review ranked evidence in
          a workspace built for handoff.
        </p>
      </div>

      <div
        className={`health-pill ${health.ready ? "health-pill-ready" : "health-pill-down"}`}
        aria-live="polite"
      >
        <span className="health-indicator" aria-hidden="true" />
        {health.label}
      </div>
    </header>
  );
}
