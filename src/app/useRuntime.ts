import { useCallback, useEffect, useState } from "react";
import {
  allowFirewall as requestFirewall,
  fetchStatus,
  inTauri,
  setAllowPhones,
  setLibraryFolder,
  startRuntime,
  stopRuntime,
  type Status,
} from "@/app/runtime";

const POLL_MS = 1200;

/**
 * The supervisor is the source of truth; the UI polls it. Polling beats an event
 * stream here because every view shows the same three rows and the states change
 * on process timing, not on user input.
 */
export function useRuntime() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inTauri) {
      return;
    }
    let alive = true;

    const load = async () => {
      try {
        const next = await fetchStatus();
        if (alive) {
          setStatus(next);
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
  }, []);

  const run = useCallback(async (action: () => Promise<Status>) => {
    try {
      setStatus(await action());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const start = useCallback(() => run(startRuntime), [run]);
  const stop = useCallback(() => run(stopRuntime), [run]);

  // The refusal goes back to the caller: Storage shows it beside the field that
  // caused it, instead of on Overview where the user is not looking.
  const chooseFolder = useCallback(async (path: string) => {
    setStatus(await setLibraryFolder(path));
    setError(null);
  }, []);

  const allowPhones = useCallback((enabled: boolean) => run(() => setAllowPhones(enabled)), [run]);
  const allowFirewall = useCallback(() => run(requestFirewall), [run]);

  return { status, error, start, stop, chooseFolder, allowPhones, allowFirewall, live: inTauri };
}
