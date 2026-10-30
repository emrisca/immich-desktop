import { useEffect, useState } from "react";
import { inTauri } from "@/app/runtime";

export type Setup = { initialised: boolean };

export type Account = { name: string; email: string; password: string };

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** The local server's own answer to "does this installation have an admin yet?" */
export const fetchSetup = () => invoke<Setup>("server_setup");

export const createAdmin = (account: Account) => invoke<void>("create_admin", account);

/**
 * Polls the local server while it is running, and stops for good once an account
 * exists — after that the hub is the only screen that matters here.
 *
 * `folder` is part of the answer: a different library is a different server, and
 * its "has an admin" answer says nothing about the one that was there before.
 * Without this, switching to an empty folder leaves the hub showing a library
 * nobody can log into.
 */
export function useSetup(running: boolean, folder: string | null) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    setSetup(null);
    setCheckError(null);
  }, [folder]);

  useEffect(() => {
    if (!inTauri || !running || setup?.initialised) {
      return;
    }
    let alive = true;

    const load = async () => {
      try {
        const next = await fetchSetup();
        if (alive) {
          setSetup(next);
          setCheckError(null);
        }
      } catch (cause) {
        // The server is up but still booting its routes; keep the last answer.
        if (alive) {
          setCheckError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [running, setup?.initialised, folder]);

  return { setup, checkError, markCreated: () => setSetup({ initialised: true }) };
}
