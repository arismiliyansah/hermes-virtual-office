import type { Context, MiddlewareHandler, Next } from "hono";
import type { AuthVariables } from "./auth";

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

interface FixedWindow {
  count: number;
  resetAt: number;
}

// Module state survives between requests in the same isolate, which is what
// makes the fixed-window limiter cheap. Limits are therefore per isolate, not
// global across the Worker fleet.
const windows = new Map<string, FixedWindow>();

export function rateLimit({
  limit,
  windowMs,
}: RateLimitOptions): MiddlewareHandler {
  return (async (
    c: Context<{ Variables: AuthVariables }>,
    next: Next,
  ) => {
    const userId = c.get("userId");
    if (typeof userId !== "string" || userId.length === 0) return next();

    // Different limit configurations are independent budgets; sharing one key
    // would let the chat limiter consume the tasks limiter's window.
    const key = `${limit}:${windowMs}:${userId}`;
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
