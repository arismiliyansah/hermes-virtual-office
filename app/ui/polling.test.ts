import { cleanup } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../api";
import {
  __resetOfficeActivity,
  markChatPending,
  markCronRunning,
  markMeetingParticipants,
  officeActivity,
  overlayDuty,
} from "./officeActivity";
import {
  POLL_BACKOFF_MAX_MS,
  POLL_INTERVAL_MS,
  STALE_AFTER_MS,
  formatAge,
  staleMessage,
  useAgentPoll,
  type AgentPoll,
  type VisibilityDocument,
} from "./useAgentPoll";

function agent(id: string, status: Agent["status"] = "desk"): Agent {
  return {
    id,
    name: id,
    role: "engineer",
    color: null,
    desk: null,
    status,
  };
}

function fakeVisibility(): {
  doc: VisibilityDocument;
  setHidden: (hidden: boolean) => void;
} {
  const target = new EventTarget();
  let hidden = false;

  return {
    doc: {
      get hidden() {
        return hidden;
      },
      addEventListener: (type, listener) =>
        target.addEventListener(type, listener as EventListener),
      removeEventListener: (type, listener) =>
        target.removeEventListener(type, listener as EventListener),
    },
    setHidden: (value) => {
      hidden = value;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

function mountPoll(
  fetcher: () => Promise<Agent[]>,
  doc: VisibilityDocument,
): { poll: AgentPoll; dispose: () => void } {
  let poll!: AgentPoll;
  const dispose = createRoot((cleanupRoot) => {
    poll = useAgentPoll({ fetcher, doc });
    return cleanupRoot;
  });
  return { poll, dispose };
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetOfficeActivity();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("useAgentPoll", () => {
  it("polls every 15s and reflects a changed Hermes status", async () => {
    let call = 0;
    const responses = [[agent("damar", "desk")], [agent("damar", "review")]];
    const fetcher = vi.fn(async () => responses[Math.min(call++, 1)]);

    const { poll, dispose } = mountPoll(fetcher, fakeVisibility().doc);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(poll.agents()[0]?.status).toBe("desk");

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(poll.agents()[0]?.status).toBe("review");
    expect(poll.lastError()).toBeNull();

    dispose();
  });

  it("pauses while the tab is hidden and polls immediately when visible", async () => {
    const visibility = fakeVisibility();
    const fetcher = vi.fn(async () => [agent("damar")]);

    const { poll, dispose } = mountPoll(fetcher, visibility.doc);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    visibility.setHidden(true);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    expect(fetcher).toHaveBeenCalledTimes(1);

    visibility.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("backs off x2 on failure, caps at 60s and resets after success", async () => {
    let call = 0;
    const fetcher = vi.fn(async () => {
      call += 1;
      if (call <= 3) throw new Error("tunnel down");
      return [agent("damar")];
    });

    const { poll, dispose } = mountPoll(fetcher, fakeVisibility().doc);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(poll.lastError()).not.toBeNull();

    // First failure: next attempt is 30s, not 15s.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Second failure: 60s.
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MAX_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Third failure stays capped at 60s.
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MAX_MS);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(poll.lastError()).toBeNull();

    // Success resets the schedule to 15s.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(5);

    dispose();
  });

  it("keeps a single poll timer when consumers mount and unmount", async () => {
    const fetcher = vi.fn(async () => [agent("damar")]);

    const first = mountPoll(fetcher, fakeVisibility().doc);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Remounting replaces the timer instead of stacking another poll loop.
    first.dispose();
    const second = mountPoll(fetcher, fakeVisibility().doc);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(3);

    second.dispose();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("stale banner text", () => {
  it("formats ages in seconds and minutes", () => {
    expect(formatAge(2_000)).toBe("2 dtk");
    expect(formatAge(120_000)).toBe("2 mnt");
    expect(formatAge(3_700_000)).toBe("1 jam");
  });

  it("is silent while data is fresh", () => {
    expect(
      staleMessage({
        lastSuccessAt: 1_000,
        failed: false,
        now: 1_000 + STALE_AFTER_MS,
      }),
    ).toBeNull();
  });

  it("reports the age and an unreachable machine after a failed poll", () => {
    expect(
      staleMessage({ lastSuccessAt: 0, failed: true, now: 120_000 }),
    ).toBe("Data terakhir 2 mnt lalu — mesin tidak terjangkau");
    expect(
      staleMessage({ lastSuccessAt: null, failed: true, now: 120_000 }),
    ).toBe("Mesin tidak terjangkau — belum ada data");
  });

  it("reports stale data even without a hard failure", () => {
    expect(
      staleMessage({
        lastSuccessAt: 0,
        failed: false,
        now: STALE_AFTER_MS + 1,
      }),
    ).toMatch(/menunggu pembaruan|belum menjawab/);
  });
});

describe("office activity overlay", () => {
  it("upgrades the Hermes baseline with meeting, chat and cron activity", () => {
    const empty = officeActivity();

    expect(overlayDuty("damar", "desk", empty)).toBe("desk");
    expect(overlayDuty("damar", "unknown", empty)).toBe("unknown");

    markMeetingParticipants(["damar", "sari"]);
    expect(overlayDuty("damar", "desk", officeActivity())).toBe("meeting");
    expect(overlayDuty("bimo", "desk", officeActivity())).toBe("desk");

    markMeetingParticipants(null);
    markChatPending("bimo", true);
    expect(overlayDuty("bimo", "idle", officeActivity())).toBe("desk");

    markChatPending("bimo", false);
    markCronRunning("citra", true);
    expect(overlayDuty("citra", "review", officeActivity())).toBe("desk");

    markCronRunning("citra", false);
    expect(overlayDuty("citra", "review", officeActivity())).toBe("review");
  });

  it("only raises priority and never demotes meeting or a2a", () => {
    markChatPending("damar", true);
    markCronRunning("damar", true);

    // meeting (4) beats desk (2)
    expect(overlayDuty("damar", "meeting", officeActivity())).toBe("meeting");

    // a2a (3) beats desk (2)
    expect(overlayDuty("damar", "a2a", officeActivity())).toBe("a2a");

    // review (1) is lower than desk (2), so chat upgrades it
    expect(overlayDuty("damar", "review", officeActivity())).toBe("desk");

    // unknown is neutral, concrete activity upgrades it
    expect(overlayDuty("damar", "unknown", officeActivity())).toBe("desk");
  });

  it("meeting beats every other activity and clears cleanly", () => {
    markMeetingParticipants(["damar"]);
    markChatPending("damar", true);
    markCronRunning("damar", true);

    expect(overlayDuty("damar", "idle", officeActivity())).toBe("meeting");

    markMeetingParticipants(null);
    // Chat still pending after the meeting ends; desk until it resolves.
    expect(overlayDuty("damar", "idle", officeActivity())).toBe("desk");

    markChatPending("damar", false);
    markCronRunning("damar", false);
    expect(overlayDuty("damar", "idle", officeActivity())).toBe("idle");
  });
});
