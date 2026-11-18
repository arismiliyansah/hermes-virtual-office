import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  csrfProtection,
  startSession,
  type AuthVariables,
  type StartedSession,
} from "../src/auth";
import { upsertAgent } from "../src/db";
import type { Env } from "../src/env";
import type { AgentSummary, CronJob, TaskCard } from "../src/hermes";
import worker from "../src/index";
import type { ServerMsg } from "../src/protocol";
import { __resetRateLimit } from "../src/ratelimit";
import {
  createAgentRoutes,
  type HermesAgentApi,
} from "../src/routes-agents";
import { createCronRoutes, type HermesCronApi } from "../src/routes-cron";
import {
  createMeetingRoutes,
  type HermesMeetingApi,
} from "../src/routes-meetings";
import { createTaskRoutes, type HermesTaskApi } from "../src/routes-tasks";
import { withStubbedFetch } from "./helpers";
import { applyAllMigrations } from "./migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const SECRET = "dev-secret";

type TestEnv = {
  Bindings: { SESSION_SECRET: string };
  Variables: AuthVariables;
};


beforeAll(async () => {
  await applyAllMigrations(db);
});

let session: StartedSession;

beforeEach(async () => {
  __resetRateLimit();
  await db.prepare("DELETE FROM minutes").run();
  await db.prepare("DELETE FROM meetings").run();
  await db.prepare("DELETE FROM agents").run();
  await db.prepare("DELETE FROM tasks").run();
  await db.prepare("DELETE FROM task_statuses").run();
  await db.prepare("DELETE FROM audit").run();
  session = await startSession("owner-1", SECRET);
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${session.token}`,
    "x-csrf-token": session.csrf,
    ...extra,
  };
}

const bindings = { SESSION_SECRET: SECRET };

interface Capture {
  messages: ServerMsg[];
  broadcast: (message: ServerMsg) => Promise<void>;
}

function capture(): Capture {
  const messages: ServerMsg[] = [];
  return {
    messages,
    async broadcast(message) {
      messages.push(message);
    },
  };
}

function agent(index: number, overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: `agent-${index}`,
    name: `Agent ${index}`,
    role: "engineer",
    status: "idle",
    ...overrides,
  };
}

function hermesAgents(agents: AgentSummary[]): HermesAgentApi {
  return {
    async listAgents() {
      return agents;
    },
    async sendMessage(id, text) {
      return { reply: `echo:${id}:${text}`, sessionId: `session-${id}` };
    },
  };
}

function task(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    owner: null,
    ...overrides,
  };
}

function hermesTasks(tasks: TaskCard[]): HermesTaskApi {
  return {
    async listTasks() {
      return tasks.map((item) => ({ ...item }));
    },
    async createTask(title, ownerAgentId) {
      const card = task(`task-${tasks.length + 1}`, {
        title,
        owner: ownerAgentId,
      });
      tasks.push(card);
      return { ...card };
    },
    async updateTaskStatus(id, status) {
      const card = tasks.find((item) => item.id === id);
      if (card === undefined) throw new Error(`unknown task ${id}`);
      card.status = status;
      return { ...card };
    },
  };
}

function cron(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: `Cron ${id}`,
    schedule: "*/5 * * * *",
    enabled: true,
    agentId: "agent-1",
    ...overrides,
  };
}

function hermesCrons(crons: CronJob[]): HermesCronApi {
  return {
    async listCrons() {
      return crons.map((item) => ({ ...item }));
    },
    async setCronEnabled(id, enabled) {
      const job = crons.find((item) => item.id === id);
      if (job === undefined) throw new Error(`unknown cron ${id}`);
      job.enabled = enabled;
      return { ...job };
    },
    async runCron(id) {
      return { runId: `run-${id}` };
    },
  };
}

function hermesMeetings(): HermesMeetingApi {
  return {
    async sendMessage(agentId, text) {
      if (text.includes("notulen")) {
        return { reply: "Notulen rapat", sessionId: "s3" };
      }
      return { reply: `Pendapat ${agentId}`, sessionId: `s-${agentId}` };
    },
  };
}

function agentRoutesApi(broadcast: Capture["broadcast"]): Hono<TestEnv> {
  const mounted = new Hono<TestEnv>();
  mounted.use("/api/*", csrfProtection());
  mounted.route(
    "/api",
    createAgentRoutes({
      hermes: hermesAgents([
        agent(1, { status: "desk" }),
        agent(2, { status: "meeting" }),
      ]),
      db,
      broadcast,
    }),
  );
  return mounted;
}

function taskRoutesApi(broadcast: Capture["broadcast"]): Hono<TestEnv> {
  const mounted = new Hono<TestEnv>();
  mounted.use("/api/*", csrfProtection());
  mounted.route(
    "/api",
    createTaskRoutes({
      hermes: hermesTasks([
        task("task-1", { title: "Audit tunnel", status: "done" }),
      ]),
      db,
      broadcast,
    }),
  );
  return mounted;
}

function cronRoutesApi(broadcast: Capture["broadcast"]): Hono<TestEnv> {
  const mounted = new Hono<TestEnv>();
  mounted.use("/api/*", csrfProtection());
  mounted.route(
    "/api",
    createCronRoutes({
      hermes: hermesCrons([cron("nightly")]),
      db,
      broadcast,
    }),
  );
  return mounted;
}

function meetingRoutesApi(broadcast: Capture["broadcast"]): Hono<TestEnv> {
  const mounted = new Hono<TestEnv>();
  mounted.use("/api/*", csrfProtection());
  mounted.route(
    "/api",
    createMeetingRoutes({
      hermes: hermesMeetings(),
      db,
      broadcast,
    }),
  );
  return mounted;
}

async function post(
  app: Hono<TestEnv>,
  path: string,
  payload?: unknown,
): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
    bindings,
  );
}

describe("producer broadcasts", () => {
  it("(e) publishes a snapshot with agent duties after an agents sync", async () => {
    const events = capture();

    const res = await agentRoutesApi(events.broadcast).request(
      "/api/agents",
      { headers: authHeaders() },
      bindings,
    );

    expect(res.status).toBe(200);
    const snapshot = events.messages.find((msg) => msg.type === "snapshot");
    expect(snapshot).toBeDefined();
    if (snapshot?.type !== "snapshot") throw new Error("expected snapshot");
    expect(snapshot.payload.agents).toEqual([
      { id: "agent-1", duty: "desk" },
      { id: "agent-2", duty: "meeting" },
    ]);
    expect(Array.isArray(snapshot.payload.tasks)).toBe(true);
  });

  it("(e) publishes events for task creation and status changes", async () => {
    const events = capture();
    const app = taskRoutesApi(events.broadcast);

    expect(
      (await post(app, "/api/tasks", { title: "Tulis notulen" })).status,
    ).toBe(201);
    expect(
      (await post(app, "/api/tasks/task-1/status", { status: "done" })).status,
    ).toBe(200);

    const texts = events.messages
      .filter((msg) => msg.type === "event")
      .map((msg) => (msg.type === "event" ? msg.payload.text : ""));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/task dibuat/i);
    expect(texts[0]).toContain("Tulis notulen");
    expect(texts[1]).toMatch(/status/i);
    expect(texts[1]).toContain("done");
  });

  it("publishes every meeting turn and a closing event", async () => {
    await upsertAgent(db, { id: "agent-1", name: "Ana", role: "Engineer" });
    await upsertAgent(db, { id: "agent-2", name: "Budi", role: "Manager" });
    const events = capture();

    const res = await post(meetingRoutesApi(events.broadcast), "/api/meetings", {
      title: "Rapat rilis",
      participantIds: ["agent-1", "agent-2"],
    });

    expect(res.status).toBe(201);
    const turns = events.messages.filter((msg) => msg.type === "meeting_turn");
    expect(turns).toEqual([
      {
        type: "meeting_turn",
        payload: { agentId: "agent-1", text: "Pendapat agent-1" },
      },
      {
        type: "meeting_turn",
        payload: { agentId: "agent-2", text: "Pendapat agent-2" },
      },
    ]);
    expect(events.messages.at(-1)).toMatchObject({
      type: "event",
      payload: { text: expect.stringContaining("Rapat selesai") },
    });
  });

  it("publishes events for cron toggles and runs", async () => {
    const events = capture();
    const app = cronRoutesApi(events.broadcast);

    expect(
      (await post(app, "/api/cron/nightly/toggle", { enabled: false })).status,
    ).toBe(200);
    expect((await post(app, "/api/cron/nightly/run")).status).toBe(200);

    const texts = events.messages
      .filter((msg) => msg.type === "event")
      .map((msg) => (msg.type === "event" ? msg.payload.text : ""));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/cron/i);
    expect(texts[0]).toMatch(/nonaktif|dimatikan/i);
    expect(texts[1]).toMatch(/cron/i);
    expect(texts[1]).toMatch(/dijalankan|run/i);
  });

  it("keeps the request successful when the broadcaster throws", async () => {
    const failing = async (): Promise<void> => {
      throw new Error("hub down");
    };

    const agents = await agentRoutesApi(failing).request(
      "/api/agents",
      { headers: authHeaders() },
      bindings,
    );
    expect(agents.status).toBe(200);

    const created = await post(taskRoutesApi(failing), "/api/tasks", {
      title: "Tetap tersimpan",
    });
    expect(created.status).toBe(201);
  });
});

describe("production mount wiring", () => {
  const productionBindings = {
    DB: db,
    SESSION_SECRET: SECRET,
    HERMES_ORIGIN: "https://hermes.mount.test",
    HERMES_HMAC_SECRET: "mount-secret",
  } as unknown as Env;

  it("posts hub broadcasts from the default Worker app", async () => {
    const sent: ServerMsg[] = [];
    const stub = {
      async fetch(_url: string, init?: RequestInit): Promise<Response> {
        sent.push(JSON.parse(String(init?.body)) as ServerMsg);
        return new Response(null, { status: 204 });
      },
    };
    const hub = {
      idFromName: (name: string) => name,
      get: () => stub,
    };

    await withStubbedFetch(
      async () => Response.json([agent(1, { status: "desk" })]),
      async () => {
        const res = await worker.request(
          "https://office.test/api/agents",
          { headers: { cookie: `${SESSION_COOKIE}=${session.token}` } },
          { ...productionBindings, OFFICE_HUB: hub } as unknown as Env,
        );
        expect(res.status).toBe(200);
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("snapshot");
  });

  it("survives a hub broadcast failure in the default Worker app", async () => {
    const hub = {
      idFromName: () => "main",
      get: () => ({
        async fetch(): Promise<Response> {
          throw new Error("hub unavailable");
        },
      }),
    };

    await withStubbedFetch(
      async () => Response.json([agent(1)]),
      async () => {
        const res = await worker.request(
          "https://office.test/api/agents",
          { headers: { cookie: `${SESSION_COOKIE}=${session.token}` } },
          { ...productionBindings, OFFICE_HUB: hub } as unknown as Env,
        );
        expect(res.status).toBe(200);
      },
    );
  });
});
