import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  csrfProtection,
  requireAuth,
  startSession,
  type AuthVariables,
  type StartedSession,
} from "../src/auth";
import {
  listKnownTaskStatuses,
  listTasks,
  upsertTask,
  type AuditRow,
  type TaskRow,
} from "../src/db";
import type { Env } from "../src/env";
import { HermesError, type TaskCard } from "../src/hermes";
import worker from "../src/index";
import { __resetRateLimit, rateLimit } from "../src/ratelimit";
import {
  createTaskRoutes,
  TASK_RATE_LIMIT,
  type HermesTaskApi,
} from "../src/routes-tasks";
import { withStubbedFetch } from "./helpers";
import { applyAllMigrations } from "./migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const SECRET = "dev-secret";
// The deploy guard rejects "dev-secret" outside localhost; production mounts
// exercise a realistic secret.
const PRODUCTION_SECRET = "production-session-secret";
const USER_ID = "owner-1";

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
  await db.prepare("DELETE FROM tasks").run();
  await db.prepare("DELETE FROM task_statuses").run();
  // Migration 0003 seeds the canonical board columns; restore it because the
  // tests need a clean slate between cases.
  await db
    .prepare(
      "INSERT INTO task_statuses (status) VALUES ('todo'), ('doing'), ('review'), ('done')",
    )
    .run();
  await db.prepare("DELETE FROM audit").run();
  session = await startSession(USER_ID, SECRET);
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${session.token}`,
    "x-csrf-token": session.csrf,
    ...extra,
  };
}

type HermesCall =
  | { kind: "list" }
  | { kind: "create"; title: string; ownerAgentId: string | null }
  | { kind: "status"; id: string; status: string };

interface StubState {
  tasks: TaskCard[];
  calls: HermesCall[];
  nextId: number;
}

function stubHermes(initial: TaskCard[] = []): {
  hermes: HermesTaskApi;
  state: StubState;
} {
  const state: StubState = {
    tasks: initial.map((task) => ({ ...task })),
    calls: [],
    nextId: initial.length + 1,
  };

  const hermes: HermesTaskApi = {
    async listTasks() {
      state.calls.push({ kind: "list" });
      return state.tasks.map((task) => ({ ...task }));
    },
    async createTask(title, ownerAgentId) {
      state.calls.push({ kind: "create", title, ownerAgentId });
      const card: TaskCard = {
        id: `task-${state.nextId}`,
        title,
        status: "todo",
        owner: ownerAgentId,
      };
      state.nextId += 1;
      state.tasks.push(card);
      return { ...card };
    },
    async updateTaskStatus(id, status) {
      state.calls.push({ kind: "status", id, status });
      const task = state.tasks.find((item) => item.id === id);
      if (task === undefined) {
        throw new HermesError("bad_response", `unknown task ${id}`);
      }
      task.status = status;
      return { ...task };
    },
  };

  return { hermes, state };
}

function appFor(hermes: HermesTaskApi): Hono<TestEnv> {
  const app = new Hono<TestEnv>();
  app.use("/api/*", csrfProtection());
  app.route("/api", createTaskRoutes({ hermes, db }));
  return app;
}

const bindings = { SESSION_SECRET: SECRET };

async function getTasks(
  app: Hono<TestEnv>,
  headers = authHeaders(),
): Promise<Response> {
  return app.request("/api/tasks", { headers }, bindings);
}

async function createTask(
  app: Hono<TestEnv>,
  payload: unknown,
  headers = authHeaders({ "content-type": "application/json" }),
): Promise<Response> {
  return app.request(
    "/api/tasks",
    { method: "POST", headers, body: JSON.stringify(payload) },
    bindings,
  );
}

async function setStatus(
  app: Hono<TestEnv>,
  id: string,
  payload: unknown,
  headers = authHeaders({ "content-type": "application/json" }),
): Promise<Response> {
  return app.request(
    `/api/tasks/${id}/status`,
    { method: "POST", headers, body: JSON.stringify(payload) },
    bindings,
  );
}

async function auditRows(): Promise<AuditRow[]> {
  const { results } = await db
    .prepare("SELECT id, user_id, action, detail, created_at FROM audit ORDER BY id")
    .all<AuditRow>();
  return results;
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

describe("GET /api/tasks", () => {
  it("(a) refreshes from Hermes and overwrites a local status change (Hermes wins)", async () => {
    await upsertTask(db, {
      id: "task-1",
      title: "Locally renamed",
      status: "done",
      office_label: "Review",
      owner_agent: "agent-local",
    });

    const { hermes, state } = stubHermes([
      task("task-1", {
        title: "Hermes title",
        status: "todo",
        owner: "agent-hermes",
      }),
    ]);

    const res = await getTasks(appFor(hermes));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: TaskRow[] };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({
      id: "task-1",
      title: "Hermes title",
      status: "todo",
      owner_agent: "agent-hermes",
      office_label: "Review",
    });
    expect(state.calls).toEqual([{ kind: "list" }]);
  });

  it("inserts tasks that only exist in Hermes", async () => {
    const { hermes } = stubHermes([
      task("task-1", { status: "doing" }),
      task("task-2", { status: "done", owner: "agent-2" }),
    ]);

    const res = await getTasks(appFor(hermes));

    expect(res.status).toBe(200);
    const rows = await listTasks(db);
    expect(rows.map((row) => [row.id, row.status, row.owner_agent])).toEqual([
      ["task-1", "doing", null],
      ["task-2", "done", "agent-2"],
    ]);
  });

  it("prunes mirror rows that disappeared from Hermes", async () => {
    await upsertTask(db, {
      id: "task-ghost",
      title: "Dihapus di Hermes",
      status: "todo",
      owner_agent: null,
    });
    await upsertTask(db, {
      id: "task-keep",
      title: "Masih ada",
      status: "doing",
      owner_agent: null,
    });

    const { hermes } = stubHermes([task("task-keep", { status: "doing" })]);
    const res = await getTasks(appFor(hermes));

    expect(res.status).toBe(200);
    expect((await listTasks(db)).map((row) => row.id)).toEqual(["task-keep"]);
  });

  it("maps Hermes failures to 502 and leaves the mirror untouched", async () => {
    await upsertTask(db, {
      id: "task-1",
      title: "Mirror",
      status: "todo",
      owner_agent: null,
    });

    const failing: HermesTaskApi = {
      async listTasks() {
        throw new HermesError("unreachable", "tunnel down");
      },
      async createTask() {
        throw new HermesError("unreachable", "tunnel down");
      },
      async updateTaskStatus() {
        throw new HermesError("unreachable", "tunnel down");
      },
    };

    const res = await getTasks(appFor(failing));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "hermes_unavailable" });
    expect((await listTasks(db))[0]).toMatchObject({ id: "task-1", status: "todo" });
  });
});

describe("POST /api/tasks", () => {
  it("(d) creates the task in Hermes and mirrors it in D1", async () => {
    const { hermes, state } = stubHermes();

    const res = await createTask(appFor(hermes), {
      title: "Ship v1",
      ownerAgentId: "agent-2",
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: TaskRow };
    expect(body.task).toMatchObject({
      id: "task-1",
      title: "Ship v1",
      status: "todo",
      owner_agent: "agent-2",
      office_label: null,
    });
    expect(state.calls).toEqual([
      { kind: "create", title: "Ship v1", ownerAgentId: "agent-2" },
    ]);

    const rows = await listTasks(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "task-1",
      title: "Ship v1",
      status: "todo",
      owner_agent: "agent-2",
    });
  });

  it("passes null when ownerAgentId is omitted", async () => {
    const { hermes, state } = stubHermes();

    const res = await createTask(appFor(hermes), { title: "Unassigned" });

    expect(res.status).toBe(201);
    expect(state.calls).toEqual([
      { kind: "create", title: "Unassigned", ownerAgentId: null },
    ]);
  });

  it("rejects an empty title without calling Hermes", async () => {
    const { hermes, state } = stubHermes();
    const app = appFor(hermes);

    for (const payload of [{}, { title: "   " }, { title: 42 }]) {
      const res = await createTask(app, payload);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect(state.calls).toEqual([]);
    expect(await listTasks(db)).toEqual([]);
  });
});

describe("POST /api/tasks/:id/status", () => {
  it("(a) moves a card to Done on a fresh board that has no Done card yet", async () => {
    const { hermes, state } = stubHermes([
      task("task-1", { status: "review" }),
      task("task-2", { status: "todo" }),
    ]);
    const app = appFor(hermes);

    expect((await getTasks(app)).status).toBe(200);
    expect(
      (await listTasks(db)).some((row) => row.status === "done"),
    ).toBe(false);

    // Migration 0003 seeds the canonical statuses, so "done" is known even
    // though no card currently carries it.
    expect(await listKnownTaskStatuses(db)).toContain("done");

    const res = await setStatus(app, "task-1", { status: "done" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: TaskRow };
    expect(body.task).toMatchObject({ id: "task-1", status: "done" });
    expect(state.calls).toContainEqual({
      kind: "status",
      id: "task-1",
      status: "done",
    });
  });

  it("(a) keeps a status known after its card leaves the current Hermes board", async () => {
    const { hermes, state } = stubHermes([
      task("task-1"),
      task("task-2", { status: "done" }),
    ]);
    const app = appFor(hermes);

    expect((await getTasks(app)).status).toBe(200);
    expect(await listKnownTaskStatuses(db)).toEqual([
      "doing",
      "done",
      "review",
      "todo",
    ]);

    // The done card disappears; subsequent boards no longer contain "done".
    state.tasks = [task("task-1")];

    const res = await setStatus(app, "task-1", { status: "done" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: TaskRow };
    expect(body.task).toMatchObject({
      id: "task-1",
      status: "done",
      office_label: null,
    });
    expect(state.calls).toEqual([
      { kind: "list" },
      { kind: "list" },
      { kind: "status", id: "task-1", status: "done" },
    ]);
  });

  it("(b) stores an unknown status as office_label and does not call updateTaskStatus", async () => {
    await upsertTask(db, {
      id: "task-1",
      title: "Fix the tunnel",
      status: "todo",
      owner_agent: "agent-1",
    });

    const { hermes, state } = stubHermes([task("task-1")]);

    const res = await setStatus(appFor(hermes), "task-1", {
      status: "waiting-for-qa",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: TaskRow };
    expect(body.task).toMatchObject({
      id: "task-1",
      title: "Fix the tunnel",
      status: "todo",
      office_label: "waiting-for-qa",
      owner_agent: "agent-1",
    });
    expect(state.calls).toEqual([{ kind: "list" }]);

    const row = (await listTasks(db)).find((item) => item.id === "task-1");
    expect(row).toMatchObject({
      status: "todo",
      office_label: "waiting-for-qa",
    });
    expect(await listKnownTaskStatuses(db)).toEqual([
      "doing",
      "done",
      "review",
      "todo",
    ]);
  });

  it("(c) forwards a known status to Hermes and refreshes the mirror", async () => {
    await upsertTask(db, {
      id: "task-1",
      title: "Fix the tunnel",
      status: "todo",
      office_label: "Amber",
      owner_agent: "agent-1",
    });

    const { hermes, state } = stubHermes([
      task("task-1"),
      task("task-2", { status: "done", owner: "agent-2" }),
    ]);

    const res = await setStatus(appFor(hermes), "task-1", { status: "done" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: TaskRow };
    expect(body.task).toMatchObject({
      id: "task-1",
      status: "done",
      office_label: null,
    });
    expect(state.calls).toEqual([
      { kind: "list" },
      { kind: "status", id: "task-1", status: "done" },
    ]);

    const row = (await listTasks(db)).find((item) => item.id === "task-1");
    expect(row).toMatchObject({ status: "done", office_label: null });
  });

  it("returns 404 for an unknown label on a task missing from D1", async () => {
    const { hermes, state } = stubHermes([task("task-1")]);

    const res = await setStatus(appFor(hermes), "task-missing", {
      status: "waiting",
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(state.calls).toEqual([{ kind: "list" }]);
    expect(await auditRows()).toEqual([]);
  });

  it("rejects an empty status without contacting Hermes", async () => {
    const { hermes, state } = stubHermes([task("task-1")]);
    const app = appFor(hermes);

    for (const payload of [{}, { status: "  " }, { status: 7 }]) {
      const res = await setStatus(app, "task-1", payload);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect(state.calls).toEqual([]);
  });
});

describe("audit", () => {
  it("(e) records task.create, task.status and task.label for each mutation", async () => {
    const { hermes } = stubHermes([task("task-1", { status: "done" })]);
    const app = appFor(hermes);

    expect(
      (await createTask(app, { title: "Audited task", ownerAgentId: "agent-1" }))
        .status,
    ).toBe(201);
    expect((await setStatus(app, "task-1", { status: "done" })).status).toBe(200);
    expect((await setStatus(app, "task-1", { status: "blocked" })).status).toBe(200);

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual([
      "task.create",
      "task.status",
      "task.label",
    ]);
    expect(rows.map((row) => row.user_id)).toEqual([USER_ID, USER_ID, USER_ID]);

    expect(JSON.parse(rows[0].detail ?? "{}")).toMatchObject({
      taskId: "task-2",
      title: "Audited task",
      owner: "agent-1",
    });
    expect(JSON.parse(rows[1].detail ?? "{}")).toEqual({
      taskId: "task-1",
      status: "done",
    });
    expect(JSON.parse(rows[2].detail ?? "{}")).toEqual({
      taskId: "task-1",
      label: "blocked",
    });
  });
});

describe("auth, CSRF and rate limiting", () => {
  it("rejects a request without a session with 401", async () => {
    const { hermes } = stubHermes([task("task-1")]);
    const res = await appFor(hermes).request("/api/tasks", {}, bindings);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a mutation without x-csrf-token with 403", async () => {
    const { hermes } = stubHermes([task("task-1")]);
    const res = await createTask(
      appFor(hermes),
      { title: "No csrf" },
      { cookie: `${SESSION_COOKIE}=${session.token}`, "content-type": "application/json" },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf" });
  });

  it("rate limits task requests", async () => {
    const { hermes } = stubHermes([task("task-1")]);
    const app = appFor(hermes);

    for (let i = 0; i < TASK_RATE_LIMIT.limit; i += 1) {
      expect((await getTasks(app)).status).toBe(200);
    }

    const limited = await getTasks(app);

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("scopes fixed windows to the route family as well as limit and window", async () => {
    const app = new Hono<TestEnv>();
    app.get(
      "/api/agents-family",
      (c, next) => requireAuth(SECRET)(c, next),
      rateLimit({ limit: 1, windowMs: 60_000, scope: "agents" }),
      (c) => c.json({ ok: "agents" }),
    );
    app.get(
      "/api/tasks-family",
      (c, next) => requireAuth(SECRET)(c, next),
      rateLimit({ limit: 1, windowMs: 60_000, scope: "tasks" }),
      (c) => c.json({ ok: "tasks" }),
    );

    const first = await app.request(
      "/api/agents-family",
      { headers: authHeaders() },
      bindings,
    );
    const second = await app.request(
      "/api/agents-family",
      { headers: authHeaders() },
      bindings,
    );
    const otherFamily = await app.request(
      "/api/tasks-family",
      { headers: authHeaders() },
      bindings,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(otherFamily.status).toBe(200);
  });

  it("scopes fixed windows to the limit and window configuration", async () => {
    const app = new Hono<TestEnv>();
    app.get(
      "/api/short",
      (c, next) => requireAuth(SECRET)(c, next),
      rateLimit({ limit: 1, windowMs: 60_000 }),
      (c) => c.json({ ok: "short" }),
    );
    app.get(
      "/api/long",
      (c, next) => requireAuth(SECRET)(c, next),
      rateLimit({ limit: 1, windowMs: 120_000 }),
      (c) => c.json({ ok: "long" }),
    );

    expect((await app.request("/api/short", { headers: authHeaders() }, bindings)).status).toBe(200);
    expect((await app.request("/api/short", { headers: authHeaders() }, bindings)).status).toBe(429);
    expect((await app.request("/api/long", { headers: authHeaders() }, bindings)).status).toBe(200);
  });
});

describe("production mount (default Worker app)", () => {
  const productionBindings = {
    DB: db,
    SESSION_SECRET: PRODUCTION_SECRET,
    HERMES_ORIGIN: "https://hermes.mount.test",
    HERMES_HMAC_SECRET: "mount-secret",
  } as unknown as Env;

  it("(f) rewrites /api/tasks and /api/tasks/:id/status to the router paths", async () => {
    const outbound: { method: string; path: string; body: string }[] = [];

    await withStubbedFetch(
      async (input, init) => {
        const method = init?.method ?? "GET";
        const path = new URL(String(input)).pathname;
        outbound.push({ method, path, body: String(init?.body ?? "") });

        if (method === "GET" && path === "/tasks") {
          return Response.json([task("task-1"), task("task-2", { status: "done" })]);
        }
        if (method === "POST" && path === "/tasks/task-1/status") {
          return Response.json(task("task-1", { status: "done" }));
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      async () => {
        const { token, csrf } = await startSession("mount-user", PRODUCTION_SECRET);

        const listed = await worker.request(
          "https://office.test/api/tasks",
          { headers: { cookie: `${SESSION_COOKIE}=${token}` } },
          productionBindings,
        );
        expect(listed.status).toBe(200);
        const mirror = (await listed.json()) as { tasks: TaskRow[] };
        expect(
          Object.fromEntries(mirror.tasks.map((row) => [row.id, row.status])),
        ).toEqual({ "task-1": "todo", "task-2": "done" });

        const updated = await worker.request(
          "https://office.test/api/tasks/task-1/status",
          {
            method: "POST",
            headers: {
              cookie: `${SESSION_COOKIE}=${token}`,
              "x-csrf-token": csrf,
              "content-type": "application/json",
            },
            body: JSON.stringify({ status: "done" }),
          },
          productionBindings,
        );
        expect(updated.status).toBe(200);
        expect(((await updated.json()) as { task: TaskRow }).task.status).toBe("done");
      },
    );

    expect(outbound).toEqual([
      { method: "GET", path: "/tasks", body: "" },
      { method: "GET", path: "/tasks", body: "" },
      { method: "POST", path: "/tasks/task-1/status", body: '{"status":"done"}' },
    ]);
  });
});
