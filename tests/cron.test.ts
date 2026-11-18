import { applyD1Migrations, env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Vite inlines ?raw imports; this project has no ambient declaration for them.
import initSql from "../migrations/0001_init.sql?raw";
// @ts-expect-error Vite inlines ?raw imports; this project has no ambient declaration for them.
import taskStatusesSql from "../migrations/0002_task_statuses.sql?raw";
import {
  SESSION_COOKIE,
  csrfProtection,
  startSession,
  type AuthVariables,
  type StartedSession,
} from "../src/auth";
import type { AuditRow } from "../src/db";
import type { Env } from "../src/env";
import { HermesError, type CronJob } from "../src/hermes";
import worker from "../src/index";
import { __resetRateLimit } from "../src/ratelimit";
import {
  createCronRoutes,
  CRON_RATE_LIMIT,
  type HermesCronApi,
} from "../src/routes-cron";
import { withStubbedFetch } from "./helpers";

const db = (env as unknown as { DB: D1Database }).DB;
const SECRET = "dev-secret";
const USER_ID = "owner-1";

type TestEnv = {
  Bindings: { SESSION_SECRET: string };
  Variables: AuthVariables;
};

function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((query) => query.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  await applyD1Migrations(db, [
    { name: "0001_init.sql", queries: splitSql(initSql) },
    { name: "0002_task_statuses.sql", queries: splitSql(taskStatusesSql) },
  ]);
});

let session: StartedSession;

beforeEach(async () => {
  __resetRateLimit();
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
  | { kind: "toggle"; id: string; enabled: boolean }
  | { kind: "run"; id: string };

interface StubState {
  crons: CronJob[];
  calls: HermesCall[];
}

function stubHermes(initial: CronJob[] = []): {
  hermes: HermesCronApi;
  state: StubState;
} {
  const state: StubState = {
    crons: initial.map((cron) => ({ ...cron })),
    calls: [],
  };

  const hermes: HermesCronApi = {
    async listCrons() {
      state.calls.push({ kind: "list" });
      return state.crons.map((cron) => ({ ...cron }));
    },
    async setCronEnabled(id, enabled) {
      state.calls.push({ kind: "toggle", id, enabled });
      const cron = state.crons.find((item) => item.id === id);
      if (cron === undefined) {
        throw new HermesError("bad_response", `unknown cron ${id}`);
      }
      cron.enabled = enabled;
      return { ...cron };
    },
    async runCron(id) {
      state.calls.push({ kind: "run", id });
      return { runId: `run-${id}` };
    },
  };

  return { hermes, state };
}

function appFor(hermes: HermesCronApi): Hono<TestEnv> {
  const app = new Hono<TestEnv>();
  app.use("/api/*", csrfProtection());
  app.route("/api", createCronRoutes({ hermes, db }));
  return app;
}

const bindings = { SESSION_SECRET: SECRET };

async function getCrons(
  app: Hono<TestEnv>,
  headers = authHeaders(),
): Promise<Response> {
  return app.request("/api/cron", { headers }, bindings);
}

async function toggle(
  app: Hono<TestEnv>,
  id: string,
  payload: unknown,
  headers = authHeaders({ "content-type": "application/json" }),
): Promise<Response> {
  return app.request(
    `/api/cron/${id}/toggle`,
    { method: "POST", headers, body: JSON.stringify(payload) },
    bindings,
  );
}

async function run(
  app: Hono<TestEnv>,
  id: string,
  headers = authHeaders({ "content-type": "application/json" }),
): Promise<Response> {
  return app.request(
    `/api/cron/${id}/run`,
    { method: "POST", headers },
    bindings,
  );
}

async function auditRows(): Promise<AuditRow[]> {
  const { results } = await db
    .prepare("SELECT id, user_id, action, detail, created_at FROM audit ORDER BY id")
    .all<AuditRow>();
  return results;
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

describe("GET /api/cron", () => {
  it("(a) maps the Hermes cron fixture", async () => {
    const fixture = [
      cron("nightly", { name: "Nightly digest", schedule: "0 2 * * *" }),
      cron("poller", { enabled: false, agentId: "agent-2" }),
    ];
    const { hermes, state } = stubHermes(fixture);

    const res = await getCrons(appFor(hermes));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ crons: fixture });
    expect(state.calls).toEqual([{ kind: "list" }]);
  });

  it("(d) maps a Hermes failure to 502", async () => {
    const failing: HermesCronApi = {
      async listCrons() {
        throw new HermesError("unreachable", "tunnel down");
      },
      async setCronEnabled() {
        throw new HermesError("unreachable", "tunnel down");
      },
      async runCron() {
        throw new HermesError("unreachable", "tunnel down");
      },
    };

    const res = await getCrons(appFor(failing));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "hermes_unavailable" });
  });

  it("(e) does not write an audit row for a read", async () => {
    const { hermes } = stubHermes([cron("nightly")]);

    expect((await getCrons(appFor(hermes))).status).toBe(200);

    expect(await auditRows()).toEqual([]);
  });
});

