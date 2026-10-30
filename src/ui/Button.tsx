import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "quiet";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "md" | "sm";
  children: ReactNode;
};

/**
 * Glass button. Primary carries the shine sweep; press is a 240ms scale to .98.
 * `type="button"` is the default so a button inside a form never submits by accident.
 */
export function Button({ variant = "ghost", size = "md", className, children, ...rest }: Props) {
  const classes = ["btn", `btn--${variant}`, size === "sm" ? "btn--sm" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}
