import { createSignal, type Accessor } from "solid-js";
import { resolveDuty, type AgentStatus } from "../../src/duty";

/**
 * Live office activity, owned by the panels that know about it. The scene
 * overlays this on the Hermes baseline: a meeting participant is "meeting"
 * even if Hermes still says "desk", a pending chat or cron run means "desk".
 */
export interface OfficeActivity {
  meetingParticipants: string[];
  pendingChats: string[];
  runningCrons: string[];
}

function emptyActivity(): OfficeActivity {
  return {
    meetingParticipants: [],
    pendingChats: [],
    runningCrons: [],
  };
}

const [activity, setActivity] = createSignal<OfficeActivity>(emptyActivity());

export const officeActivity: Accessor<OfficeActivity> = activity;

function without(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : list;
}

export function markMeetingParticipants(ids: string[] | null): void {
  setActivity((previous) => ({
    ...previous,
    meetingParticipants: ids === null ? [] : [...ids],
  }));
}

export function markChatPending(agentId: string, pending: boolean): void {
  setActivity((previous) => ({
    ...previous,
    pendingChats: pending
      ? [...new Set([...previous.pendingChats, agentId])]
      : without(previous.pendingChats, agentId),
  }));
}

export function markCronRunning(agentId: string, running: boolean): void {
  setActivity((previous) => ({
    ...previous,
    runningCrons: running
      ? [...new Set([...previous.runningCrons, agentId])]
      : without(previous.runningCrons, agentId),
  }));
}

/** Test hook; module signals otherwise survive between components. */
export function __resetOfficeActivity(): void {
  setActivity(emptyActivity());
}

export function overlayDuty(
  agentId: string,
  base: AgentStatus,
  current: OfficeActivity,
): AgentStatus {
  const duty = resolveDuty({
    agentId,
    taskActive: false,
    liveChat: current.pendingChats.includes(agentId),
    cronRunning: current.runningCrons.includes(agentId),
    meetingId: current.meetingParticipants.includes(agentId) ? "active" : null,
    a2aWith: null,
    reviewOf: null,
  });

  // The Hermes status is the baseline; activity only upgrades it.
  return duty === "idle" ? base : duty;
}
