import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";

export const SESSION_COOKIE = "__Host-session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;
const encoder = new TextEncoder();

export interface AuthBindings {
  SESSION_SECRET: string;
}

export interface AuthVariables {
  userId: string;
}

// `__Host-` forces Secure + Path=/ + no Domain. Secure cookies are accepted on
// http://localhost (loopback) by modern browsers, so dev login still works.
export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

// --- HMAC-SHA256 ----------------------------------------------------------

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );

  return new Uint8Array(signature);
}

// --- Passwords ------------------------------------------------------------

async function derivePbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

interface ParsedHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return null;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return null;

  const salt = fromBase64Url(parts[2]);
  const hash = fromBase64Url(parts[3]);
  if (salt === null || hash === null || salt.length === 0 || hash.length === 0) {
    return null;
  }

  return { iterations, salt, hash };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await derivePbkdf2(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_BYTES,
  );

  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === null) return false;

  try {
    const hash = await derivePbkdf2(
      password,
      parsed.salt,
      parsed.iterations,
      parsed.hash.length,
    );
    return timingSafeEqual(hash, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * A real PBKDF2 hash for a password nobody uses. Unknown emails verify
 * against it so a login attempt costs the same as a wrong password; skipping
 * the derivation would leak account existence through response time.
 */
const DUMMY_PASSWORD_HASH =
  "pbkdf2$100000$ZlzbILMIqyPRiddAHW4WGg$f_ajVGRLukWEHgbO3kzy0rV4baWpL0doiOBepllV0zw";

export async function verifyPasswordOrDummy(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (stored === null || stored === undefined || stored.length === 0) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return false;
  }

  return verifyPassword(password, stored);
}

// --- Sessions -------------------------------------------------------------

interface SessionPayload {
  uid: string;
  csrf: string;
  exp: number;
}

export interface StartedSession {
  token: string;
  csrf: string;
}

export async function startSession(
  userId: string,
  secret: string,
  now: Date = new Date(),
): Promise<StartedSession> {
  const csrf = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const payload: SessionPayload = {
    uid: userId,
    csrf,
    exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
  };

  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = toBase64Url(await hmacSha256(secret, body));

  return { token: `${body}.${signature}`, csrf };
}

export async function createSession(
  userId: string,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  return (await startSession(userId, secret, now)).token;
}

export async function readSession(
  value: string | null | undefined,
  secret: string,
  now: Date = new Date(),
): Promise<{ userId: string; csrf: string } | null> {
  if (!value) return null;

  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return null;

  const body = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = toBase64Url(await hmacSha256(secret, body));
  if (!timingSafeStringEqual(signature, expected)) return null;

  const payloadBytes = fromBase64Url(body);
  if (payloadBytes === null) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const { uid, csrf, exp } = payload as Partial<SessionPayload>;
  if (typeof uid !== "string" || uid.length === 0) return null;
  if (typeof csrf !== "string" || csrf.length === 0) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp <= Math.floor(now.getTime() / 1000)) return null;

  return { userId: uid, csrf };
}

// --- Middleware -----------------------------------------------------------

const DEV_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Deployments must replace the checked-in dev secret. The guard fails closed
 * on every API route except health, while localhost stays usable with the
 * wrangler dev vars.
 */
export function sessionSecretReady(secret: string | undefined): boolean {
  const value = (secret ?? "").trim();
  return value.length > 0 && value !== "dev-secret";
}

export function isDevHostname(hostname: string): boolean {
  return DEV_HOSTNAMES.has(hostname.toLowerCase());
}

export function secureSessionGuard(): MiddlewareHandler {
  const middleware = async (
    c: Context<{ Bindings: AuthBindings }>,
    next: Next,
  ) => {
    if (sessionSecretReady(c.env.SESSION_SECRET)) return next();

    const hostname = new URL(c.req.url).hostname;
    if (isDevHostname(hostname)) return next();

    return c.json({ error: "insecure_session_secret" }, 503);
  };

  return middleware as MiddlewareHandler;
}

export function requireAuth(secret: string): MiddlewareHandler {
  const middleware = async (
    c: Context<{ Bindings: AuthBindings; Variables: AuthVariables }>,
    next: Next,
  ) => {
    const session = await readSession(getCookie(c, SESSION_COOKIE), secret);
    if (session === null) {
      return c.json({ error: "unauthorized" }, 401);
    }

    c.set("userId", session.userId);
    await next();
  };

  return middleware as MiddlewareHandler;
}

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function csrfProtection(): MiddlewareHandler {
  const middleware = async (
    c: Context<{ Bindings: AuthBindings }>,
    next: Next,
  ) => {
    if (!MUTATION_METHODS.has(c.req.method)) return next();
    if (c.req.method === "POST" && c.req.path === "/api/auth/login") {
      return next();
    }

    const session = await readSession(
      getCookie(c, SESSION_COOKIE),
      c.env.SESSION_SECRET,
    );
    const token = c.req.header("x-csrf-token");

    if (
      session === null ||
      token === undefined ||
      token.length === 0 ||
      !timingSafeStringEqual(token, session.csrf)
    ) {
      return c.json({ error: "csrf" }, 403);
    }

    await next();
  };

  return middleware as MiddlewareHandler;
}
