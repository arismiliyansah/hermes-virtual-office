import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import {
  type AuthVariables,
  csrfProtection,
  expiredSessionCookie,
  requireAuth,
  sessionCookie,
  startSession,
  verifyPassword,
} from "./auth";
import { getUserByEmail } from "./db";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  OFFICE_HUB: DurableObjectNamespace<OfficeHub>;
  HERMES_ORIGIN: string;
  SESSION_SECRET: string;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use("/api/*", csrfProtection());

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/auth/login", async (c) => {
  const body = await c.req
    .json<{ email?: unknown; password?: unknown }>()
    .catch(() => null);

  if (
    body === null ||
    typeof body.email !== "string" ||
    typeof body.password !== "string"
  ) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const user = await getUserByEmail(c.env.DB, body.email.trim());
  if (user === null || !(await verifyPassword(body.password, user.password_hash))) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const { token, csrf } = await startSession(user.id, c.env.SESSION_SECRET);
  c.header("Set-Cookie", sessionCookie(token));

  return c.json({ csrf });
});

app.post("/api/auth/logout", (c) => {
  c.header("Set-Cookie", expiredSessionCookie());
  return c.body(null, 204);
});

app.get(
  "/api/auth/me",
  (c, next) => requireAuth(c.env.SESSION_SECRET)(c, next),
  (c) => c.json({ userId: c.get("userId") }),
);

export class OfficeHub extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return Response.json({ error: "not_implemented" }, { status: 501 });
  }
}

export default app;
