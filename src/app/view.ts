export type ViewId = "overview" | "storage" | "backups" | "logs" | "settings";

export const viewTitles: Record<ViewId, string> = {
  overview: "Overview",
  storage: "Storage",
  backups: "Backups",
  logs: "Logs",
  settings: "Settings",
};
