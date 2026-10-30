import { useCallback, useEffect, useState } from "react";
import { fetchUsage, inTauri, type LibraryUsage } from "@/app/runtime";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Panel } from "@/ui/Panel";

type Props = {
  folder: string | null;
  live: boolean;
  onChooseFolder: (path: string) => Promise<void>;
};

const size = (bytes: number) => {
  const units: [string, number][] = [
    ["TB", 1024 ** 4],
    ["GB", 1024 ** 3],
    ["MB", 1024 ** 2],
    ["KB", 1024],
  ];
  for (const [label, factor] of units) {
    if (bytes >= factor) {
      // 1.9 TB reads better than 1863.0 GB, and 512 MB better than 512.0 MB.
      return `${(bytes / factor).toFixed(1).replace(/\.0$/, "")} ${label}`;
    }
  }
  return `${bytes} B`;
};

export function Storage({ folder, live, onChooseFolder }: Props) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<LibraryUsage | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const path = folder ?? usage?.folder ?? "";

  const measure = useCallback(async () => {
    if (!inTauri) {
      return;
    }
    setMeasuring(true);
    try {
      setUsage(await fetchUsage());
      setUsageError(null);
    } catch (cause) {
      setUsageError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMeasuring(false);
    }
  }, []);

  // A folder switch changes what is being measured, so it has to be measured
  // again rather than carrying the old library's numbers across.
  useEffect(() => {
    void measure();
  }, [measure, folder]);

  const choose = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose the photo folder",
      defaultPath: folder ?? undefined,
    });
    if (!picked) {
      return;
    }
    setPicking(true);
    setError(null);
    try {
      await onChooseFolder(String(picked));
    } catch (cause) {
      // The refusal belongs next to the field that caused it: a network share or
      // a synced folder is rejected by the supervisor, and that message used to
      // surface only on Overview.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPicking(false);
    }
  };

  const share = usage && usage.total > 0 ? Math.min(100, Math.round((usage.bytes / usage.total) * 100)) : 0;

  return (
    <div className="page">
      <header>
        <p className="eyebrow">Storage</p>
        <h1 className="display display--sm">Where the photos live</h1>
        <p className="lede">
          One folder holds the library, the database cluster, the queue and the backups.
          Point this at a local disk, never a network share or a synced folder.
        </p>
      </header>

      <Panel>
        <Field
          label="Photo folder"
          mono
          readOnly
          value={path}
          hint="Changing this switches the app to that folder. Nothing is moved: the photos and the account in the old folder stay there, and an empty folder starts a fresh library."
          action={
            <Button
              size="sm"
              variant="ghost"
              disabled={!live || picking}
              onClick={() => void choose()}
            >
              {picking ? "Switching" : "Change"}
            </Button>
          }
        />
        {error ? (
          <p className="setup__error" style={{ marginTop: 10 }} role="alert">
            {error}
          </p>
        ) : null}
      </Panel>

      <Panel>
        <div className="section-head">
          <p className="eyebrow">This library</p>
          <span className="section-head__note">
            {usage
              ? `${size(usage.bytes)} on disk`
              : measuring
                ? "measuring"
                : live
                  ? "not measured yet"
                  : "measured in the desktop app"}
          </span>
        </div>
        <div className="meter">
          <div className="meter__head">
            <span>
              {usage
                ? `${usage.photos.toLocaleString()} photos, ${usage.videos.toLocaleString()} videos`
                : "No measurements yet"}
            </span>
            <span>{usage && usage.total > 0 ? `${share}% of the volume` : ""}</span>
          </div>
          <div
            className="meter__track"
            role="meter"
            aria-valuenow={share}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Disk used by the library"
          >
            <div className="meter__fill" style={{ width: `${share}%` }} />
          </div>
        </div>
        {usage && usage.total > 0 ? (
          <p className="hint" style={{ marginTop: 10 }}>
            {size(usage.free)} free of {size(usage.total)} on this volume.
          </p>
        ) : null}
        <dl className="kv" style={{ marginTop: 18 }}>
          <dt>Originals</dt>
          <dd className="mono">media/upload · media/library</dd>
          <dt>Thumbnails</dt>
          <dd className="mono">media/thumbs</dd>
          <dt>Database</dt>
          <dd className="mono">database/pgdata</dd>
        </dl>
        {usageError ? (
          <p className="setup__error" style={{ marginTop: 12 }} role="alert">
            {usageError}
          </p>
        ) : null}
        <div className="phone__actions" style={{ marginTop: 16 }}>
          <Button size="sm" variant="quiet" disabled={!inTauri || measuring} onClick={() => void measure()}>
            {measuring ? "Measuring" : "Measure again"}
          </Button>
          <span className="hint" style={{ margin: 0 }}>
            The walk runs in the background, so a large library takes a moment.
          </span>
        </div>
      </Panel>

      <Panel>
        <p className="eyebrow">Checks before setup</p>
        <div className="empty" style={{ marginTop: 12 }}>
          <span className="empty__title">Folder checks run before the switch</span>
          <span className="empty__note">
            The app refuses network shares, removable volumes and OneDrive-style synced
            folders before it creates the database, because Postgres over a sync client
            corrupts.
          </span>
        </div>
      </Panel>
    </div>
  );
}
