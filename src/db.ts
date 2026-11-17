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

export type AgentInput = Pick<AgentRow, "id"> & Partial<Omit<AgentRow, "id">>;
export type TaskInput = Pick<TaskRow, "id"> & Partial<Omit<TaskRow, "id">>;
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
      `INSERT INTO agents (id, machine_id, name, role, color, desk_index)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         machine_id = excluded.machine_id,
         name = excluded.name,
         role = excluded.role,
         color = excluded.color,
         desk_index = excluded.desk_index`,
    )
    .bind(
      agent.id,
      agent.machine_id ?? "main",
      agent.name ?? null,
      agent.role ?? null,
      agent.color ?? null,
      agent.desk_index ?? null,
    )
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
      `INSERT INTO tasks (id, title, status, office_label, owner_agent, updated_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         status = excluded.status,
         office_label = excluded.office_label,
         owner_agent = excluded.owner_agent,
         updated_at = excluded.updated_at`,
    )
    .bind(
      task.id,
      task.title ?? null,
      task.status ?? null,
      task.office_label ?? null,
      task.owner_agent ?? null,
      task.updated_at ?? null,
    )
    .run();
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
