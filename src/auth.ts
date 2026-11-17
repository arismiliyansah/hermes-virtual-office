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

// --- SHA-256 / HMAC-SHA256 (synchronous) ---------------------------------
// Sessions are signed synchronously because createSession/readSession are
// synchronous APIs; WebCrypto's HMAC is async-only.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLength = message.length * 8;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) digestView.setUint32(i * 4, h[i]);

  return digest;
}

function hmacSha256(secret: string, message: string): Uint8Array {
  const blockSize = 64;
  let key = encoder.encode(secret);
  if (key.length > blockSize) key = sha256(key);

  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(key);

  const inner = new Uint8Array(blockSize + message.length);
  const outer = new Uint8Array(blockSize + 32);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = paddedKey[i] ^ 0x36;
    outer[i] = paddedKey[i] ^ 0x5c;
  }
  inner.set(encoder.encode(message), blockSize);
  outer.set(sha256(inner), blockSize);

  return sha256(outer);
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

export function startSession(
  userId: string,
  secret: string,
  now: Date = new Date(),
): StartedSession {
  const csrf = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const payload: SessionPayload = {
    uid: userId,
    csrf,
    exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
  };

  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = toBase64Url(hmacSha256(secret, body));

  return { token: `${body}.${signature}`, csrf };
}

export function createSession(
  userId: string,
  secret: string,
  now: Date = new Date(),
): string {
  return startSession(userId, secret, now).token;
}

export function readSession(
  value: string | null | undefined,
  secret: string,
  now: Date = new Date(),
): { userId: string; csrf: string } | null {
  if (!value) return null;

  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return null;

  const body = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = toBase64Url(hmacSha256(secret, body));
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

export function requireAuth(secret: string): MiddlewareHandler {
  const middleware = async (
    c: Context<{ Bindings: AuthBindings; Variables: AuthVariables }>,
    next: Next,
  ) => {
    const session = readSession(getCookie(c, SESSION_COOKIE), secret);
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

    const session = readSession(
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
