export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface AgentRow {
  id: string;
  machine_id: string;
  name: string | null;
  role: string | null;
  color: string | null;
  desk_index: number | null;
}

export interface TaskRow {
  id: string;
  title: string | null;
  status: string | null;
  office_label: string | null;
  owner_agent: string | null;
  updated_at: string | null;
}

export interface MeetingRow {
  id: string;
  title: string | null;
  room: string | null;
  status: string | null;
  created_at: string | null;
}

export interface MinuteRow {
  id: string;
  meeting_id: string | null;
  content: string | null;
  created_at: string | null;
}

export interface AuditRow {
  id: number;
  user_id: string | null;
  action: string | null;
  detail: string | null;
  created_at: string | null;
}

export interface NewUser {
  id: string;
  email: string;
  passwordHash: string;
}

export interface AgentInput {
  id: string;
  name: string;
  role: string;
  color?: string | null;
  desk_index?: number | null;
}

export interface TaskInput {
  id: string;
  title: string;
  status: string;
  owner_agent: string | null;
  office_label?: string | null;
}

export type MeetingInput = Pick<MeetingRow, "id"> & Partial<Omit<MeetingRow, "id">>;

export interface MinuteInput {
  id: string;
  meeting_id: string;
  content: string;
  created_at?: string | null;
}

export interface AuditInput {
  userId?: string | null;
  action: string;
  detail?: string | null;
}

export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  return db
    .prepare("SELECT id, email, password_hash, created_at FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();
}

export async function insertUser(db: D1Database, user: NewUser): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
    .bind(user.id, user.email, user.passwordHash)
    .run();
}

export async function listAgents(db: D1Database): Promise<AgentRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, machine_id, name, role, color, desk_index FROM agents ORDER BY desk_index, id",
    )
    .all<AgentRow>();

  return results;
}

export async function upsertAgent(db: D1Database, agent: AgentInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agents (id, name, role, color, desk_index)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         color = COALESCE(excluded.color, agents.color),
         desk_index = COALESCE(excluded.desk_index, agents.desk_index)`,
    )
    .bind(
      agent.id,
      agent.name,
      agent.role,
      agent.color ?? null,
      agent.desk_index ?? null,
    )
    .run();
}

/**
 * Set or clear a desk explicitly. Unlike `upsertAgent`, a null desk is written
 * as null instead of being coalesced away, which is required when an agent
 * disappears from Hermes and its desk must be freed.
 */
export async function setAgentDesk(
  db: D1Database,
  id: string,
  deskIndex: number | null,
): Promise<void> {
  await db
    .prepare("UPDATE agents SET desk_index = ? WHERE id = ?")
    .bind(deskIndex, id)
    .run();
}

export async function listTasks(db: D1Database): Promise<TaskRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, status, office_label, owner_agent, updated_at
       FROM tasks
       ORDER BY updated_at DESC, id`,
    )
    .all<TaskRow>();

  return results;
}

export async function upsertTask(db: D1Database, task: TaskInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tasks (id, title, status, owner_agent, office_label, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         status = excluded.status,
         owner_agent = excluded.owner_agent,
         office_label = COALESCE(excluded.office_label, tasks.office_label),
         updated_at = datetime('now')`,
    )
    .bind(
      task.id,
      task.title,
      task.status,
      task.owner_agent,
      task.office_label ?? null,
    )
    .run();
}

/** Remember every Hermes status ever seen; old rows are never removed. */
export async function recordTaskStatuses(
  db: D1Database,
  statuses: string[],
): Promise<void> {
  if (statuses.length === 0) return;

  await db.batch(
    statuses.map((status) =>
      db
        .prepare("INSERT OR IGNORE INTO task_statuses (status) VALUES (?)")
        .bind(status),
    ),
  );
}

/**
 * Drop mirror rows Hermes no longer reports. The D1 table is only a mirror:
 * keeping deleted cards would resurrect them in the board after every refresh.
 */
export async function pruneTasks(
  db: D1Database,
  keepIds: string[],
): Promise<void> {
  if (keepIds.length === 0) {
    await db.prepare("DELETE FROM tasks").run();
    return;
  }

  const placeholders = keepIds.map(() => "?").join(", ");
  await db
    .prepare(`DELETE FROM tasks WHERE id NOT IN (${placeholders})`)
    .bind(...keepIds)
    .run();
}

/**
 * Clear an office-only label. `upsertTask` cannot do it with null because its
 * COALESCE treats null as "keep the previous label".
 */
export async function clearTaskLabel(
  db: D1Database,
  id: string,
): Promise<void> {
  await db.prepare("UPDATE tasks SET office_label = NULL WHERE id = ?").bind(id).run();
}

export async function listKnownTaskStatuses(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT status FROM task_statuses ORDER BY status")
    .all<{ status: string }>();

  return results.map((row) => row.status);
}

export async function writeAudit(db: D1Database, entry: AuditInput): Promise<number> {
  const result = await db
    .prepare(
      "INSERT INTO audit (user_id, action, detail, created_at) VALUES (?, ?, ?, datetime('now'))",
    )
    .bind(entry.userId ?? null, entry.action, entry.detail ?? null)
    .run();

  return result.meta.last_row_id;
}

export async function createMeeting(db: D1Database, meeting: MeetingInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meetings (id, title, room, status, created_at)
       VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    )
    .bind(
      meeting.id,
      meeting.title ?? null,
      meeting.room ?? null,
      meeting.status ?? "open",
      meeting.created_at ?? null,
    )
    .run();
}

export async function addMinutes(db: D1Database, minute: MinuteInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO minutes (id, meeting_id, content, created_at)
       VALUES (?, ?, ?, COALESCE(?, datetime('now')))`,
    )
    .bind(
      minute.id,
      minute.meeting_id,
      minute.content,
      minute.created_at ?? null,
    )
    .run();
}

export async function listMeetings(
  db: D1Database,
  limit = 50,
): Promise<MeetingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, room, status, created_at
       FROM meetings
       ORDER BY created_at DESC, id
       LIMIT ?`,
    )
    .bind(limit)
    .all<MeetingRow>();

  return results;
}

export async function getMeetingWithMinutes(
  db: D1Database,
  id: string,
): Promise<{ meeting: MeetingRow; minutes: MinuteRow[] } | null> {
  const meeting = await db
    .prepare("SELECT id, title, room, status, created_at FROM meetings WHERE id = ?")
    .bind(id)
    .first<MeetingRow>();

  if (meeting === null) return null;

  const { results } = await db
    .prepare(
      `SELECT id, meeting_id, content, created_at
       FROM minutes
       WHERE meeting_id = ?
       ORDER BY created_at, id`,
    )
    .bind(id)
    .all<MinuteRow>();

  return { meeting, minutes: results };
}
