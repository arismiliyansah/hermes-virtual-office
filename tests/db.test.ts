import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite inlines ?raw imports; this project has no ambient declaration for them.
import initSql from "../migrations/0001_init.sql?raw";
import {
  addMinutes,
  createMeeting,
  getMeetingWithMinutes,
  getUserByEmail,
  insertUser,
  listAgents,
  listTasks,
  upsertAgent,
  upsertTask,
  writeAudit,
  type AgentRow,
  type AuditRow,
  type MinuteRow,
} from "../src/db";

const db = (env as unknown as { DB: D1Database }).DB;

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
  ]);
});

describe("users", () => {
  it("inserts a user and reads it back by email", async () => {
    await insertUser(db, {
      id: "u1",
      email: "ada@example.com",
      passwordHash: "pbkdf2$100000$c2FsdA$aGFzaA",
    });

    const user = await getUserByEmail(db, "ada@example.com");

    expect(user).toMatchObject({
      id: "u1",
      email: "ada@example.com",
      password_hash: "pbkdf2$100000$c2FsdA$aGFzaA",
    });
    expect(user?.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("returns null for an unknown email", async () => {
    expect(await getUserByEmail(db, "nobody@example.com")).toBeNull();
  });

  it("rejects a duplicate email", async () => {
    await insertUser(db, {
      id: "u2",
      email: "grace@example.com",
      passwordHash: "pbkdf2$100000$c2FsdA$aGFzaA",
    });

    await expect(
      insertUser(db, {
        id: "u3",
        email: "grace@example.com",
        passwordHash: "pbkdf2$100000$c2FsdA$aGFzaA",
      }),
    ).rejects.toThrow(/unique/i);
  });
});

describe("agents", () => {
  it("defaults machine_id to 'main' at the database level", async () => {
    await db.prepare("INSERT INTO agents (id) VALUES (?)").bind("agent-default").run();

    const agent = await db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .bind("agent-default")
      .first<AgentRow>();

    expect(agent?.machine_id).toBe("main");
  });

  it("upserts new agents and updates existing ones", async () => {
    await upsertAgent(db, {
      id: "agent-1",
      machine_id: "workstation-a",
      name: "Hermes",
      role: "assistant",
      color: "#7c5cff",
      desk_index: 2,
    });
    await upsertAgent(db, {
      id: "agent-1",
      machine_id: "workstation-b",
      name: "Hermes Prime",
      role: "reviewer",
      color: "#ffcc00",
      desk_index: 1,
    });

    const agents = await listAgents(db);
    const matching = agents.filter((agent) => agent.id === "agent-1");

    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      id: "agent-1",
      machine_id: "workstation-b",
      name: "Hermes Prime",
      role: "reviewer",
      color: "#ffcc00",
      desk_index: 1,
    });
  });

  it("applies machine_id 'main' when an upsert omits it", async () => {
    await upsertAgent(db, { id: "agent-2" });

    const agent = await db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .bind("agent-2")
      .first<AgentRow>();

    expect(agent?.machine_id).toBe("main");
  });
});

describe("tasks", () => {
  it("has an office_label column", async () => {
    const columns = await db.prepare("PRAGMA table_info(tasks)").all<{ name: string }>();

    expect(columns.results.map((column) => column.name)).toContain("office_label");
  });

  it("upserts tasks and lists them by most recently updated", async () => {
    await upsertTask(db, {
      id: "task-1",
      title: "Write schema",
      status: "todo",
      office_label: "Desk 1",
      owner_agent: "agent-1",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await upsertTask(db, {
      id: "task-2",
      title: "Review schema",
      status: "todo",
      office_label: "Desk 2",
      owner_agent: "agent-2",
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    await upsertTask(db, {
      id: "task-1",
      title: "Write schema",
      status: "done",
      office_label: "Desk 1",
      owner_agent: "agent-1",
      updated_at: "2026-01-03T00:00:00.000Z",
    });

    const tasks = await listTasks(db);

    expect(tasks.map((task) => task.id)).toEqual(["task-1", "task-2"]);
    expect(tasks[0]).toMatchObject({
      id: "task-1",
      status: "done",
      office_label: "Desk 1",
    });
  });
});

describe("audit", () => {
  it("auto-increments ids and returns the inserted id", async () => {
    const first = await writeAudit(db, {
      userId: "u1",
      action: "login",
      detail: "password",
    });
    const second = await writeAudit(db, { action: "logout" });

    expect(second).toBe(first + 1);

    const rows = await db
      .prepare("SELECT * FROM audit ORDER BY id")
      .all<AuditRow>();

    expect(rows.results.map((row) => row.id)).toEqual([first, second]);
    expect(rows.results[1]).toMatchObject({ action: "logout", user_id: null });
  });
});

describe("meetings and minutes", () => {
  it("creates a meeting with minutes that can be read back together", async () => {
    await createMeeting(db, { id: "meeting-1", title: "Standup", room: "main" });
    await addMinutes(db, {
      id: "minute-1",
      meeting_id: "meeting-1",
      content: "Shipped the schema.",
    });

    const result = await getMeetingWithMinutes(db, "meeting-1");

    expect(result?.meeting).toMatchObject({
      id: "meeting-1",
      title: "Standup",
      room: "main",
      status: "open",
    });
    expect(result?.minutes).toHaveLength(1);
    expect(result?.minutes[0]).toMatchObject({
      id: "minute-1",
      meeting_id: "meeting-1",
      content: "Shipped the schema.",
    } satisfies Partial<MinuteRow>);
  });

  it("returns null for an unknown meeting", async () => {
    expect(await getMeetingWithMinutes(db, "missing")).toBeNull();
  });
});

describe("password hash format", () => {
  it("matches a pbkdf2 hash generated by scripts/hash-password.mjs", async () => {
    // Generated by: node scripts/hash-password.mjs password
    const stored =
      "pbkdf2$100000$Hna2Q0Xs4LjxPwOAcRbzIw$qp2O1yVvsh-APvJ_BbvpF_paVYyXm-NPeYs_TCIZdeE";
    const [scheme, iterations, salt, hash] = stored.split("$");

    expect(scheme).toBe("pbkdf2");
    expect(Number(iterations)).toBe(100000);

    const saltBytes = Uint8Array.from(atob(salt.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    expect(saltBytes).toHaveLength(16);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("password"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
        key,
        256,
      ),
    );
    const derived = btoa(String.fromCharCode(...bits))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(derived).toBe(hash);
  });
});
