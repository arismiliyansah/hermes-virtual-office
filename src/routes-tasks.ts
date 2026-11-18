import { Hono } from "hono";
import {
  requireAuth,
  type AuthBindings,
  type AuthVariables,
} from "./auth";
import { notify, type Broadcast } from "./broadcast";
import {
  clearTaskLabel,
  listKnownTaskStatuses,
  listTasks,
  pruneTasks,
  recordTaskStatuses,
  upsertTask,
  writeAudit,
  type TaskRow,
} from "./db";
import { HermesError, type TaskCard } from "./hermes";
import { rateLimit } from "./ratelimit";

export const TASK_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

/**
 * The slice of HermesClient the task routes need. Tests inject an in-memory
 * implementation because workerd cannot reach the node:http mock server.
 */
export interface HermesTaskApi {
  listTasks(): Promise<TaskCard[]>;
  createTask(title: string, ownerAgentId: string | null): Promise<TaskCard>;
  updateTaskStatus(id: string, status: string): Promise<TaskCard>;
}

export interface TaskRouteDeps {
  hermes: HermesTaskApi;
  db: D1Database;
  broadcast?: Broadcast;
}

type TaskEnv = { Bindings: AuthBindings; Variables: AuthVariables };

/** Hermes-owned fields only: omitting office_label lets COALESCE keep the label. */
function hermesFields(task: TaskCard): {
  id: string;
  title: string;
  status: string;
  owner_agent: string | null;
} {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    owner_agent: task.owner,
  };
}

async function readTask(db: D1Database, id: string): Promise<TaskRow | null> {
  return (await listTasks(db)).find((task) => task.id === id) ?? null;
}

function hermesFailure(error: unknown): Response | null {
  if (!(error instanceof HermesError)) return null;

  return Response.json({ error: "hermes_unavailable" }, { status: 502 });
}

export function createTaskRoutes(deps: TaskRouteDeps): Hono<TaskEnv> {
  const router = new Hono<TaskEnv>();
  const limiter = rateLimit({ ...TASK_RATE_LIMIT, scope: "tasks" });

  router.use(
    "*",
    (c, next) => requireAuth(c.env.SESSION_SECRET)(c, next),
    limiter,
  );

  router.get("/tasks", async (c) => {
    let synced: TaskCard[];

    try {
      synced = await deps.hermes.listTasks();
    } catch (error) {
      const failure = hermesFailure(error);
      if (failure !== null) return failure;
      throw error;
    }

    for (const task of synced) {
      await upsertTask(deps.db, hermesFields(task));
    }

    // Prune after a successful refresh only: a failed Hermes read must leave
    // the mirror intact, but a successful one defines exactly which cards exist.
    await pruneTasks(
      deps.db,
      synced.map((task) => task.id),
    );

    // Keep every status Hermes has ever reported. A board that later drops a
    // column must still accept transitions to it instead of treating it as a
    // local-only label.
    await recordTaskStatuses(
      deps.db,
      synced.map((task) => task.status),
    );

    return c.json({ tasks: await listTasks(deps.db) });
  });

  router.post("/tasks", async (c) => {
    const body = await c.req
      .json<{ title?: unknown; ownerAgentId?: unknown }>()
      .catch(() => null);

    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (title.length === 0) {
      return c.json({ error: "invalid_request" }, 400);
    }

    let ownerAgentId: string | null = null;
    if (body?.ownerAgentId !== undefined && body.ownerAgentId !== null) {
      if (
        typeof body.ownerAgentId !== "string" ||
        body.ownerAgentId.trim().length === 0
      ) {
        return c.json({ error: "invalid_request" }, 400);
      }
      ownerAgentId = body.ownerAgentId.trim();
    }

    let card: TaskCard;
    try {
      card = await deps.hermes.createTask(title, ownerAgentId);
    } catch (error) {
      const failure = hermesFailure(error);
      if (failure !== null) return failure;
      throw error;
    }

    await upsertTask(deps.db, hermesFields(card));
    await writeAudit(deps.db, {
      userId: c.get("userId"),
      action: "task.create",
      detail: JSON.stringify({
        taskId: card.id,
        title: card.title,
        owner: card.owner,
      }),
    });
    await notify(deps.broadcast, {
      type: "event",
      payload: { text: `Task dibuat: ${card.title}`, ts: Date.now() },
    });

    return c.json({ task: await readTask(deps.db, card.id) }, 201);
  });

  router.post("/tasks/:id/status", async (c) => {
    const body = await c.req
      .json<{ status?: unknown }>()
      .catch(() => null);

    const status = typeof body?.status === "string" ? body.status.trim() : "";
    if (status.length === 0) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const id = c.req.param("id");

    // One upstream read plus the persisted history decide whether the status
    // is one Hermes actually uses. Unknown values are local-only labels and
    // must never reach Hermes.
    let synced: TaskCard[];
    try {
      synced = await deps.hermes.listTasks();
    } catch (error) {
      const failure = hermesFailure(error);
      if (failure !== null) return failure;
      throw error;
    }

    const known = new Set([
      ...synced.map((task) => task.status),
      ...(await listKnownTaskStatuses(deps.db)),
    ]);

    if (known.has(status)) {
      let card: TaskCard;
      try {
        card = await deps.hermes.updateTaskStatus(id, status);
      } catch (error) {
        const failure = hermesFailure(error);
        if (failure !== null) return failure;
        throw error;
      }

      await upsertTask(deps.db, hermesFields(card));
      // A real Hermes status supersedes any local-only label.
      await clearTaskLabel(deps.db, card.id);
      await writeAudit(deps.db, {
        userId: c.get("userId"),
        action: "task.status",
        detail: JSON.stringify({ taskId: id, status }),
      });
      await notify(deps.broadcast, {
        type: "event",
        payload: { text: `Status ${card.status}: ${card.title}`, ts: Date.now() },
      });

      return c.json({ task: await readTask(deps.db, card.id) });
    }

    const local = await readTask(deps.db, id);
    if (local === null) {
      return c.json({ error: "not_found" }, 404);
    }

    await upsertTask(deps.db, {
      ...hermesFields({
        id: local.id,
        title: local.title ?? "",
        status: local.status ?? "",
        owner: local.owner_agent,
      }),
      office_label: status,
    });
    await writeAudit(deps.db, {
      userId: c.get("userId"),
      action: "task.label",
      detail: JSON.stringify({ taskId: id, label: status }),
    });
    await notify(deps.broadcast, {
      type: "event",
      payload: {
        text: `Label "${status}" untuk ${local.title ?? id}`,
        ts: Date.now(),
      },
    });

    return c.json({ task: await readTask(deps.db, id) });
  });

  return router;
}
