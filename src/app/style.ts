import { useCallback, useEffect, useState } from "react";
import { inTauri, setUiStyle } from "@/app/runtime";

/**
 * Which look the hub wears.
 *
 * The id lives on `<html data-style>`; there are two, `light` and `dark`, and
 * both are walks of the one ladder in `styles/system.css`. `settings.json` is
 * the authority — the shell owns it, and it also restyles the window frame —
 * while `localStorage` is only the cache that `index.html` reads before the
 * first paint, so a relaunch shows the chosen look immediately instead of the
 * default one.
 *
 * Dark is the default: a fresh install opens on the system look in the
 * appearance macOS is most likely to be in at night.
 */

const STYLE_KEY = "uiStyle";

export const UI_STYLES = [
  {
    id: "light",
    name: "Light",
    note: "The macOS window by day: a flush sidebar, hairlines, 28px controls, San Francisco.",
  },
  {
    id: "dark",
    name: "Dark",
    note: "The same window at night. Elevated greys, systemBlue, one hairline.",
  },
] as const;

export type StyleId = (typeof UI_STYLES)[number]["id"];

const DEFAULT_STYLE: StyleId = "dark";

/** A saved value this build does not ship must not leave the window unstyled. */
function isStyle(value: unknown): value is StyleId {
  return UI_STYLES.some((option) => option.id === value);
}

/** What the boot script wrote, or the default if the attribute is missing. */
function currentStyle(): StyleId {
  const id = document.documentElement.dataset.style;
  return isStyle(id) ? id : DEFAULT_STYLE;
}

/** Paint it now and cache it for the next launch. */
function applyStyle(id: StyleId) {
  document.documentElement.dataset.style = id;
  try {
    localStorage.setItem(STYLE_KEY, id);
  } catch {
    // A disabled store costs the flash-free relaunch, never the change.
  }
}

/**
 * The style, and a setter that persists.
 *
 * `saved` is what `settings.json` says, arriving with the status poll. It wins
 * when it differs — a hand-edited file, or a config carried over from another
 * machine — but only when it actually changes, so adopting it can never fight
 * the picker mid-choice. The visual change lands before the write does: a
 * failed save is reported, not rolled back, because the person already saw it.
 */
export function useStyle(saved: string | null) {
  const [style, setStyleState] = useState<StyleId>(() => currentStyle());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isStyle(saved) && saved !== style) {
      applyStyle(saved);
      setStyleState(saved);
    }
    // Only on a new saved value; `style` is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const setStyle = useCallback((next: StyleId) => {
    applyStyle(next);
    setStyleState(next);
    setError(null);
    if (!inTauri) {
      return;
    }
    void setUiStyle(next)
      .then(() => setError(null))
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`The look changed, but it could not be saved: ${message}`);
      });
  }, []);

  return { style, setStyle, error };
}
