import type { Duty } from "./duty";
import { signedHeaders } from "./sign";

export type { Duty } from "./duty";

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  status: Duty;
}

export interface TaskCard {
  id: string;
  title: string;
  status: string;
  owner: string | null;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  agentId: string;
}

export type HermesErrorCode = "unreachable" | "bad_response";

export class HermesError extends Error {
  readonly code: HermesErrorCode;

  constructor(code: HermesErrorCode, message: string) {
    super(message);
    this.name = "HermesError";
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HermesClient {
  readonly #origin: string;
  readonly #secret: string;
  readonly #fetchImpl: typeof fetch;

  constructor(opts: { origin: string; secret: string; fetchImpl?: typeof fetch }) {
    this.#origin = opts.origin.replace(/\/+$/, "");
    this.#secret = opts.secret;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listAgents(): Promise<AgentSummary[]> {
    return this.#request<AgentSummary[]>("GET", "/agents");
  }

  async listTasks(): Promise<TaskCard[]> {
    return this.#request<TaskCard[]>("GET", "/tasks");
  }

  async createTask(title: string, ownerAgentId: string | null): Promise<TaskCard> {
    return this.#request<TaskCard>("POST", "/tasks", { title, owner: ownerAgentId });
  }

  async updateTaskStatus(id: string, status: string): Promise<TaskCard> {
    return this.#request<TaskCard>(
      "POST",
      `/tasks/${encodeURIComponent(id)}/status`,
      { status },
    );
  }

  async sendMessage(
    agentId: string,
    text: string,
  ): Promise<{ reply: string; sessionId: string }> {
    return this.#request<{ reply: string; sessionId: string }>(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/messages`,
      { text },
    );
  }

  async listCrons(): Promise<CronJob[]> {
    return this.#request<CronJob[]>("GET", "/crons");
  }

  async setCronEnabled(id: string, enabled: boolean): Promise<CronJob> {
    return this.#request<CronJob>("PATCH", `/crons/${encodeURIComponent(id)}`, { enabled });
  }

  async runCron(id: string): Promise<{ runId: string }> {
    return this.#request<{ runId: string }>(
      "POST",
      `/crons/${encodeURIComponent(id)}/run`,
    );
  }

  async a2aCall(from: string, to: string, message: string): Promise<{ ok: true }> {
    return this.#request<{ ok: true }>("POST", "/a2a/call", { from, to, message });
  }

  async #request<T>(method: string, pathname: string, payload?: unknown): Promise<T> {
    const upperMethod = method.toUpperCase();
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(await signedHeaders(this.#secret, upperMethod, pathname, body)),
    };
    if (body !== "") headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#origin}${pathname}`, {
        method: upperMethod,
        headers,
        body: body === "" ? undefined : body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new HermesError(
        "unreachable",
        `${upperMethod} ${pathname} failed: ${errorMessage(error)}`,
      );
    }

    if (!response.ok) {
      // Drain the body so keep-alive sockets are reusable.
      await response.text().catch(() => "");
      throw new HermesError(
        "bad_response",
        `${upperMethod} ${pathname} returned HTTP ${response.status}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new HermesError(
        "bad_response",
        `${upperMethod} ${pathname} returned invalid JSON: ${errorMessage(error)}`,
      );
    }
  }
}
