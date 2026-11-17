import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  OFFICE_HUB: DurableObjectNamespace<OfficeHub>;
  HERMES_ORIGIN: string;
  SESSION_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export class OfficeHub extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return Response.json({ error: "not_implemented" }, { status: 501 });
  }
}

export default app;
