/** Types and bindings for the Rust supervisor. Nothing here runs in a browser. */

export type ServiceState = "stopped" | "starting" | "running" | "failed" | "absent";

export type RuntimeService = {
  id: string;
  name: string;
  state: ServiceState;
  detail: string;
  port: number | null;
  pid: number | null;
};

export type Status = {
  services: RuntimeService[];
  folder: string;
  desired: boolean;
  serverPort: number;
  lanAddress: string | null;
  runtimeRoot: string;
  message: string | null;
  initialised: boolean;
  apiKeySet: boolean;
  allowPhones: boolean;
  /** Whether Windows lets the phone's packets reach the server. */
  firewall: boolean;
};

export type LogSource = {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  bytes: number;
};

export type LogLine = {
  source: string;
  text: string;
};

export type LogView = {
  sources: LogSource[];
  lines: LogLine[];
};

/** Measured from the folder by the supervisor, never from a stored number. */
export type LibraryUsage = {
  folder: string;
  photos: number;
  videos: number;
  bytes: number;
  free: number;
  total: number;
};

export type ImportProgress = {
  running: boolean;
  total: number;
  done: number;
  imported: number;
  duplicates: number;
  failed: number;
  current: string;
  lastError: string | null;
};

/** The folder the app uploads from on its own, and what it has done so far. */
export type WatchStatus = {
  folder: string;
  active: boolean;
  waiting: string | null;
  uploaded: number;
  duplicates: number;
  failed: number;
  lastFile: string;
  lastError: string | null;
};

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export function fetchStatus(): Promise<Status | null> {
  return inTauri ? call<Status>("runtime_status") : Promise.resolve(null);
}

export function startRuntime(): Promise<Status> {
  return call<Status>("runtime_start");
}

export function stopRuntime(): Promise<Status> {
  return call<Status>("runtime_stop");
}

export function setLibraryFolder(path: string): Promise<Status> {
  return call<Status>("set_library_folder", { path });
}

/** Opens Immich's own web app in its own window, pointed at this server. */
export function openLibrary(): Promise<void> {
  return call<void>("open_library");
}

export function fetchImport(): Promise<ImportProgress> {
  return call<ImportProgress>("import_status");
}

export function startImport(paths: string[]): Promise<ImportProgress> {
  return call<ImportProgress>("import_paths", { paths });
}

export function saveApiKey(key: string): Promise<Status> {
  return call<Status>("set_api_key", { key });
}

export function setAllowPhones(enabled: boolean): Promise<Status> {
  return call<Status>("set_allow_phones", { enabled });
}

/** Asks Windows for the inbound rule, which is the one thing a phone needs that
 * the app cannot grant itself. */
export function allowFirewall(): Promise<Status> {
  return call<Status>("allow_firewall");
}

/** SVG markup for the address, drawn in Rust so the code has tests behind it. */
export function phoneQr(url: string): Promise<string> {
  return call<string>("phone_qr", { url });
}

export function fetchWatch(): Promise<WatchStatus> {
  return call<WatchStatus>("watch_status");
}

/** An empty path stops watching. */
export function setWatchFolder(path: string): Promise<WatchStatus> {
  return call<WatchStatus>("set_watch_folder", { path });
}

/** The tail of the server log, the database log, or both. */
export function fetchLogs(source: string): Promise<LogView> {
  return call<LogView>("logs_read", { source });
}

export function fetchUsage(): Promise<LibraryUsage> {
  return call<LibraryUsage>("library_usage");
}

/** The address to paste into the phone app. */
export function serverUrl(status: Status): string {
  const host = status.lanAddress ?? "127.0.0.1";
  return `http://${host}:${status.serverPort}`;
}
