export type Duty = "meeting" | "a2a" | "desk" | "review" | "idle";

export interface AgentActivity {
  agentId: string;
  taskActive: boolean;
  liveChat: boolean;
  cronRunning: boolean;
  meetingId: string | null;
  a2aWith: string | null;
  reviewOf: string | null;
}

export const resolveDuty = (a: AgentActivity): Duty => {
  if (a.meetingId !== null) return "meeting";
  if (a.a2aWith !== null) return "a2a";
  if (a.taskActive || a.liveChat || a.cronRunning) return "desk";
  if (a.reviewOf !== null) return "review";
  return "idle";
};

export const resolveAll = (acts: AgentActivity[]): Record<string, Duty> => {
  const duties: Record<string, Duty> = {};
  for (const a of acts) duties[a.agentId] = resolveDuty(a);
  return duties;
};
