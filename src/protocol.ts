import type { Duty } from "./duty";

export type { Duty } from "./duty";

export type ServerMsg =
  | {
      type: "snapshot";
      payload: { agents: { id: string; duty: Duty }[]; tasks: unknown[] };
    }
  | { type: "agent_state"; payload: { agentId: string; duty: Duty } }
  | { type: "event"; payload: { text: string; ts: number } }
  | { type: "meeting_turn"; payload: { agentId: string; text: string } };
