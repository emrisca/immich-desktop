import type { CSSProperties, ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Stagger index for the 240ms rise; panels enter in reading order. */
  index?: number;
  /** Blurred panes are rationed to two per window: the sidebar and the phone card. */
  blur?: boolean;
  flush?: boolean;
  className?: string;
};

export function Panel({ children, index = 0, blur, flush, className }: Props) {
  const classes = [
    "panel",
    blur ? "panel--blur" : "",
    flush ? "panel--flush" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classes} style={{ "--i": index } as CSSProperties}>
      {children}
    </section>
  );
}
