import { Hono } from "hono";
import {
  requireAuth,
  type AuthBindings,
  type AuthVariables,
} from "./auth";
import { notify, type Broadcast } from "./broadcast";
import {
  listAgents,
  listTasks,
  setAgentDesk,
  upsertAgent,
  type AgentRow,
} from "./db";
import type { Duty } from "./duty";
import { HermesError, type AgentSummary } from "./hermes";
import { rateLimit } from "./ratelimit";

export const DESK_COUNT = 6;
export const AGENT_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

/**
 * The slice of HermesClient the agent routes need. Tests inject an in-memory
 * implementation because workerd cannot reach the node:http mock server.
 */
export interface HermesAgentApi {
  listAgents(): Promise<AgentSummary[]>;
  sendMessage(
    agentId: string,
    text: string,
  ): Promise<{ reply: string; sessionId: string }>;
}

export interface AgentRouteDeps {
  hermes: HermesAgentApi;
  db: D1Database;
  broadcast?: Broadcast;
}

export interface AgentView {
  id: string;
  name: string;
  role: string;
  color: string | null;
  desk: number | null;
  status: Duty;
}

type AgentEnv = { Bindings: AuthBindings; Variables: AuthVariables };

const DUTIES: ReadonlySet<string> = new Set<Duty>([
  "meeting",
  "a2a",
  "desk",
  "review",
  "idle",
]);

function normalizeDuty(status: unknown): Duty {
  return typeof status === "string" && DUTIES.has(status)
    ? (status as Duty)
    : "idle";
}

/** Reserve the smallest free desk (0..DESK_COUNT-1), or null for hotdesk. */
function takeFreeDesk(occupied: Set<number>): number | null {
  for (let desk = 0; desk < DESK_COUNT; desk += 1) {
    if (!occupied.has(desk)) {
      occupied.add(desk);
      return desk;
    }
  }
  return null;
}

function hermesFailure(error: unknown): Response | null {
  if (!(error instanceof HermesError)) return null;

  return Response.json({ error: "hermes_unavailable" }, { status: 502 });
}

export function createAgentRoutes(deps: AgentRouteDeps): Hono<AgentEnv> {
  const router = new Hono<AgentEnv>();
  const limiter = rateLimit(AGENT_RATE_LIMIT);

  router.use(
    "*",
    (c, next) => requireAuth(c.env.SESSION_SECRET)(c, next),
    limiter,
  );

  router.get("/agents", async (c) => {
    let synced: AgentSummary[];
    let local: AgentRow[];

    try {
      [synced, local] = await Promise.all([
        deps.hermes.listAgents(),
        listAgents(deps.db),
      ]);
    } catch (error) {
      const failure = hermesFailure(error);
      if (failure !== null) return failure;
      throw error;
    }

    const syncedIds = new Set(synced.map((agent) => agent.id));

    // Hermes is the source of truth for which agents exist. Free desks held by
    // local agents that disappeared, otherwise a new agent would skip a desk
    // that is visibly empty. upsertAgent cannot do this: its COALESCE keeps
    // the previous desk when the incoming value is null.
    for (const row of local) {
      if (row.desk_index !== null && !syncedIds.has(row.id)) {
        await setAgentDesk(deps.db, row.id, null);
      }
    }

    // Occupancy only counts agents that Hermes still reports.
    const byId = new Map(
      local
        .filter((row) => syncedIds.has(row.id))
        .map((row) => [row.id, row]),
    );
    const occupied = new Set<number>();
    for (const row of byId.values()) {
      if (row.desk_index !== null) occupied.add(row.desk_index);
    }

    for (const agent of synced) {
      const existing = byId.get(agent.id);
      const desk = existing?.desk_index ?? takeFreeDesk(occupied);

      await upsertAgent(deps.db, {
        id: agent.id,
        name: agent.name,
        role: agent.role,
      });

      if (existing?.desk_index !== desk) {
        await setAgentDesk(deps.db, agent.id, desk);
      }

      byId.set(agent.id, {
        id: agent.id,
        machine_id: existing?.machine_id ?? "main",
        name: agent.name,
        role: agent.role,
        color: existing?.color ?? null,
        desk_index: desk,
      });
    }

    const agents: AgentView[] = synced.map((agent) => {
      const row = byId.get(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        color: row?.color ?? null,
        desk: row?.desk_index ?? null,
        status: normalizeDuty(agent.status),
      };
    });

    await notify(deps.broadcast, {
      type: "snapshot",
      payload: {
        agents: agents.map((agent) => ({ id: agent.id, duty: agent.status })),
        tasks: await listTasks(deps.db),
      },
    });

    return c.json({ agents });
  });

  router.post("/agents/:id/messages", async (c) => {
    const body = await c.req
      .json<{ text?: unknown }>()
      .catch(() => null);

    if (
      body === null ||
      typeof body.text !== "string" ||
      body.text.trim().length === 0
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }

    try {
      const result = await deps.hermes.sendMessage(
        c.req.param("id"),
        body.text,
      );
      return c.json(result);
    } catch (error) {
      const failure = hermesFailure(error);
      if (failure !== null) return failure;
      throw error;
    }
  });

  return router;
}
