import type { AgentStatus, Duty } from "./duty";

export type { AgentStatus, Duty } from "./duty";

export type ServerMsg =
  | {
      type: "snapshot";
      payload: { agents: { id: string; duty: AgentStatus }[]; tasks: unknown[] };
    }
  | { type: "agent_state"; payload: { agentId: string; duty: Duty } }
  | { type: "event"; payload: { text: string; ts: number } }
  | { type: "meeting_turn"; payload: { agentId: string; text: string } };
