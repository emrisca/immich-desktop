import type { KeyboardEvent } from "react";
import { UI_STYLES, type StyleId } from "@/app/style";
import { Pill } from "@/ui/Pill";

type Props = {
  style: StyleId;
  onSelect: (style: StyleId) => void;
  error: string | null;
};

/**
 * The appearance bar.
 *
 * A radio group, not a grid of screenshots: each option renders a miniature
 * from the real primitives — the same `panel`, `btn` and `pill` classes, inside
 * its own `data-style` subtree — so a swatch cannot drift from the style it
 * promises. There is no second drawing of the design to keep in step.
 *
 * Choosing applies immediately; there is nothing to save, and nothing that can
 * be left dirty.
 */
export function Settings({ style, onSelect, error }: Props) {
  // Arrow keys move the selection and focus follows it, as a radio group does.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
    if (!keys.includes(event.key)) {
      return;
    }
    event.preventDefault();
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const index = UI_STYLES.findIndex((option) => option.id === style);
    const next = UI_STYLES[(index + step + UI_STYLES.length) % UI_STYLES.length];
    onSelect(next.id);
    document.getElementById(`style-${next.id}`)?.focus();
  };

  return (
    <div className="page">
      <section className="panel settings">
        <p className="eyebrow">APPEARANCE</p>
        <h2 className="display display--sm">Choose a look</h2>
        <p className="lede">
          Every style is a complete design: the same window, the same controls, drawn differently.
          The choice is stored on this machine, and the library keeps Immich&rsquo;s own
          appearance either way.
        </p>

        <div
          className="styles"
          role="radiogroup"
          aria-label="Interface style"
          onKeyDown={onKeyDown}
        >
          {UI_STYLES.map((option) => {
            const selected = option.id === style;
            return (
              <button
                key={option.id}
                id={`style-${option.id}`}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className="stylecard"
                onClick={() => onSelect(option.id)}
              >
                <span className="stylecard__head">
                  <span className="stylecard__name">{option.name}</span>
                  {/* Always rendered, so choosing cannot resize the card. */}
                  <span className="stylecard__state" aria-live="polite">
                    {selected ? "In use" : ""}
                  </span>
                </span>

                {/* Its own tokens, on its own subtree: the swatch is the style. */}
                <span className="stylecard__frame" data-style={option.id} aria-hidden="true">
                  <span className="stylecard__panel panel">
                    <span className="stylecard__lines">
                      <span className="stylecard__line stylecard__line--short" />
                      <span className="stylecard__line" />
                    </span>
                    <span className="stylecard__controls">
                      <span className="btn btn--primary btn--sm">Copy address</span>
                      <Pill tone="live">live</Pill>
                    </span>
                  </span>
                </span>

                <span className="stylecard__note">{option.note}</span>
              </button>
            );
          })}
        </div>

        {error ? <p className="hint hint--flag">{error}</p> : null}
      </section>
    </div>
  );
}
