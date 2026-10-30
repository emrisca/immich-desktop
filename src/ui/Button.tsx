import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "quiet";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "md" | "sm";
  children: ReactNode;
};

/**
 * A push button: primary is the one action on a page, ghost is the second, quiet is
 * inline text. It darkens on press, as an AppKit control does.
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
