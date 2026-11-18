import type { AgentStatus } from "../src/duty";

export const CSRF_STORAGE_KEY = "hermes-office-csrf";

export interface MeResponse {
  userId: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  color: string | null;
  desk: number | null;
  status: AgentStatus;
}

export interface AgentReply {
  reply: string;
  sessionId: string;
}

export interface Task {
  id: string;
  title: string | null;
  status: string | null;
  office_label: string | null;
  owner_agent: string | null;
  updated_at: string | null;
}

export interface NewTask {
  title: string;
  ownerAgentId?: string | null;
}

export interface Meeting {
  id: string;
  title: string | null;
  room: string | null;
  status: string | null;
  created_at: string | null;
}

export interface Minute {
  id: string;
  meeting_id: string | null;
  content: string | null;
  created_at: string | null;
}

export interface MeetingResult {
  meeting: Meeting;
  minutes: Minute[];
}

export interface NewMeeting {
  title: string;
  participantIds: string[];
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  agentId: string;
}

export interface LoginResponse {
  csrf: string;
}

interface ErrorResponse {
  error?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(code ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

/**
 * App registers one handler so any 401 from an authenticated API call drops
 * the office shell back to the login screen. Login/me/logout are exempt:
 * their 401s are expected parts of the auth flow.
 */
export function setUnauthorizedHandler(
  handler: (() => void) | null,
): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

const AUTH_FLOW_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/me",
  "/api/auth/logout",
]);

function notifyUnauthorized(path: string): void {
  if (AUTH_FLOW_PATHS.has(path)) return;
  clearCsrfToken();
  unauthorizedHandler?.();
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function getCsrfToken(): string | null {
  if (csrfToken !== null) return csrfToken;

  try {
    csrfToken = storage()?.getItem(CSRF_STORAGE_KEY) ?? null;
  } catch {
    csrfToken = null;
  }

  return csrfToken;
}

export function setCsrfToken(token: string): void {
  csrfToken = token;
  try {
    storage()?.setItem(CSRF_STORAGE_KEY, token);
  } catch {
    // Private-mode storage can reject writes; the in-memory copy still works.
  }
}

export function clearCsrfToken(): void {
  csrfToken = null;
  try {
    storage()?.removeItem(CSRF_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
}

async function request(
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers();

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (method !== "GET") {
    const token = getCsrfToken();
    if (token !== null) headers.set("x-csrf-token", token);
  }

  const response = await fetch(path, {
    method,
    credentials: "include",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 401) notifyUnauthorized(path);

  return response;
}

async function throwApiError(response: Response): Promise<never> {
  let code: string | undefined;

  try {
    const body = (await response.json()) as ErrorResponse;
    if (typeof body.error === "string") code = body.error;
  } catch {
    // A non-JSON error body still carries a useful status.
  }

  throw new ApiError(response.status, code);
}

export async function me(): Promise<MeResponse | null> {
  const response = await request("/api/auth/me");
  if (response.status === 401) return null;
  if (!response.ok) await throwApiError(response);

  return (await response.json()) as MeResponse;
}

export async function login(email: string, password: string): Promise<void> {
  const response = await request("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  if (!response.ok) await throwApiError(response);

  const body = (await response.json()) as LoginResponse;
  setCsrfToken(body.csrf);
}

export async function logout(): Promise<void> {
  try {
    const response = await request("/api/auth/logout", { method: "POST" });
    if (!response.ok && response.status !== 401 && response.status !== 403) {
      await throwApiError(response);
    }
  } finally {
    clearCsrfToken();
  }
}

export async function listAgents(): Promise<Agent[]> {
  const response = await request("/api/agents");
  if (!response.ok) await throwApiError(response);

  const body = (await response.json()) as { agents?: Agent[] };
  return Array.isArray(body.agents) ? body.agents : [];
}

export async function sendAgentMessage(
  agentId: string,
  text: string,
): Promise<AgentReply> {
  const response = await request(
    `/api/agents/${encodeURIComponent(agentId)}/messages`,
    { method: "POST", body: { text } },
  );
  if (!response.ok) await throwApiError(response);

  return (await response.json()) as AgentReply;
}

export async function listTasks(): Promise<Task[]> {
  const response = await request("/api/tasks");
  if (!response.ok) await throwApiError(response);

  const body = (await response.json()) as { tasks?: Task[] };
  return Array.isArray(body.tasks) ? body.tasks : [];
}

export async function createTask(input: NewTask): Promise<Task> {
  const body: { title: string; ownerAgentId?: string } = {
    title: input.title,
  };
  if (typeof input.ownerAgentId === "string" && input.ownerAgentId.length > 0) {
    body.ownerAgentId = input.ownerAgentId;
  }

  const response = await request("/api/tasks", { method: "POST", body });
  if (!response.ok) await throwApiError(response);

  const result = (await response.json()) as { task: Task };
  return result.task;
}

export async function updateTaskStatus(
  taskId: string,
  status: string,
): Promise<Task> {
  const response = await request(
    `/api/tasks/${encodeURIComponent(taskId)}/status`,
    { method: "POST", body: { status } },
  );
  if (!response.ok) await throwApiError(response);

  const result = (await response.json()) as { task: Task };
  return result.task;
}

export async function startMeeting(input: NewMeeting): Promise<MeetingResult> {
  const response = await request("/api/meetings", {
    method: "POST",
    body: { title: input.title, participantIds: input.participantIds },
  });
  if (!response.ok) await throwApiError(response);

  return (await response.json()) as MeetingResult;
}

export async function getMeeting(id: string): Promise<MeetingResult | null> {
  const response = await request(`/api/meetings/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) await throwApiError(response);

  return (await response.json()) as MeetingResult;
}

export async function listCrons(): Promise<CronJob[]> {
  const response = await request("/api/cron");
  if (!response.ok) await throwApiError(response);

  const body = (await response.json()) as { crons?: CronJob[] };
  return Array.isArray(body.crons) ? body.crons : [];
}

export async function setCronEnabled(
  id: string,
  enabled: boolean,
): Promise<CronJob> {
  const response = await request(
    `/api/cron/${encodeURIComponent(id)}/toggle`,
    { method: "POST", body: { enabled } },
  );
  if (!response.ok) await throwApiError(response);

  const body = (await response.json()) as { cron: CronJob };
  return body.cron;
}

export async function runCron(id: string): Promise<{ runId: string }> {
  const response = await request(
    `/api/cron/${encodeURIComponent(id)}/run`,
    { method: "POST" },
  );
  if (!response.ok) await throwApiError(response);

  return (await response.json()) as { runId: string };
}
