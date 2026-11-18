import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addMinutes,
  createMeeting,
  getMeetingWithMinutes,
  getUserByEmail,
  insertUser,
  listAgents,
  listKnownTaskStatuses,
  listTasks,
  recordTaskStatuses,
  upsertAgent,
  upsertTask,
  writeAudit,
  type AgentRow,
  type AuditRow,
  type MinuteRow,
  type TaskRow,
} from "../src/db";
import { applyAllMigrations } from "./migrations";

const db = (env as unknown as { DB: D1Database }).DB;


beforeAll(async () => {
  await applyAllMigrations(db);
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

  it("upserts new agents and updates Hermes-owned fields", async () => {
    await upsertAgent(db, {
      id: "agent-1",
      name: "Hermes",
      role: "assistant",
      color: "#7c5cff",
      desk_index: 2,
    });
    await upsertAgent(db, {
      id: "agent-1",
      name: "Hermes Prime",
      role: "reviewer",
    });

    const matching = (await listAgents(db)).filter((agent) => agent.id === "agent-1");

    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      id: "agent-1",
      machine_id: "main",
      name: "Hermes Prime",
      role: "reviewer",
      color: "#7c5cff",
      desk_index: 2,
    });
  });

  it("preserves machine_id on conflict", async () => {
    await db
      .prepare("INSERT INTO agents (id, machine_id, name, role) VALUES (?, ?, ?, ?)")
      .bind("agent-preserved", "workstation-a", "Old name", "assistant")
      .run();

    await upsertAgent(db, {
      id: "agent-preserved",
      name: "Hermes",
      role: "assistant",
    });

    const agent = await db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .bind("agent-preserved")
      .first<AgentRow>();

    expect(agent).toMatchObject({
      id: "agent-preserved",
      machine_id: "workstation-a",
      name: "Hermes",
    });
  });

  it("defaults machine_id to 'main' for agents inserted through upsert", async () => {
    await upsertAgent(db, { id: "agent-2", name: "Hermes", role: "assistant" });

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

  it("upserts tasks and lists them", async () => {
    await upsertTask(db, {
      id: "task-1",
      title: "Write schema",
      status: "todo",
      office_label: "Desk 1",
      owner_agent: "agent-1",
    });
    await upsertTask(db, {
      id: "task-2",
      title: "Review schema",
      status: "todo",
      office_label: "Desk 2",
      owner_agent: "agent-2",
    });
    await upsertTask(db, {
      id: "task-1",
      title: "Write schema",
      status: "done",
      office_label: "Desk 1",
      owner_agent: "agent-1",
    });

    const tasks = await listTasks(db);

    expect(tasks.map((task) => task.id).sort()).toEqual(["task-1", "task-2"]);
    expect(tasks.find((task) => task.id === "task-1")).toMatchObject({
      id: "task-1",
      status: "done",
      office_label: "Desk 1",
    });
  });

  it("preserves an existing office_label when an upsert omits it", async () => {
    await upsertTask(db, {
      id: "task-label",
      title: "Local label",
      status: "todo",
      owner_agent: null,
      office_label: "Desk 9",
    });

    await upsertTask(db, {
      id: "task-label",
      title: "Local label",
      status: "in_progress",
      owner_agent: "agent-1",
    });

    const task = await db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .bind("task-label")
      .first<TaskRow>();

    expect(task).toMatchObject({
      status: "in_progress",
      owner_agent: "agent-1",
      office_label: "Desk 9",
    });
  });

  it("updates office_label without touching Hermes-owned fields", async () => {
    await upsertTask(db, {
      id: "task-relabel",
      title: "Keep title",
      status: "todo",
      owner_agent: "agent-1",
      office_label: "Desk 1",
    });

    await upsertTask(db, {
      id: "task-relabel",
      title: "Keep title",
      status: "todo",
      owner_agent: "agent-1",
      office_label: "Desk 2",
    });

    const task = await db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .bind("task-relabel")
      .first<TaskRow>();

    expect(task).toMatchObject({
      title: "Keep title",
      status: "todo",
      owner_agent: "agent-1",
      office_label: "Desk 2",
    });
  });

  it("refreshes updated_at on update", async () => {
    await upsertTask(db, {
      id: "task-updated",
      title: "Timestamps",
      status: "todo",
      owner_agent: null,
    });
    await db
      .prepare("UPDATE tasks SET updated_at = '2000-01-01 00:00:00' WHERE id = ?")
      .bind("task-updated")
      .run();

    await upsertTask(db, {
      id: "task-updated",
      title: "Timestamps",
      status: "done",
      owner_agent: null,
    });

    const task = await db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .bind("task-updated")
      .first<TaskRow>();

    expect(task?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(task?.updated_at).not.toBe("2000-01-01 00:00:00");
  });
});

describe("task statuses", () => {
  it("applies the 0002 migration with the expected columns", async () => {
    const columns = await db
      .prepare("PRAGMA table_info(task_statuses)")
      .all<{ name: string; notnull: number; pk: number }>();

    expect(columns.results.map((column) => column.name)).toEqual([
      "status",
      "seen_at",
    ]);
    expect(
      columns.results.find((column) => column.name === "status"),
    ).toMatchObject({ pk: 1 });
    expect(
      columns.results.find((column) => column.name === "seen_at"),
    ).toMatchObject({ notnull: 1 });
  });

  it("records statuses once and lists every known status", async () => {
    await db.prepare("DELETE FROM task_statuses").run();

    await recordTaskStatuses(db, ["todo", "done", "todo"]);
    await recordTaskStatuses(db, ["done", "review"]);

    expect(await listKnownTaskStatuses(db)).toEqual(["done", "review", "todo"]);

    const row = await db
      .prepare("SELECT status, seen_at FROM task_statuses WHERE status = ?")
      .bind("todo")
      .first<{ status: string; seen_at: string }>();
    expect(row?.seen_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
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
