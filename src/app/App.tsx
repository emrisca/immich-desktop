import { useEffect, useRef, useState } from "react";
import { Backups } from "@/app/Backups";
import { FirstRun } from "@/app/FirstRun";
import { openLibrary } from "@/app/runtime";
import { Logs } from "@/app/Logs";
import { Overview } from "@/app/Overview";
import { Sidebar } from "@/app/Sidebar";
import { Storage } from "@/app/Storage";
import { TitleBar } from "@/app/TitleBar";
import { useRuntime } from "@/app/useRuntime";
import { useSetup } from "@/app/setup";
import { viewTitles, type ViewId } from "@/app/view";
import type { Status } from "@/app/runtime";
import { Pill, type Tone } from "@/ui/Pill";

/**
 * The sticky line above the page. It survives the hero scrolling away, so the
 * window always says which section it is on and whether the server behind it is
 * up — without repeating either in the content.
 */
function TopBar({
  title,
  status,
  live,
}: {
  title: string;
  status: Status | null;
  live: boolean;
}) {
  const services = status?.services ?? [];
  const running = services.filter((service) => service.state === "running").length;
  const starting = services.some((service) => service.state === "starting") || Boolean(status?.desired);
  const all = services.length > 0 && running === services.length;
  const tone: Tone = !live ? "idle" : all ? "live" : starting ? "busy" : "idle";
  const label = !live
    ? "preview data"
    : services.length
      ? `${running} of ${services.length} running`
      : "reading status";
  const address =
    live && status?.lanAddress ? `http://${status.lanAddress}:${status.serverPort}` : null;

  return (
    <div className="topbar">
      <span className="topbar__title">{title}</span>
      <div className="topbar__meta">
        {address ? <span className="topbar__address">{address}</span> : null}
        <Pill tone={tone}>{label}</Pill>
      </div>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<ViewId>("overview");
  const runtime = useRuntime();
  const serverRunning =
    runtime.status?.services.find((service) => service.id === "server")?.state === "running";
  const { setup, markCreated } = useSetup(
    Boolean(serverRunning),
    runtime.status?.folder ?? null,
  );
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  const showLibrary = async () => {
    try {
      await openLibrary();
      setLibraryError(null);
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  // A fresh installation lands on the account form instead of a hub whose phone
  // address nobody can use yet.
  const firstRun = runtime.live && Boolean(serverRunning) && setup?.initialised === false;

  // The scrolling element is the shell, not the page, so a section switch has to
  // put it back at the top itself — otherwise Storage opens halfway down.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [view, firstRun]);

  return (
    <>
      <div className="aurora" aria-hidden="true" />
      <div className="window">
        <TitleBar />
        <div className="shell">
          <Sidebar view={view} onSelect={setView} live={runtime.live && runtime.status !== null} />
          <main className="main" id="main" ref={mainRef}>
            <TopBar
              title={firstRun ? "First run" : viewTitles[view]}
              status={runtime.status}
              live={runtime.live && runtime.status !== null}
            />
            {firstRun ? (
              <FirstRun onCreated={markCreated} />
            ) : view === "overview" ? (
              <Overview
                status={runtime.status}
                live={runtime.live}
                error={runtime.error}
                onStart={() => void runtime.start()}
                onStop={() => void runtime.stop()}
                onOpenLibrary={() => void showLibrary()}
                onAllowPhones={runtime.allowPhones}
                onAllowFirewall={() => void runtime.allowFirewall()}
                libraryError={libraryError}
              />
            ) : null}
            {view === "storage" ? (
              <Storage
                folder={runtime.status?.folder ?? null}
                live={runtime.live}
                onChooseFolder={runtime.chooseFolder}
              />
            ) : null}
            {view === "backups" ? <Backups /> : null}
            {view === "logs" ? <Logs /> : null}
          </main>
        </div>
      </div>
    </>
  );
}
