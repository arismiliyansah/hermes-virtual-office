import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { Duty, ServerMsg } from "../../src/protocol";

export const MAX_EVENTS = 20;
export const MAX_BACKOFF_MS = 15_000;

export interface OfficeEvent {
  text: string;
  ts: number;
}

export interface MeetingTurn {
  agentId: string;
  text: string;
}

export interface OfficeState {
  connected: Accessor<boolean>;
  agents: Accessor<Record<string, Duty>>;
  events: Accessor<OfficeEvent[]>;
  meetingTurn: Accessor<MeetingTurn | null>;
  clearMeetingTurn: () => void;
}

export interface UseOfficeOptions {
  url?: string;
  socketFactory?: (url: string) => WebSocket;
}

/** Exponential reconnect delay: 500ms, 1s, 2s, ... capped at 15s. */
export function backoffMs(attempt: number): number {
  const safeAttempt =
    Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** safeAttempt);
}

function socketUrl(): string {
  if (typeof location === "undefined") return "ws://localhost/api/ws";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/ws`;
}

function parseFrame(raw: unknown): ServerMsg | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (typeof parsed?.type !== "string") return null;
    return parsed as ServerMsg;
  } catch {
    return null;
  }
}

/**
 * Keeps the office snapshot in sync with the Durable Object hub. The socket
 * reconnects on its own; components only read the exposed accessors.
 */
export function useOffice(options: UseOfficeOptions = {}): OfficeState {
  const [connected, setConnected] = createSignal(false);
  const [agents, setAgents] = createSignal<Record<string, Duty>>({});
  const [events, setEvents] = createSignal<OfficeEvent[]>([]);
  const [meetingTurn, setMeetingTurn] = createSignal<MeetingTurn | null>(null);

  const url = options.url ?? socketUrl();
  const factory =
    options.socketFactory ?? ((target: string) => new WebSocket(target));

  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let disposed = false;

  function apply(message: ServerMsg): void {
    if (message.type === "snapshot") {
      const next: Record<string, Duty> = {};
      for (const agent of message.payload.agents) next[agent.id] = agent.duty;
      setAgents(next);
    } else if (message.type === "agent_state") {
      setAgents((previous) => ({
        ...previous,
        [message.payload.agentId]: message.payload.duty,
      }));
    } else if (message.type === "event") {
      setEvents((previous) => [message.payload, ...previous].slice(0, MAX_EVENTS));
    } else if (message.type === "meeting_turn") {
      setMeetingTurn(message.payload);
    }
  }

  function scheduleReconnect(): void {
    if (disposed || timer !== undefined) return;
    const delay = backoffMs(attempt);
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, delay);
  }

  function connect(): void {
    if (disposed) return;

    let next: WebSocket;
    try {
      next = factory(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket = next;

    next.onopen = () => {
      if (socket !== next) return;
      attempt = 0;
      setConnected(true);
    };

    next.onmessage = (event: MessageEvent) => {
      if (socket !== next) return;
      const message = parseFrame(event.data);
      if (message !== null) apply(message);
    };

    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      setConnected(false);
      scheduleReconnect();
    };

    // Browsers fire close after an error; reconnection is handled there.
    next.onerror = () => {};
  }

  connect();

  onCleanup(() => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const current = socket;
    socket = null;
    setConnected(false);
    current?.close();
  });

  return {
    connected,
    agents,
    events,
    meetingTurn,
    clearMeetingTurn: () => setMeetingTurn(null),
  };
}
