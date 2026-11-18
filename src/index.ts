import { Hono, type Context } from "hono";
import {
  type AuthVariables,
  csrfProtection,
  expiredSessionCookie,
  requireAuth,
  secureSessionGuard,
  sessionCookie,
  startSession,
  verifyPasswordOrDummy,
} from "./auth";
import { getUserByEmail } from "./db";
import type { Env } from "./env";
import { HermesClient } from "./hermes";
import type { ServerMsg } from "./protocol";
import { clientIp, rateLimit } from "./ratelimit";
import { createAgentRoutes } from "./routes-agents";
import { createCronRoutes } from "./routes-cron";
import { createMeetingRoutes } from "./routes-meetings";
import { createTaskRoutes } from "./routes-tasks";

export { OfficeHub } from "./hub";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

type AppContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

export const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;

const loginLimiter = rateLimit({
  ...LOGIN_RATE_LIMIT,
  scope: "auth",
  subject: clientIp,
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.use("/api/*", secureSessionGuard());
app.use("/api/*", csrfProtection());

app.post("/api/auth/login", loginLimiter, async (c) => {
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
  // Unknown emails still pay the PBKDF2 cost; account existence must not be
  // observable through response timing.
  const passwordOk = await verifyPasswordOrDummy(
    body.password,
    user?.password_hash,
  );
  if (user === null || !passwordOk) {
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

app.get(
  "/api/ws",
  (c, next) => requireAuth(c.env.SESSION_SECRET)(c, next),
  (c) => {
    const stub = c.env.OFFICE_HUB.get(c.env.OFFICE_HUB.idFromName("main"));
    return stub.fetch(c.req.raw);
  },
);

// Bindings (Hermes origin/secret, D1) only exist per request, so build the
// agents router on demand. The router matches /agents, hence the /api strip.
function withoutApiPrefix(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice("/api".length) || "/";
  return new Request(url, request);
}

/**
 * Routes stay usable in tests and local runs without a hub binding. Delivery
 * failures are swallowed: HTTP state changes must not fail on realtime noise.
 */
function hubBroadcast(
  env: Env,
): ((message: ServerMsg) => Promise<void>) | undefined {
  const hub = (env as Partial<Env>).OFFICE_HUB;
  if (hub === undefined || hub === null) return undefined;

  return async (message) => {
    try {
      const stub = hub.get(hub.idFromName("main"));
      await stub.fetch("https://hub/broadcast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });
    } catch {
      // Best effort: the request already committed its database writes.
    }
  };
}

async function mountAgentRoutes(c: AppContext): Promise<Response> {
  const routes = createAgentRoutes({
    hermes: new HermesClient({
      origin: c.env.HERMES_ORIGIN,
      secret: c.env.HERMES_HMAC_SECRET,
    }),
    db: c.env.DB,
    broadcast: hubBroadcast(c.env),
  });

  return routes.fetch(withoutApiPrefix(c.req.raw), c.env);
}

app.use("/api/agents", mountAgentRoutes);
app.use("/api/agents/:id/messages", mountAgentRoutes);

async function mountTaskRoutes(c: AppContext): Promise<Response> {
  const routes = createTaskRoutes({
    hermes: new HermesClient({
      origin: c.env.HERMES_ORIGIN,
      secret: c.env.HERMES_HMAC_SECRET,
    }),
    db: c.env.DB,
    broadcast: hubBroadcast(c.env),
  });

  return routes.fetch(withoutApiPrefix(c.req.raw), c.env);
}

app.use("/api/tasks", mountTaskRoutes);
app.use("/api/tasks/:id/status", mountTaskRoutes);

async function mountCronRoutes(c: AppContext): Promise<Response> {
  const routes = createCronRoutes({
    hermes: new HermesClient({
      origin: c.env.HERMES_ORIGIN,
      secret: c.env.HERMES_HMAC_SECRET,
    }),
    db: c.env.DB,
    broadcast: hubBroadcast(c.env),
  });

  return routes.fetch(withoutApiPrefix(c.req.raw), c.env);
}

app.use("/api/cron", mountCronRoutes);
app.use("/api/cron/:id/toggle", mountCronRoutes);
app.use("/api/cron/:id/run", mountCronRoutes);

async function mountMeetingRoutes(c: AppContext): Promise<Response> {
  const routes = createMeetingRoutes({
    hermes: new HermesClient({
      origin: c.env.HERMES_ORIGIN,
      secret: c.env.HERMES_HMAC_SECRET,
    }),
    db: c.env.DB,
    broadcast: hubBroadcast(c.env),
  });

  return routes.fetch(withoutApiPrefix(c.req.raw), c.env);
}

app.use("/api/meetings", mountMeetingRoutes);
app.use("/api/meetings/:id", mountMeetingRoutes);

export default app;
