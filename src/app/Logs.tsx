import { Fragment, useEffect, useState } from "react";
import { fetchLogs, inTauri, type LogView } from "@/app/runtime";
import { Panel } from "@/ui/Panel";
import { Tabs, type TabOption } from "@/ui/Tabs";

const options: TabOption[] = [
  { id: "all", label: "All" },
  { id: "server", label: "Server" },
  { id: "database", label: "Database" },
];

/** Both services append as they run, so the pane follows the files. */
const POLL_MS = 2000;

const size = (bytes: number) => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
};

/** The last two path segments, which is enough to recognise the file. */
const file = (path: string) => path.split(/[\\/]/).slice(-2).join("/");

/**
 * What an empty pane should say. A missing file means the service has never run
 * in this library; an existing one means it ran and wrote nothing, which is a
 * different answer to the same blank screen.
 */
function empty(tab: string, view: LogView) {
  const asked = tab === "all" ? view.sources : view.sources.filter((source) => source.id === tab);
  const missing = asked.filter((source) => !source.exists);

  if (asked.length > 0 && missing.length === asked.length) {
    return {
      title:
        asked.length > 1
          ? "Neither service has run in this library"
          : `${asked[0].name} has not run in this library`,
      note:
        asked.length > 1
          ? "Start the server on Overview. Its output and Postgres output go to the logs folder beside the media folder."
          : "Start the server on Overview. Its output goes to the logs folder beside the media folder.",
    };
  }

  return {
    title: "No output yet",
    note: asked
      .map((source) => `${file(source.path)} is ${source.exists ? "empty" : "missing"}`)
      .join(", "),
  };
}

export function Logs() {
  const [tab, setTab] = useState("all");
  const [view, setView] = useState<LogView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inTauri) {
      return;
    }
    let alive = true;

    const load = async () => {
      try {
        const next = await fetchLogs(tab);
        if (alive) {
          setView(next);
          setError(null);
        }
      } catch (cause) {
        if (alive) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [tab]);

  const shown = view?.sources.filter((source) => tab === "all" || source.id === tab) ?? [];
  const blank = view ? empty(tab, view) : null;
  const name = (id: string) => view?.sources.find((source) => source.id === id)?.name ?? id;

  return (
    <div className="page">
      <header>
        <p className="eyebrow">Logs</p>
        <h1 className="display display--sm">Server and database output</h1>
      </header>

      <Panel index={1}>
        <Tabs options={options} value={tab} onChange={setTab} label="Log source" />

        {view && view.lines.length > 0 ? (
          <div className="logs" role="tabpanel" aria-label={`${tab} logs`}>
            {view.lines.map((line, position) => (
              <Fragment key={position}>
                {view.lines[position - 1]?.source !== line.source ? (
                  <p className="logs__source">{name(line.source)}</p>
                ) : null}
                <p className="logs__line">{line.text || "\u00a0"}</p>
              </Fragment>
            ))}
          </div>
        ) : (
          <div className="empty" style={{ marginTop: 14 }} role="tabpanel" aria-label={`${tab} logs`}>
            <span className="empty__title">
              {!inTauri ? "No logs to read here" : (blank?.title ?? "Reading the log files")}
            </span>
            <span className="empty__note">
              {!inTauri
                ? "The desktop app reads these files from this computer. A browser preview has no server behind it."
                : (blank?.note ?? "The pane fills as soon as the supervisor has answered.")}
            </span>
          </div>
        )}

        {error ? (
          <p className="setup__error" style={{ marginTop: 12 }}>
            {error}
          </p>
        ) : null}

        {shown.length > 0 ? (
          <div className="logs__meta">
            {shown.map((source) => (
              <span key={source.id}>
                {file(source.path)} {source.exists ? size(source.bytes) : "not created yet"}
              </span>
            ))}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
