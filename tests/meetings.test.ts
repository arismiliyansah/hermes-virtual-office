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
import {
  getMeetingWithMinutes,
  upsertAgent,
  type AuditRow,
  type MeetingRow,
  type MinuteRow,
} from "../src/db";
import type { Env } from "../src/env";
import { HermesError } from "../src/hermes";
import worker from "../src/index";
import { __resetRateLimit } from "../src/ratelimit";
import {
  createMeetingRoutes,
  MEETING_RATE_LIMIT,
  type HermesMeetingApi,
} from "../src/routes-meetings";
import { withStubbedFetch } from "./helpers";
import { applyAllMigrations } from "./migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const SECRET = "dev-secret";
const USER_ID = "owner-1";

type TestEnv = {
  Bindings: { SESSION_SECRET: string };
  Variables: AuthVariables;
};

interface MeetingBody {
  meeting: MeetingRow;
  minutes: MinuteRow[];
}


beforeAll(async () => {
  await applyAllMigrations(db);
});

let session: StartedSession;

beforeEach(async () => {
  __resetRateLimit();
  await db.prepare("DELETE FROM minutes").run();
  await db.prepare("DELETE FROM meetings").run();
  await db.prepare("DELETE FROM agents").run();
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

type ReplyFn = (agentId: string, text: string) => string;

type HermesCall = { agentId: string; text: string };

function stubHermes(
  reply: ReplyFn = (agentId) => `balasan ${agentId}`,
): { hermes: HermesMeetingApi; calls: HermesCall[] } {
  const calls: HermesCall[] = [];

  const hermes: HermesMeetingApi = {
    async sendMessage(agentId, text) {
      calls.push({ agentId, text });
      return { reply: reply(agentId, text), sessionId: `session-${calls.length}` };
    },
  };

  return { hermes, calls };
}

function appFor(hermes: HermesMeetingApi): Hono<TestEnv> {
  const app = new Hono<TestEnv>();
  app.use("/api/*", csrfProtection());
  app.route("/api", createMeetingRoutes({ hermes, db }));
  return app;
}

const bindings = { SESSION_SECRET: SECRET };

async function createMeeting(
  app: Hono<TestEnv>,
  payload: unknown,
  headers = authHeaders({ "content-type": "application/json" }),
): Promise<Response> {
  return app.request(
    "/api/meetings",
    { method: "POST", headers, body: JSON.stringify(payload) },
    bindings,
  );
}

async function getMeeting(
  app: Hono<TestEnv>,
  id: string,
  headers = authHeaders(),
): Promise<Response> {
  return app.request(`/api/meetings/${id}`, { headers }, bindings);
}

async function auditRows(): Promise<AuditRow[]> {
  const { results } = await db
    .prepare("SELECT id, user_id, action, detail, created_at FROM audit ORDER BY id")
    .all<AuditRow>();
  return results;
}

async function meetingRows(): Promise<MeetingRow[]> {
  const { results } = await db
    .prepare("SELECT id, title, room, status, created_at FROM meetings ORDER BY id")
    .all<MeetingRow>();
  return results;
}

async function seedAgents(): Promise<void> {
  await upsertAgent(db, { id: "agent-1", name: "Ana", role: "Engineer" });
  await upsertAgent(db, { id: "agent-2", name: "Budi", role: "Manager" });
}

describe("POST /api/meetings", () => {
  it("(a) rejects fewer than two participants without calling Hermes", async () => {
    await seedAgents();
    const { hermes, calls } = stubHermes();
    const app = appFor(hermes);

    for (const payload of [
      { title: "Rapat sepi", participantIds: ["agent-1"] },
      { title: "Rapat sepi", participantIds: [] },
      { title: "Rapat sepi" },
      { title: "   ", participantIds: ["agent-1", "agent-2"] },
      { title: "Rapat", participantIds: ["agent-1", 42] },
    ]) {
      const res = await createMeeting(app, payload);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }

    expect(calls).toEqual([]);
    expect(await meetingRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("(b) sends one turn per participant in participantIds order, then the secretary", async () => {
    await seedAgents();
    const { hermes, calls } = stubHermes((agentId, text) =>
      text.includes("notulen") ? "NOTULEN: ringkas" : `Pendapat ${agentId}`,
    );

    const res = await createMeeting(appFor(hermes), {
      title: "Rapat rilis",
      participantIds: ["agent-1", "agent-2"],
    });

    expect(res.status).toBe(201);
    expect(calls.map((call) => call.agentId)).toEqual([
      "agent-1",
      "agent-2",
      "agent-2",
    ]);

    // Both turn prompts name the meeting so each agent knows the context.
    expect(calls[0].text).toContain("Rapat rilis");
    expect(calls[1].text).toContain("Rapat rilis");
    expect(calls[0].text).not.toContain("notulen");
    expect(calls[1].text).not.toContain("notulen");
  });

  it("(c) asks the Manager to write minutes containing both turns", async () => {
    await seedAgents();
    const { hermes, calls } = stubHermes((agentId, text) =>
      text.includes("notulen") ? "NOTULEN: ringkas" : `Pendapat ${agentId}`,
    );

    await createMeeting(appFor(hermes), {
      title: "Rapat rilis",
      participantIds: ["agent-1", "agent-2"],
    });

    const secretaryCall = calls[2];
    expect(secretaryCall.agentId).toBe("agent-2");
    expect(secretaryCall.text).toContain("notulen");
    expect(secretaryCall.text).toContain("[Ana]: Pendapat agent-1");
    expect(secretaryCall.text).toContain("[Budi]: Pendapat agent-2");
  });

  it("(d)(e) stores the secretary reply, marks the meeting done and audits it", async () => {
    await seedAgents();
    const { hermes } = stubHermes((agentId, text) =>
      text.includes("notulen") ? "NOTULEN: rilis ditunda" : `Pendapat ${agentId}`,
    );

    const res = await createMeeting(appFor(hermes), {
      title: "Rapat rilis",
      participantIds: ["agent-1", "agent-2"],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as MeetingBody;
    expect(body.meeting).toMatchObject({
      title: "Rapat rilis",
      room: "Ruang Kaca",
      status: "done",
    });
    expect(body.minutes).toHaveLength(1);
    expect(body.minutes[0].content).toBe("NOTULEN: rilis ditunda");

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(["meeting.create"]);
    expect(rows[0].user_id).toBe(USER_ID);
    expect(JSON.parse(rows[0].detail ?? "{}")).toMatchObject({
      meetingId: body.meeting.id,
      title: "Rapat rilis",
      participants: ["agent-1", "agent-2"],
    });
  });

  it("falls back to the first participant and the raw transcript without a Manager or reply", async () => {
    await upsertAgent(db, { id: "agent-1", name: "Ana", role: "Engineer" });
    await upsertAgent(db, { id: "agent-2", name: "Budi", role: "Designer" });
    const { hermes, calls } = stubHermes((agentId, text) =>
      text.includes("notulen") ? "   " : `Pendapat ${agentId}`,
    );

    const res = await createMeeting(appFor(hermes), {
      title: "Rapat tanpa bos",
      participantIds: ["agent-1", "agent-2"],
    });

    expect(res.status).toBe(201);
    expect(calls[2].agentId).toBe("agent-1");

    const body = (await res.json()) as MeetingBody;
    expect(body.minutes[0].content).toBe(
      "[Ana]: Pendapat agent-1\n[Budi]: Pendapat agent-2",
    );
  });

  it("maps a Hermes failure to 502 and marks the meeting failed", async () => {
    const failing: HermesMeetingApi = {
      async sendMessage() {
        throw new HermesError("unreachable", "tunnel down");
      },
    };

    const res = await createMeeting(appFor(failing), {
      title: "Rapat gagal",
      participantIds: ["agent-1", "agent-2"],
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "hermes_unavailable" });

    const rows = await meetingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Rapat gagal", status: "failed" });
    expect(await auditRows()).toEqual([]);
  });
});

describe("GET /api/meetings/:id", () => {
  it("(f) returns the stored meeting and its minutes", async () => {
    await seedAgents();
    const { hermes } = stubHermes((agentId, text) =>
      text.includes("notulen") ? "NOTULEN: rilis ditunda" : `Pendapat ${agentId}`,
    );
    const app = appFor(hermes);

    const created = await createMeeting(app, {
      title: "Rapat rilis",
      participantIds: ["agent-1", "agent-2"],
    });
    const createdBody = (await created.json()) as MeetingBody;

    const res = await getMeeting(app, createdBody.meeting.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(createdBody);
  });

  it("returns 404 for an unknown meeting", async () => {
    const { hermes } = stubHermes();

    const res = await getMeeting(appFor(hermes), "meeting-missing");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("auth, CSRF and rate limiting", () => {
  it("rejects a request without a session with 401", async () => {
    const { hermes } = stubHermes();

    const res = await appFor(hermes).request(
      "/api/meetings/meeting-1",
      {},
      bindings,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a mutation without x-csrf-token with 403", async () => {
    const { hermes } = stubHermes();

    const res = await createMeeting(
      appFor(hermes),
      { title: "Rapat", participantIds: ["agent-1", "agent-2"] },
      { cookie: `${SESSION_COOKIE}=${session.token}`, "content-type": "application/json" },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf" });
  });

  it("rate limits meeting requests", async () => {
    const { hermes } = stubHermes();
    const app = appFor(hermes);

    for (let i = 0; i < MEETING_RATE_LIMIT.limit; i += 1) {
      const res = await createMeeting(app, {
        title: `Rapat ${i}`,
        participantIds: ["agent-1", "agent-2"],
      });
      expect(res.status).toBe(201);
    }

    const limited = await createMeeting(app, {
      title: "Rapat terakhir",
      participantIds: ["agent-1", "agent-2"],
    });

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

  it("(g) serves POST and GET /api/meetings through the Worker with auth and CSRF", async () => {
    await withStubbedFetch(
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        const { text } = JSON.parse(String(init?.body ?? "{}")) as { text: string };
        const agentId = path.split("/")[2];

        if (text.includes("notulen")) {
          return Response.json({ reply: "Notulen produksi", sessionId: "s3" });
        }
        return Response.json({
          reply: `balasan ${agentId}`,
          sessionId: `session-${agentId}`,
        });
      },
      async () => {
        const { token, csrf } = await startSession("mount-user", SECRET);

        const unauthenticated = await worker.request(
          "https://office.test/api/meetings/meeting-1",
          {},
          productionBindings,
        );
        expect(unauthenticated.status).toBe(401);

        const noCsrf = await worker.request(
          "https://office.test/api/meetings",
          {
            method: "POST",
            headers: {
              cookie: `${SESSION_COOKIE}=${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              title: "Rapat produksi",
              participantIds: ["agent-1", "agent-2"],
            }),
          },
          productionBindings,
        );
        expect(noCsrf.status).toBe(403);

        const created = await worker.request(
          "https://office.test/api/meetings",
          {
            method: "POST",
            headers: {
              cookie: `${SESSION_COOKIE}=${token}`,
              "x-csrf-token": csrf,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              title: "Rapat produksi",
              participantIds: ["agent-1", "agent-2"],
            }),
          },
          productionBindings,
        );
        expect(created.status).toBe(201);
        const createdBody = (await created.json()) as MeetingBody;
        expect(createdBody.meeting).toMatchObject({
          title: "Rapat produksi",
          room: "Ruang Kaca",
          status: "done",
        });
        expect(createdBody.minutes[0].content).toBe("Notulen produksi");

        const fetched = await worker.request(
          `https://office.test/api/meetings/${createdBody.meeting.id}`,
          { headers: { cookie: `${SESSION_COOKIE}=${token}` } },
          productionBindings,
        );
        expect(fetched.status).toBe(200);
        expect(await fetched.json()).toEqual(createdBody);

        // Rows written by the mount are the same ones the helper reads.
        const stored = await getMeetingWithMinutes(db, createdBody.meeting.id);
        expect(stored?.meeting.status).toBe("done");
        expect(stored?.minutes).toHaveLength(1);
      },
    );
  });
});
