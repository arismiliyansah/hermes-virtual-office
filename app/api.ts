export const CSRF_STORAGE_KEY = "hermes-office-csrf";

export interface MeResponse {
  userId: string;
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

  return fetch(path, {
    method,
    credentials: "include",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
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
