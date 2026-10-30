export type ViewId = "overview" | "storage" | "backups" | "logs";

export const viewTitles: Record<ViewId, string> = {
  overview: "Overview",
  storage: "Storage",
  backups: "Backups",
  logs: "Logs",
};
