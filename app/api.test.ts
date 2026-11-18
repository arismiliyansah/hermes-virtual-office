import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_STORAGE_KEY,
  clearCsrfToken,
  getCsrfToken,
  login,
  logout,
  me,
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
