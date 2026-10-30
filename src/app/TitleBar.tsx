import { useEffect, useState } from "react";

// The window API only exists inside Tauri. In a browser preview the controls are
// rendered but inert, so the layout can still be judged.
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// The window is frameless everywhere, so these buttons are the only way to move,
// zoom or close it. On a Mac they belong on the left, as circles — three squares
// on the right read as a broken window, not a deliberate one.
const isMac =
  typeof navigator !== "undefined" &&
  /mac/i.test(`${navigator.userAgent} ${navigator.platform ?? ""}`);

type WindowApi = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
};

export function TitleBar() {
  const [windowApi, setWindowApi] = useState<WindowApi | null>(null);

  useEffect(() => {
    if (!inTauri) {
      return;
    }
    let cancelled = false;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (cancelled) {
        return;
      }
      const win = getCurrentWindow();
      setWindowApi({
        minimize: () => win.minimize(),
        toggleMaximize: () => win.toggleMaximize(),
        close: () => win.close(),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Declared in Mac order (close, minimise, zoom); Windows shows them in its own.
  const close = {
    key: "close",
    label: "Close",
    modifier: "winbtn--close",
    run: () => void windowApi?.close(),
    glyph: (
      <path d="M2.6 2.6l4.8 4.8M7.4 2.6L2.6 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    ),
  };
  const minimise = {
    key: "minimise",
    label: "Minimise",
    modifier: "",
    run: () => void windowApi?.minimize(),
    glyph: <path d="M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />,
  };
  const zoom = {
    key: "zoom",
    label: isMac ? "Zoom" : "Maximise",
    modifier: "",
    run: () => void windowApi?.toggleMaximize(),
    glyph: (
      <rect
        x="2.2"
        y="2.2"
        width="5.6"
        height="5.6"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    ),
  };

  const ordered = isMac ? [close, minimise, zoom] : [minimise, zoom, close];

  const controls = (
    <div className={`titlebar__controls${isMac ? " titlebar__controls--mac" : ""}`}>
      {ordered.map((button) => (
        <button
          key={button.key}
          type="button"
          className={["winbtn", button.modifier, isMac ? `winbtn--mac winbtn--mac-${button.key}` : ""]
            .filter(Boolean)
            .join(" ")}
          aria-label={button.label}
          title={button.label}
          disabled={!windowApi}
          onClick={button.run}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            {button.glyph}
          </svg>
        </button>
      ))}
    </div>
  );

  return (
    <header className="titlebar" data-mac={isMac ? "true" : "false"}>
      {isMac ? controls : <span className="titlebar__mark" aria-hidden="true" />}
      <span className="titlebar__name">Immich Desktop</span>
      <div className="titlebar__drag" data-tauri-drag-region />
      {isMac ? null : controls}
    </header>
  );
}
