import type { Context, MiddlewareHandler, Next } from "hono";
import type { AuthVariables } from "./auth";

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /**
   * Route-family namespace. Two routes with the same limit configuration must
   * still own separate budgets, otherwise hitting chat would consume tasks.
   */
  scope?: string;
  /**
   * Budget subject. Defaults to the authenticated user id. Routes reachable
   * before login (auth) pass their own subject, usually the client IP.
   */
  subject?: (c: Context<{ Variables: AuthVariables }>) => string | null;
}

interface FixedWindow {
  count: number;
  resetAt: number;
}

// Module state survives between requests in the same isolate, which is what
// makes the fixed-window limiter cheap. Limits are therefore per isolate, not
// global across the Worker fleet.
const windows = new Map<string, FixedWindow>();

/** Cloudflare's trusted client IP header, with a stable fallback for tests. */
export function clientIp(
  c: Context<{ Variables: AuthVariables }>,
): string {
  const header = c.req.header("cf-connecting-ip")?.trim();
  return header !== undefined && header.length > 0 ? header : "unknown";
}

export function rateLimit({
  limit,
  windowMs,
  scope = "default",
  subject,
}: RateLimitOptions): MiddlewareHandler {
  return (async (
    c: Context<{ Variables: AuthVariables }>,
    next: Next,
  ) => {
    const keySubject =
      subject === undefined ? (c.get("userId") ?? null) : subject(c);
    if (typeof keySubject !== "string" || keySubject.length === 0) return next();

    const key = `${scope}:${limit}:${windowMs}:${keySubject}`;
    const now = Date.now();
    let window = windows.get(key);
    if (window === undefined || now >= window.resetAt) {
      window = { count: 0, resetAt: now + windowMs };
      windows.set(key, window);
    }
    window.count += 1;

    if (window.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limited" }, 429);
    }

    await next();
  }) as MiddlewareHandler;
}

/** Test-only hook: forget every window so a spec starts from a clean slate. */
export function __resetRateLimit(): void {
  windows.clear();
}
