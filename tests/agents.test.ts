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
import { listAgents, upsertAgent } from "../src/db";
import type { Env } from "../src/env";
import { HermesError, type AgentSummary } from "../src/hermes";
import worker from "../src/index";
import { __resetRateLimit } from "../src/ratelimit";
import {
  createAgentRoutes,
  type AgentView,
  type HermesAgentApi,
} from "../src/routes-agents";
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
  await db.prepare("DELETE FROM agents").run();
  session = await startSession(USER_ID, SECRET);
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${session.token}`,
    "x-csrf-token": session.csrf,
    ...extra,
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

interface StubState {
  agents: AgentSummary[];
  calls: { agentId: string; text: string }[];
}

function stubHermes(initial: AgentSummary[]): {
  hermes: HermesAgentApi;
  state: StubState;
} {
  const state: StubState = { agents: [...initial], calls: [] };
  const hermes: HermesAgentApi = {
    async listAgents() {
      return [...state.agents];
    },
    async sendMessage(agentId, text) {
      state.calls.push({ agentId, text });
      return { reply: `echo:${text}`, sessionId: `session-${agentId}` };
    },
  };

  return { hermes, state };
}

function appFor(hermes: HermesAgentApi): Hono<TestEnv> {
  const app = new Hono<TestEnv>();
  app.use("/api/*", csrfProtection());
  app.route("/api", createAgentRoutes({ hermes, db }));
  return app;
}

const bindings = { SESSION_SECRET: SECRET };

async function getAgents(
  app: Hono<TestEnv>,
  headers = authHeaders(),
): Promise<Response> {
  return app.request("/api/agents", { headers }, bindings);
}

async function syncAgents(
  initial: AgentSummary[],
): Promise<{ body: { agents: AgentView[] }; state: StubState }> {
  const { hermes, state } = stubHermes(initial);
  const res = await getAgents(appFor(hermes));

  expect(res.status).toBe(200);
  return { body: (await res.json()) as { agents: AgentView[] }, state };
}

async function postMessage(
  app: Hono<TestEnv>,
  agentId: string,
  payload: unknown,
  headers = authHeaders({ "content-type": "application/json" }),
): Promise<Response> {
  return app.request(
    `/api/agents/${agentId}/messages`,
    { method: "POST", headers, body: JSON.stringify(payload) },
    bindings,
  );
}

const productionBindings = {
  DB: db,
  SESSION_SECRET: PRODUCTION_SECRET,
  HERMES_ORIGIN: "https://hermes.mount.test",
  HERMES_HMAC_SECRET: "mount-secret",
} as unknown as Env;

describe("GET /api/agents", () => {
  it("(a) syncs six Hermes agents into desks 0..5 and stores them in D1", async () => {
    const { body } = await syncAgents([1, 2, 3, 4, 5, 6].map((index) => agent(index)));

    expect(body.agents.map((item) => item.id)).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
      "agent-5",
      "agent-6",
    ]);
    expect(body.agents.map((item) => item.desk)).toEqual([0, 1, 2, 3, 4, 5]);

    const rows = await listAgents(db);
    expect(rows.map((row) => [row.id, row.desk_index])).toEqual([
      ["agent-1", 0],
      ["agent-2", 1],
      ["agent-3", 2],
      ["agent-4", 3],
      ["agent-5", 4],
      ["agent-6", 5],
    ]);
  });

  it("(b) returns desk: null for the seventh agent (hotdesk)", async () => {
    const { body } = await syncAgents(
      [1, 2, 3, 4, 5, 6, 7].map((index) => agent(index)),
    );

    expect(body.agents.map((item) => item.desk)).toEqual([0, 1, 2, 3, 4, 5, null]);

    const rows = await listAgents(db);
    expect(rows.find((row) => row.id === "agent-7")?.desk_index).toBeNull();
  });

  it("returns the local color and keeps an existing desk while filling the smallest free one", async () => {
    await upsertAgent(db, {
      id: "agent-2",
      name: "Old name",
      role: "old-role",
      color: "#7c5cff",
      desk_index: 3,
    });

    const { body } = await syncAgents([
      agent(1),
      agent(2, { name: "Agent 2", role: "reviewer" }),
    ]);

    expect(body.agents.map((item) => [item.id, item.desk, item.color])).toEqual([
      ["agent-1", 0, null],
      ["agent-2", 3, "#7c5cff"],
    ]);
    expect(body.agents[1]).toMatchObject({ name: "Agent 2", role: "reviewer" });
  });

  it("frees the desk of an agent removed from Hermes and gives it to a new agent", async () => {
    const { hermes, state } = stubHermes([agent(1), agent(2), agent(3)]);
    const app = appFor(hermes);

    const first = await getAgents(app);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { agents: AgentView[] }).agents.map((a) => a.desk)).toEqual([
      0, 1, 2,
    ]);

    // The middle agent disappears from Hermes.
    state.agents = [agent(1), agent(3)];
    const second = await getAgents(app);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { agents: AgentView[] }).agents.map((a) => a.desk)).toEqual([
      0, 2,
    ]);
    expect(
      (await listAgents(db)).find((row) => row.id === "agent-2")?.desk_index,
    ).toBeNull();

    // A new agent reuses the freed desk instead of hotdesking.
    state.agents = [agent(1), agent(3), agent(4)];
    const third = await getAgents(app);
    expect(third.status).toBe(200);
    const body = (await third.json()) as { agents: AgentView[] };
    expect(body.agents.map((a) => [a.id, a.desk])).toEqual([
      ["agent-1", 0],
      ["agent-3", 2],
      ["agent-4", 1],
    ]);
    expect(
      (await listAgents(db)).find((row) => row.id === "agent-4")?.desk_index,
    ).toBe(1);
  });

  it("marks unknown or missing Hermes statuses as unknown instead of inventing idle", async () => {
    const { hermes } = stubHermes([
      agent(1, { status: "napping" as AgentSummary["status"] }),
      {
        id: "agent-2",
        name: "Agent 2",
        role: "engineer",
        status: undefined as unknown as AgentSummary["status"],
      },
      agent(3, { status: "meeting" }),
    ]);

    const res = await getAgents(appFor(hermes));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: AgentView[] };
    expect(body.agents.map((item) => item.status)).toEqual([
      "unknown",
      "unknown",
      "meeting",
    ]);
  });

  it("maps Hermes failures to 502 without writing agents", async () => {
    const failing: HermesAgentApi = {
      async listAgents() {
        throw new HermesError("unreachable", "tunnel down");
      },
      async sendMessage() {
        throw new HermesError("unreachable", "tunnel down");
      },
    };

    const res = await getAgents(appFor(failing));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "hermes_unavailable" });
    expect(await listAgents(db)).toEqual([]);
  });
});

describe("POST /api/agents/:id/messages", () => {
  it("(c) forwards the message to Hermes and returns reply and sessionId", async () => {
    const { hermes, state } = stubHermes([agent(1)]);
    const res = await postMessage(appFor(hermes), "agent-1", { text: "hello" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reply: "echo:hello",
      sessionId: "session-agent-1",
    });
    expect(state.calls).toEqual([{ agentId: "agent-1", text: "hello" }]);
  });

  it("rejects an empty or non-string text with 400", async () => {
    const { hermes, state } = stubHermes([agent(1)]);
    const app = appFor(hermes);

    for (const payload of [{ text: "   " }, { text: 42 }, {}]) {
      const res = await postMessage(app, "agent-1", payload);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect(state.calls).toEqual([]);
  });

  it("maps Hermes failures to 502", async () => {
    const failing: HermesAgentApi = {
      async listAgents() {
        throw new HermesError("unreachable", "tunnel down");
      },
      async sendMessage() {
        throw new HermesError("unreachable", "tunnel down");
      },
    };

    const res = await postMessage(appFor(failing), "agent-1", { text: "hello" });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "hermes_unavailable" });
  });
});

describe("auth, CSRF and rate limiting", () => {
  it("(d) rejects a request without a session with 401", async () => {
    const { hermes } = stubHermes([agent(1)]);
    const res = await appFor(hermes).request("/api/agents", {}, bindings);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("(d) rejects a message mutation without x-csrf-token with 403", async () => {
    const { hermes } = stubHermes([agent(1)]);
    const res = await postMessage(appFor(hermes), "agent-1", { text: "hello" }, {
      cookie: `${SESSION_COOKIE}=${session.token}`,
      "content-type": "application/json",
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf" });
  });

  it("(e) rejects the 61st request in the same minute with 429", async () => {
    const { hermes } = stubHermes([agent(1)]);
    const app = appFor(hermes);

    for (let i = 0; i < 60; i += 1) {
      const res = await getAgents(app);
      expect(res.status).toBe(200);
    }

    const limited = await getAgents(app);

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);

    const limitedChat = await postMessage(app, "agent-1", { text: "hello" });
    expect(limitedChat.status).toBe(429);

    const other = await startSession("owner-2", SECRET);
    const otherUser = await getAgents(app, {
      cookie: `${SESSION_COOKIE}=${other.token}`,
    });
    expect(otherUser.status).toBe(200);
  });
});

describe("production mount (default Worker app)", () => {
  it("rewrites /api/agents to the router's /agents handler", async () => {
    const outbound: string[] = [];

    await withStubbedFetch(
      async (input, init) => {
        outbound.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
        return Response.json([agent(1), agent(2)]);
      },
      async () => {
        const { token } = await startSession("mount-user", PRODUCTION_SECRET);
        const res = await worker.request(
          "https://office.test/api/agents",
          { headers: { cookie: `${SESSION_COOKIE}=${token}` } },
          productionBindings,
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { agents: AgentView[] };
        expect(body.agents.map((item) => [item.id, item.desk])).toEqual([
          ["agent-1", 0],
          ["agent-2", 1],
        ]);
      },
    );

    expect(outbound).toEqual(["GET /agents"]);
  });

  it("rewrites the chat path and forwards the POST body intact", async () => {
    const outbound: { method: string; path: string; body: string }[] = [];

    await withStubbedFetch(
      async (input, init) => {
        outbound.push({
          method: init?.method ?? "GET",
          path: new URL(String(input)).pathname,
          body: String(init?.body ?? ""),
        });
        return Response.json({
          reply: "mount-reply",
          sessionId: "mount-session",
        });
      },
      async () => {
        const { token, csrf } = await startSession("mount-user", PRODUCTION_SECRET);
        const res = await worker.request(
          "https://office.test/api/agents/agent-9/messages",
          {
            method: "POST",
            headers: {
              cookie: `${SESSION_COOKIE}=${token}`,
              "x-csrf-token": csrf,
              "content-type": "application/json",
            },
            body: JSON.stringify({ text: "hello mount" }),
          },
          productionBindings,
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          reply: "mount-reply",
          sessionId: "mount-session",
        });
      },
    );

    expect(outbound).toEqual([
      {
        method: "POST",
        path: "/agents/agent-9/messages",
        body: '{"text":"hello mount"}',
      },
    ]);
  });
});
