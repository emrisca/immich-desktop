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
    <Panel className="sidebar" blur index={0}>
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
      <div className="sidebar__foot">
        <span>0.1.0</span>
        <span aria-hidden="true">·</span>
        <span>{live ? "live" : "preview data"}</span>
      </div>
    </Panel>
  );
}
