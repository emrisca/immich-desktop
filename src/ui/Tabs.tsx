import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

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
  const listRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState({ x: 0, width: 0 });
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );

  /**
   * The tabs are as wide as their labels, so the thumb is measured from the one
   * that is selected instead of assuming an equal slice of the row.
   */
  const measure = useCallback(() => {
    const list = listRef.current;
    const tab = refs.current[index];
    if (!list || !tab) {
      return;
    }
    const row = list.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    setThumb((current) =>
      current.x === box.left - row.left && current.width === box.width
        ? current
        : { x: box.left - row.left, width: box.width },
    );
  }, [index]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const tab of refs.current) {
      if (tab) {
        observer.observe(tab);
      }
    }
    return () => observer.disconnect();
  }, [measure]);

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
      ref={listRef}
      className="tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ "--thumb-x": `${thumb.x}px`, "--thumb-w": `${thumb.width}px` } as CSSProperties}
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
