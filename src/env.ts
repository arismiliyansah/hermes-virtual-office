import type { OfficeHub } from "./hub";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  OFFICE_HUB: DurableObjectNamespace<OfficeHub>;
  HERMES_ORIGIN: string;
  SESSION_SECRET: string;
}
