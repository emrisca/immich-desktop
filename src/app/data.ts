/**
 * M1 renders mock data. M2 replaces every value here with the supervisor's
 * snapshot, so the shapes below are the shape that command should return.
 */

export type ServiceState = "running" | "starting" | "offline" | "absent";

export type Service = {
  id: string;
  name: string;
  detail: string;
  port: string;
  state: ServiceState;
};

export const services: Service[] = [
  {
    id: "database",
    name: "Database",
    detail: "Embedded Postgres 17 · pgvector",
    port: ":54329",
    state: "running",
  },
  {
    id: "server",
    name: "Immich server",
    detail: "v3.3.5 · API and job worker",
    port: ":2283",
    state: "starting",
  },
  {
    id: "ml",
    name: "Machine learning",
    detail: "Not installed · 640 MB download",
    port: ":3003",
    state: "absent",
  },
];

export const library = {
  folder: "C:\\Users\\you\\Pictures\\Immich",
  photos: 2418,
  videos: 96,
  used: "12.4 GB",
  free: "465 GB",
  /** Percent of the volume in use by this library, for the meter. */
  share: 3,
};

export const connection = {
  url: "http://192.168.1.42:2283",
  host: "192.168.1.42",
  port: "2283",
  interfaces: ["Wi-Fi", "Ethernet"],
};

export const backups = {
  last: null as string | null,
  schedule: "Not scheduled",
};
