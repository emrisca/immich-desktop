import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  className?: string;
};

export function Panel({ children, className }: Props) {
  return <section className={["panel", className].filter(Boolean).join(" ")}>{children}</section>;
}