describe("POST /api/cron/:id/toggle", () => {
  it("(b) forwards the boolean to Hermes and returns the updated cron", async () => {
    const { hermes, state } = stubHermes([cron("nightly")]);
    const app = appFor(hermes);

    const disabled = await toggle(app, "nightly", { enabled: false });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({
      cron: cron("nightly", { enabled: false }),
    });

    const enabled = await toggle(app, "nightly", { enabled: true });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ cron: cron("nightly") });

    expect(state.calls).toEqual([
      { kind: "toggle", id: "nightly", enabled: false },
      { kind: "toggle", id: "nightly", enabled: true },
    ]);
  });

  it("rejects a non-boolean enabled value without contacting Hermes", async () => {
    const { hermes, state } = stubHermes([cron("nightly")]);
    const app = appFor(hermes);

    for (const payload of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }]) {
      const res = await toggle(app, "nightly", payload);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }

    expect(state.calls).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("(d) maps a Hermes failure to 502 and does not audit", async () => {
    const { hermes } = stubHermes([cron("nightly")]);
    hermes.setCronEnabled = async () => {
      throw new HermesError("bad_response", "upstream exploded");
    };

    const res = await toggle(appFor(hermes), "nightly", { enabled: true });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "hermes_unavailable" });
    expect(await auditRows()).toEqual([]);
  });
});

describe("POST /api/cron/:id/run", () => {
  it("(c) returns the runId from Hermes", async () => {
    const { hermes, state } = stubHermes([cron("nightly")]);

    const res = await run(appFor(hermes), "nightly");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run-nightly" });
    expect(state.calls).toEqual([{ kind: "run", id: "nightly" }]);
  });

  it("(d) maps a Hermes failure to 502 and does not audit", async () => {
    const { hermes } = stubHermes([cron("nightly")]);
    hermes.runCron = async () => {
      throw new HermesError("unreachable", "tunnel down");
    };

    const res = await run(appFor(hermes), "nightly");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "hermes_unavailable" });
    expect(await auditRows()).toEqual([]);
  });
});

describe("audit", () => {
  it("(e) records cron.toggle and cron.run for mutations only", async () => {
    const { hermes } = stubHermes([cron("nightly")]);
    const app = appFor(hermes);

    expect((await getCrons(app)).status).toBe(200);
    expect((await toggle(app, "nightly", { enabled: false })).status).toBe(200);
    expect((await toggle(app, "nightly", { enabled: "nope" })).status).toBe(400);
    expect((await run(app, "nightly")).status).toBe(200);

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(["cron.toggle", "cron.run"]);
    expect(rows.map((row) => row.user_id)).toEqual([USER_ID, USER_ID]);
    expect(JSON.parse(rows[0].detail ?? "{}")).toEqual({
      cronId: "nightly",
      enabled: false,
    });
    expect(JSON.parse(rows[1].detail ?? "{}")).toEqual({
      cronId: "nightly",
      runId: "run-nightly",
    });
  });
});

describe("auth, CSRF and rate limiting", () => {
  it("rejects a request without a session with 401", async () => {
    const { hermes } = stubHermes([cron("nightly")]);

    const res = await appFor(hermes).request("/api/cron", {}, bindings);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a mutation without x-csrf-token with 403", async () => {
    const { hermes } = stubHermes([cron("nightly")]);
    const res = await toggle(
      appFor(hermes),
      "nightly",
      { enabled: false },
      { cookie: `${SESSION_COOKIE}=${session.token}`, "content-type": "application/json" },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf" });
  });

  it("rate limits cron requests", async () => {
    const { hermes } = stubHermes([cron("nightly")]);
    const app = appFor(hermes);

    for (let i = 0; i < CRON_RATE_LIMIT.limit; i += 1) {
      expect((await getCrons(app)).status).toBe(200);
    }

    const limited = await getCrons(app);

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });
});

describe("production mount (default Worker app)", () => {
  const productionBindings = {
    DB: db,
    SESSION_SECRET: SECRET,
    HERMES_ORIGIN: "https://hermes.mount.test",
    HERMES_HMAC_SECRET: "mount-secret",
  } as unknown as Env;

  it("(f) rewrites /api/cron routes to the router paths", async () => {
    const outbound: { method: string; path: string; body: string }[] = [];

    await withStubbedFetch(
      async (input, init) => {
        const method = init?.method ?? "GET";
        const path = new URL(String(input)).pathname;
        outbound.push({ method, path, body: String(init?.body ?? "") });

        if (method === "GET" && path === "/crons") {
          return Response.json([cron("nightly")]);
        }
        if (method === "PATCH" && path === "/crons/nightly") {
          return Response.json(cron("nightly", { enabled: false }));
        }
        if (method === "POST" && path === "/crons/nightly/run") {
          return Response.json({ runId: "run-nightly" });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      async () => {
        const { token, csrf } = await startSession("mount-user", SECRET);
        const headers = {
          cookie: `${SESSION_COOKIE}=${token}`,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        };

        const listed = await worker.request(
          "https://office.test/api/cron",
          { headers },
          productionBindings,
        );
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual({ crons: [cron("nightly")] });

        const toggled = await worker.request(
          "https://office.test/api/cron/nightly/toggle",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ enabled: false }),
          },
          productionBindings,
        );
        expect(toggled.status).toBe(200);
        expect(await toggled.json()).toEqual({
          cron: cron("nightly", { enabled: false }),
        });

        const ran = await worker.request(
          "https://office.test/api/cron/nightly/run",
          { method: "POST", headers },
          productionBindings,
        );
        expect(ran.status).toBe(200);
        expect(await ran.json()).toEqual({ runId: "run-nightly" });
      },
    );

    expect(outbound).toEqual([
      { method: "GET", path: "/crons", body: "" },
      { method: "PATCH", path: "/crons/nightly", body: '{"enabled":false}' },
      { method: "POST", path: "/crons/nightly/run", body: "" },
    ]);
  });
});
