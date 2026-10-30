import { useState } from "react";
import { Panel } from "@/ui/Panel";
import { Tabs, type TabOption } from "@/ui/Tabs";

const options: TabOption[] = [
  { id: "all", label: "All" },
  { id: "server", label: "Server" },
  { id: "database", label: "Database" },
];

const empty: Record<string, { title: string; note: string }> = {
  all: {
    title: "Nothing logged yet",
    note: "Every service writes here once it starts, rotated per service so one chatty stream cannot bury the others.",
  },
  server: {
    title: "No server output",
    note: "Immich's own log lines land here, including job failures and migration results.",
  },
  database: {
    title: "No database output",
    note: "Postgres start-up, checkpoint and error lines. Useful when the server refuses to boot.",
  },
};

export function Logs() {
  const [tab, setTab] = useState("all");
  const state = empty[tab] ?? empty.all;

  return (
    <div className="page">
      <header>
        <p className="eyebrow">Logs</p>
        <h1 className="display display--sm">What the services said</h1>
      </header>

      <Panel index={1}>
        <Tabs options={options} value={tab} onChange={setTab} label="Log source" />
        <div
          className="empty"
          style={{ marginTop: 14 }}
          role="tabpanel"
          aria-label={`${tab} logs`}
        >
          <span className="empty__title">{state.title}</span>
          <span className="empty__note">{state.note}</span>
        </div>
      </Panel>
    </div>
  );
}
