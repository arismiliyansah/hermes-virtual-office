import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_STORAGE_KEY,
  clearCsrfToken,
  createTask,
  getCsrfToken,
  listAgents,
  listTasks,
  login,
  logout,
  me,
  sendAgentMessage,
  updateTaskStatus,
} from "./api";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(response: Response | (() => Response)) {
  const fetchMock = vi.fn(async () =>
    typeof response === "function" ? response() : response,
  );
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  localStorage.clear();
  clearCsrfToken();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("api", () => {
  it("returns null from me on 401", async () => {
    const fetchMock = stubFetch(jsonResponse({ error: "unauthorized" }, 401));

    await expect(me()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("posts the login body and keeps the csrf token in memory and storage", async () => {
    const fetchMock = stubFetch(jsonResponse({ csrf: "csrf-token-123" }));

    await login("owner@example.com", "hunter2-correct");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toEqual({
      email: "owner@example.com",
      password: "hunter2-correct",
    });
    expect(getCsrfToken()).toBe("csrf-token-123");
    expect(localStorage.getItem(CSRF_STORAGE_KEY)).toBe("csrf-token-123");
  });

  it("sends the csrf header on logout and clears the token", async () => {
    stubFetch(jsonResponse({ csrf: "csrf-token-123" }));
    await login("owner@example.com", "hunter2-correct");

    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await logout();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.method).toBe("POST");
    expect(headers.get("x-csrf-token")).toBe("csrf-token-123");
    expect(getCsrfToken()).toBeNull();
    expect(localStorage.getItem(CSRF_STORAGE_KEY)).toBeNull();
  });

  it("throws a typed error for rejected credentials", async () => {
    stubFetch(jsonResponse({ error: "invalid_credentials" }, 401));

    await expect(login("owner@example.com", "wrong")).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("api agents and tasks", () => {
  it("unwraps the agent list from GET /api/agents", async () => {
    const agents = [
      {
        id: "damar",
        name: "Damar",
        role: "Reviewer",
        color: null,
        desk: 0,
        status: "desk",
      },
    ];
    const fetchMock = stubFetch(jsonResponse({ agents }));

    await expect(listAgents()).resolves.toEqual(agents);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("posts the exact message text with the csrf header", async () => {
    stubFetch(jsonResponse({ csrf: "csrf-token-123" }));
    await login("owner@example.com", "hunter2-correct");

    const fetchMock = stubFetch(
      jsonResponse({ reply: "Halo juga", sessionId: "session-1" }),
    );

    await expect(sendAgentMessage("damar", "Halo")).resolves.toEqual({
      reply: "Halo juga",
      sessionId: "session-1",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/agents/damar/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Halo" });
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-token-123");
  });

  it("sends the exact task status body", async () => {
    stubFetch(jsonResponse({ csrf: "csrf-token-123" }));
    await login("owner@example.com", "hunter2-correct");

    const task = {
      id: "t1",
      title: "Audit tunnel",
      status: "done",
      office_label: null,
      owner_agent: "damar",
      updated_at: null,
    };
    const fetchMock = stubFetch(jsonResponse({ task }));

    await expect(updateTaskStatus("t1", "done")).resolves.toEqual(task);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/tasks/t1/status");
    expect(JSON.parse(String(init.body))).toEqual({ status: "done" });
  });

  it("unwraps tasks and creates one with an optional owner", async () => {
    stubFetch(jsonResponse({ csrf: "csrf-token-123" }));
    await login("owner@example.com", "hunter2-correct");

    const task = {
      id: "t2",
      title: "Tulis notulen",
      status: "todo",
      office_label: null,
      owner_agent: "sari",
      updated_at: null,
    };

    const listMock = stubFetch(jsonResponse({ tasks: [task] }));
    await expect(listTasks()).resolves.toEqual([task]);
    expect(listMock).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({ method: "GET" }),
    );

    const createMock = stubFetch(jsonResponse({ task }, 201));
    await expect(
      createTask({ title: "Tulis notulen", ownerAgentId: "sari" }),
    ).resolves.toEqual(task);

    const [url, init] = createMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/tasks");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Tulis notulen",
      ownerAgentId: "sari",
    });
  });
});
