import { useId, useRef, type CSSProperties, type KeyboardEvent } from "react";

export type TabOption = {
  id: string;
  label: string;
};

type Props = {
  options: TabOption[];
  value: string;
  onChange: (id: string) => void;
  label: string;
};

/**
 * Segmented tab control. The thumb slides 240ms; arrow keys move both focus and
 * selection, and only the selected tab sits in the tab order.
 */
export function Tabs({ options, value, onChange, label }: Props) {
  const baseId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );

  const select = (next: number) => {
    const wrapped = (next + options.length) % options.length;
    const option = options[wrapped];
    if (!option) {
      return;
    }
    onChange(option.id);
    refs.current[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown": {
        event.preventDefault();
        select(index + 1);
        break;
      }
      case "ArrowLeft":
      case "ArrowUp": {
        event.preventDefault();
        select(index - 1);
        break;
      }
      case "Home": {
        event.preventDefault();
        select(0);
        break;
      }
      case "End": {
        event.preventDefault();
        select(options.length - 1);
        break;
      }
    }
  };

  return (
    <div
      className="tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ "--tab-count": options.length, "--tab-index": index } as CSSProperties}
    >
      <span className="tabs__thumb" aria-hidden="true" />
      {options.map((option, position) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(node) => {
              refs.current[position] = node;
            }}
            id={`${baseId}-${option.id}`}
            className="tabs__tab"
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
