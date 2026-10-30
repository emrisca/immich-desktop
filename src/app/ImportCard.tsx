import { useCallback, useEffect, useState } from "react";
import { saveApiKey, type Status, type WatchStatus } from "@/app/runtime";
import { useFileDrop, useImport, useWatch } from "@/app/useImport";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Panel } from "@/ui/Panel";

/** What the watcher has done, in the fewest words that are still true. */
function watchSummary(watch: WatchStatus): string {
  if (watch.waiting) {
    return watch.waiting;
  }
  const counted = [
    watch.uploaded ? `${watch.uploaded} uploaded` : "",
    watch.duplicates ? `${watch.duplicates} already there` : "",
    watch.failed ? `${watch.failed} failed` : "",
  ].filter(Boolean);
  if (counted.length) {
    return counted.join(" · ");
  }
  return watch.lastFile ? `Uploading ${watch.lastFile}` : "Waiting for something new";
}

type Props = {
  status: Status | null;
  live: boolean;
  /** Imports need the server and its API key; without both this is a hint. */
  running: boolean;
};

export function ImportCard({ status, live, running }: Props) {
  const { progress, error, start, dropping, setDropping } = useImport(running);
  const { watch, error: watchError, choose, stop } = useWatch();
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const drop = useCallback((paths: string[]) => void start(paths), [start]);
  useFileDrop(drop);

  useEffect(() => {
    const onDrag = (event: Event) =>
      setDropping(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener("immich-drag", onDrag);
    return () => window.removeEventListener("immich-drag", onDrag);
  }, [setDropping]);

  const chooseFolder = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: true,
      title: "Choose folders to import",
    });
    if (!picked) {
      return;
    }
    void start(Array.isArray(picked) ? picked : [picked]);
  };

  const saveKey = async () => {
    setSaving(true);
    setKeyError(null);
    try {
      await saveApiKey(key);
      setSaved(true);
      setKey("");
    } catch (cause) {
      setKeyError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const hasKey = saved || Boolean(status?.apiKeySet);
  const busy = progress?.running ?? false;
  const percent =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const finished = progress && !progress.running && progress.done > 0;

  return (
    <Panel index={3}>
      <div className="section-head">
        <p className="eyebrow">Import</p>
        <span className="section-head__note">
          {busy ? `${progress?.done} of ${progress?.total}` : "Drop files or pick a folder"}
        </span>
      </div>

      {live && !hasKey ? (
        <div className="setup__form" style={{ marginBottom: 16 }}>
          <Field
            label="Immich API key"
            mono
            value={key}
            placeholder="paste an API key"
            onChange={(event) => setKey(event.target.value)}
            hint="Open the library once, then Settings → API Keys → New API Key. Imports use it instead of your password."
            action={
              <Button size="sm" onClick={() => void saveKey()} disabled={!key.trim() || saving}>
                {saving ? "Saving" : "Save"}
              </Button>
            }
          />
          {keyError ? <p className="setup__error">{keyError}</p> : null}
        </div>
      ) : null}

      <div
        className={`dropzone${dropping ? " dropzone--over" : ""}${busy ? " dropzone--busy" : ""}`}
      >
        <p className="dropzone__title">
          {busy ? `Importing ${progress?.done} of ${progress?.total}` : "Drop photos or a folder"}
        </p>
        <p className="dropzone__note">
          {busy
            ? progress?.current
            : "JPG, PNG, HEIC, RAW and the usual video formats. Files already in the library are skipped."}
        </p>

        {busy ? (
          <div className="meter" style={{ marginTop: 14 }}>
            <div className="meter__track" role="meter" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Import progress">
              <div className="meter__fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : (
          <div className="phone__actions" style={{ justifyContent: "center", marginTop: 14 }}>
            <Button
              variant="primary"
              onClick={() => void chooseFolder()}
              disabled={!running || !hasKey}
            >
              Choose a folder
            </Button>
          </div>
        )}
      </div>

      <div className="watch">
        <div className="section-head" style={{ marginBottom: 8 }}>
          <span className="eyebrow">Watched folder</span>
          <span className="section-head__note">
            {watch?.active ? (watch.waiting ? "paused" : "watching") : "off"}
          </span>
        </div>

        {watch?.active ? (
          <>
            <p className="watch__path mono" title={watch.folder}>
              {watch.folder}
            </p>
            <div className="watch__row">
              <Button size="sm" onClick={() => void choose()}>
                Change
              </Button>
              <Button size="sm" variant="quiet" onClick={() => void stop()}>
                Stop watching
              </Button>
              <span className="hint" style={{ margin: 0 }}>
                {watchSummary(watch)}
              </span>
            </div>
            {watch.lastError && !watch.waiting ? (
              <p className="hint">{watch.lastError}</p>
            ) : null}
          </>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              Save a photo into one folder and it lands in Immich within seconds — point this at
              whatever your phone sync or camera import already writes to. Nothing is moved or
              deleted.
            </p>
            <Button size="sm" onClick={() => void choose()}>
              Choose folder
            </Button>
          </>
        )}
        {watchError ? <p className="setup__error">{watchError}</p> : null}
      </div>

      {finished ? (
        <p className="hint" style={{ marginTop: 12 }}>
          {progress?.imported} added
          {progress?.duplicates ? `, ${progress.duplicates} already there` : ""}
          {progress?.failed ? `, ${progress.failed} failed` : ""}.
        </p>
      ) : null}
      {error ? <p className="setup__error" style={{ marginTop: 12 }}>{error}</p> : null}
      {progress?.lastError && !busy ? (
        <p className="hint" style={{ marginTop: 8 }}>
          {progress.lastError}
        </p>
      ) : null}
      {!running && live ? (
        <p className="hint" style={{ marginTop: 12 }}>
          Start the server to import.
        </p>
      ) : null}
    </Panel>
  );
}
