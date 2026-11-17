import { Hono, type Context } from "hono";
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
import type { Env } from "./env";
import { HermesClient } from "./hermes";
import { createAgentRoutes } from "./routes-agents";

export { OfficeHub } from "./hub";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

type AppContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

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

async function mountAgentRoutes(c: AppContext): Promise<Response> {
  const routes = createAgentRoutes({
    hermes: new HermesClient({
      origin: c.env.HERMES_ORIGIN,
      secret: c.env.HERMES_HMAC_SECRET,
    }),
    db: c.env.DB,
  });

  return routes.fetch(withoutApiPrefix(c.req.raw), c.env);
}

app.use("/api/agents", mountAgentRoutes);
app.use("/api/agents/:id/messages", mountAgentRoutes);

export default app;
