import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchImport,
  fetchWatch,
  inTauri,
  setWatchFolder,
  startImport,
  type ImportProgress,
  type WatchStatus,
} from "@/app/runtime";

/**
 * Import progress is polled, not pushed: the uploader lives on its own thread and
 * a message per file would be more machinery than a 900 ms poll.
 */
export function useImport(active: boolean) {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!inTauri) {
      return;
    }
    let alive = true;

    const load = async () => {
      try {
        const next = await fetchImport();
        if (alive) {
          setProgress(next);
        }
      } catch {
        // A missing server just means nothing to show yet.
      }
    };

    void load();
    // Poll while a job runs, and keep a slow heartbeat so a finished job's
    // numbers stay on screen.
    const every = progress?.running || dropping ? 600 : 4000;
    timer.current = window.setInterval(() => void load(), every);
    return () => {
      alive = false;
      window.clearInterval(timer.current);
    };
  }, [progress?.running, dropping, active]);

  const start = useCallback(async (paths: string[]) => {
    if (!paths.length) {
      return;
    }
    setError(null);
    try {
      setProgress(await startImport(paths));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  return { progress, error, start, dropping, setDropping };
}

/**
 * The watched folder is owned by a thread in Rust; this only mirrors it. The
 * poll is slow on purpose — the work happens whether the window is open or not.
 */
export function useWatch() {
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inTauri) {
      return;
    }
    let alive = true;

    const load = async () => {
      try {
        const next = await fetchWatch();
        if (alive) {
          setWatch(next);
        }
      } catch {
        // Nothing to show until the shell answers; the previous value stands.
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const choose = useCallback(async () => {
    setError(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose a folder to watch",
      defaultPath: watch?.folder || undefined,
    });
    if (!picked) {
      return;
    }
    try {
      setWatch(await setWatchFolder(String(picked)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [watch?.folder]);

  const stop = useCallback(async () => {
    setError(null);
    try {
      setWatch(await setWatchFolder(""));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  return { watch, error, choose, stop };
}

/** Highlights the drop zone while a drag hovers and hands over the dropped paths. */
export function useFileDrop(onDrop: (paths: string[]) => void) {
  useEffect(() => {
    if (!inTauri) {
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          window.dispatchEvent(new CustomEvent("immich-drag", { detail: true }));
        }
        if (event.payload.type === "leave") {
          window.dispatchEvent(new CustomEvent("immich-drag", { detail: false }));
        }
        if (event.payload.type === "drop") {
          window.dispatchEvent(new CustomEvent("immich-drag", { detail: false }));
          onDrop(event.payload.paths);
        }
      });
      if (cancelled) {
        stop();
      } else {
        unlisten = stop;
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onDrop]);
}
