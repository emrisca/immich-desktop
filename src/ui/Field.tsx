import { useId, type InputHTMLAttributes, type ReactNode } from "react";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  mono?: boolean;
  action?: ReactNode;
};

/**
 * A label, a recessed well and an input. `action` renders at the end of the well,
 * which is how the server address gets its copy button without a second control row.
 */
export function Field({ label, hint, mono, action, className, id, ...rest }: Props) {
  const generated = useId();
  const inputId = id ?? generated;
  const classes = ["field", mono ? "field--mono" : "", className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="field__box">
        <input id={inputId} className="field__input" {...rest} />
        {action}
      </div>
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}
