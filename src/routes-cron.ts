import { Hono } from "hono";
import {
  requireAuth,
  type AuthBindings,
  type AuthVariables,
} from "./auth";
import { notify, type Broadcast } from "./broadcast";
import { writeAudit } from "./db";
import { HermesError, type CronJob } from "./hermes";
import { rateLimit } from "./ratelimit";

export const CRON_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

/**
 * The slice of HermesClient the cron routes need. Tests inject an in-memory
 * implementation because workerd cannot reach the node:http mock server.
 */
export interface HermesCronApi {
  listCrons(): Promise<CronJob[]>;
  setCronEnabled(id: string, enabled: boolean): Promise<CronJob>;
  runCron(id: string): Promise<{ runId: string }>;
}

export interface CronRouteDeps {
  hermes: HermesCronApi;
  db: D1Database;
  broadcast?: Broadcast;
}

type CronEnv = { Bindings: AuthBindings; Variables: AuthVariables };

function hermesFailure(error: unknown): Response | null {
  if (!(error instanceof HermesError)) return null;

  return Response.json({ error: "hermes_unavailable" }, { status: 502 });
}

export function createCronRoutes(deps: CronRouteDeps): Hono<CronEnv> {
  const router = new Hono<CronEnv>();
  const limiter = rateLimit(CRON_RATE_LIMIT);

  router.use(
    "*",
    (c, next) => requireAuth(c.env.SESSION_SECRET)(c, next),
    limiter,
  );

  router.get("/cron", async (c) => {
    try {
      return c.json({ crons: await deps.hermes.listCrons() });
    } catch (error) {
      const failure = hermesFailure(error);
      if (failure !== null) return failure;
      throw error;
    }
  });

  router.post("/cron/:id/toggle", async (c) => {
    const body = await c.req
      .json<{ enabled?: unknown }>()
      .catch(() => null);

    if (body === null || typeof body.enabled !== "boolean") {
      return c.json({ error: "invalid_request" }, 400);
    }

    const id = c.req.param("id");

    let cron: CronJob;
    try {
      cron = await deps.hermes.setCronEnabled(id, body.enabled);
    } catch (error) {
      const failure = hermesFailure(error);
      if (failure !== null) return failure;
      throw error;
    }

    await writeAudit(deps.db, {
      userId: c.get("userId"),
      action: "cron.toggle",
      detail: JSON.stringify({ cronId: id, enabled: body.enabled }),
    });
    await notify(deps.broadcast, {
      type: "event",
      payload: {
        text: `Cron "${cron.name}" ${cron.enabled ? "diaktifkan" : "dinonaktifkan"}`,
        ts: Date.now(),
      },
    });

    return c.json({ cron });
  });

  router.post("/cron/:id/run", async (c) => {
    const id = c.req.param("id");

    let result: { runId: string };
    try {
      result = await deps.hermes.runCron(id);
    } catch (error) {
      const failure = hermesFailure(error);
      if (failure !== null) return failure;
      throw error;
    }

    await writeAudit(deps.db, {
      userId: c.get("userId"),
      action: "cron.run",
      detail: JSON.stringify({ cronId: id, runId: result.runId }),
    });
    await notify(deps.broadcast, {
      type: "event",
      payload: {
        text: `Cron "${id}" dijalankan (${result.runId})`,
        ts: Date.now(),
      },
    });

    return c.json({ runId: result.runId });
  });

  return router;
}
