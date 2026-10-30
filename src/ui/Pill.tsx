import type { ReactNode } from "react";

export type Tone = "idle" | "live" | "busy" | "warn";

/**
 * The one status mark in the window: a glowing dot, a short label and an
 * optional monospace value. Colour is never the only signal — the label says
 * what the dot means.
 */
export function Pill({
  tone = "idle",
  children,
  value,
}: {
  tone?: Tone;
  children: ReactNode;
  value?: string | null;
}) {
  return (
    <span className={`pill pill--${tone}`}>
      <span className="pill__dot" aria-hidden="true" />
      {children}
      {value ? <span className="pill__port">{value}</span> : null}
    </span>
  );
}
