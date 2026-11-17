import type { OfficeHub } from "./hub";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  OFFICE_HUB: DurableObjectNamespace<OfficeHub>;
  HERMES_ORIGIN: string;
  HERMES_HMAC_SECRET: string;
  SESSION_SECRET: string;
}
