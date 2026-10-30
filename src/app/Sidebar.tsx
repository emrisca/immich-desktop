import { isMac } from "@/app/platform";
import { Panel } from "@/ui/Panel";
import type { ViewId } from "@/app/view";

type Props = {
  view: ViewId;
  onSelect: (view: ViewId) => void;
  live: boolean;
};

const items: { id: ViewId; label: string; count?: string }[] = [
  { id: "overview", label: "Overview" },
  // Counts stay off until they are measured: a placeholder number here reads as
  // real usage on the same screen that reports live ports.
  { id: "storage", label: "Storage" },
  { id: "backups", label: "Backups" },
  { id: "logs", label: "Logs" },
];

export function Sidebar({ view, onSelect, live }: Props) {
  return (
    <Panel className="sidebar">
      <p className="sidebar__heading">This machine</p>
      <nav className="sidebar__nav" aria-label="Sections">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="navitem"
            aria-current={item.id === view ? "page" : undefined}
            onClick={() => onSelect(item.id)}
          >
            <span className="navitem__dot" aria-hidden="true" />
            {item.label}
            {item.count ? <span className="navitem__count">{item.count}</span> : null}
          </button>
        ))}
      </nav>
      {/* Settings sits at the foot, away from the four sections it configures:
          it changes the window, not the library — and only the Mac build has a
          window to change, so the Windows one keeps the footer it shipped with. */}
      <div className="sidebar__foot">
        {isMac ? (
          <>
            <button
              type="button"
              className="footlink"
              aria-current={view === "settings" ? "page" : undefined}
              onClick={() => onSelect("settings")}
            >
              {/* Sliders, not a gear: at 13px a toothed circle reads as a sun. */}
              <svg viewBox="0 0 16 16" aria-hidden="true">
                {/* The rules break where the knob sits, so the icon needs no fill
                    and sits on whatever background the sidebar foot has. */}
                <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                  <path d="M2 4.4h1.9M7.3 4.4H14M2 8h6.7M12.1 8H14M2 11.6h3.1M8.5 11.6H14" />
                  <circle cx="5.6" cy="4.4" r="1.5" />
                  <circle cx="10.4" cy="8" r="1.5" />
                  <circle cx="6.8" cy="11.6" r="1.5" />
                </g>
              </svg>
              Settings
            </button>
            <p className="footlink__meta">
              <span>0.1.0</span>
              <span aria-hidden="true">·</span>
              <span>{live ? "live" : "preview data"}</span>
            </p>
          </>
        ) : (
          <>
            <span>0.1.0</span>
            <span aria-hidden="true">·</span>
            <span>{live ? "live" : "preview data"}</span>
          </>
        )}
      </div>
    </Panel>
  );
}
