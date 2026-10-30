type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
};

/**
 * A switch is a button with `role="switch"`, so Space and Enter already work and
 * the state is announced as on/off rather than as pressed.
 */
export function Switch({ checked, onChange, label, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__track" aria-hidden="true">
        <span className="switch__knob" />
      </span>
      <span>{label}</span>
    </button>
  );
}
