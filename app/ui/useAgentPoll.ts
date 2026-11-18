import { createSignal, onCleanup, type Accessor } from "solid-js";
import * as api from "../api";
import type { Agent } from "../api";

export const POLL_INTERVAL_MS = 15_000;
export const POLL_BACKOFF_MAX_MS = 60_000;
export const STALE_AFTER_MS = 45_000;
const CLOCK_TICK_MS = 1_000;

export interface VisibilityDocument {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface AgentPollOptions {
  fetcher?: () => Promise<Agent[]>;
  doc?: VisibilityDocument | null;
  now?: () => number;
  intervalMs?: number;
  backoffMaxMs?: number;
}

export interface AgentPoll {
  agents: Accessor<Agent[]>;
  lastSuccessAt: Accessor<number | null>;
  lastError: Accessor<string | null>;
  /** Reactive clock used by the stale banner. */
  now: Accessor<number>;
  stop: () => void;
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} dtk`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} mnt`;
  const hours = Math.floor(minutes / 60);
  return `${hours} jam`;
}

export interface StaleInput {
  lastSuccessAt: number | null;
  failed: boolean;
  now: number;
}

/**
 * Banner text for a mirror that is older than 45s or whose latest poll
 * failed. Null means the data is fresh enough to trust silently.
 */
export function staleMessage({
  lastSuccessAt,
  failed,
  now,
}: StaleInput): string | null {
  const age =
    lastSuccessAt === null
      ? null
      : formatAge(Math.max(0, now - lastSuccessAt));
  const stale = age !== null && now - (lastSuccessAt ?? 0) > STALE_AFTER_MS;

  if (failed) {
    return age === null
      ? "Mesin tidak terjangkau — belum ada data"
      : `Data terakhir ${age} lalu — mesin tidak terjangkau`;
  }

  if (stale && age !== null) {
    return `Data terakhir ${age} lalu — mesin belum menjawab`;
  }

  return null;
}

/**
 * Adaptive REST polling. One timer owns the schedule: no overlapping polls,
 * paused while the tab is hidden, doubling from 15s up to 60s on failure and
 * reset to 15s after the first success.
 */
export function useAgentPoll(options: AgentPollOptions = {}): AgentPoll {
  const fetcher = options.fetcher ?? (() => api.listAgents());
  const doc =
    options.doc === undefined
      ? typeof document === "undefined"
        ? null
        : document
      : options.doc;
  const clock = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const backoffMaxMs = options.backoffMaxMs ?? POLL_BACKOFF_MAX_MS;

  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [lastSuccessAt, setLastSuccessAt] = createSignal<number | null>(null);
  const [lastError, setLastError] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(clock());

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let failures = 0;
  let running = false;
  let disposed = false;

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delayMs: number): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
  }

  function isHidden(): boolean {
    return doc?.hidden === true;
  }

  async function run(): Promise<void> {
    if (disposed || isHidden() || running) return;

    running = true;
    try {
      const list = await fetcher();
      if (disposed) return;
      setAgents(Array.isArray(list) ? list : []);
      setLastSuccessAt(clock());
      setNow(clock());
      setLastError(null);
      failures = 0;
    } catch {
      if (disposed) return;
      setLastError("poll_failed");
      failures += 1;
    } finally {
      running = false;
      if (!disposed && !isHidden()) {
        const delay =
          failures === 0
            ? intervalMs
            : Math.min(backoffMaxMs, intervalMs * 2 ** failures);
        schedule(delay);
      }
    }
  }

  function onVisibility(): void {
    if (disposed) return;
    if (isHidden()) {
      clearTimer();
      return;
    }
    // Returning to the tab should not wait out the old delay.
    schedule(0);
  }

  doc?.addEventListener("visibilitychange", onVisibility);
  ticker = setInterval(() => setNow(clock()), CLOCK_TICK_MS);

  const stop = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimer();
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
    doc?.removeEventListener("visibilitychange", onVisibility);
  };

  onCleanup(stop);

  void run();

  return { agents, lastSuccessAt, lastError, now, stop };
}
