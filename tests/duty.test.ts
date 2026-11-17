import { resolveAll, resolveDuty } from "../src/duty";
import type { AgentActivity } from "../src/duty";

const activity = (overrides: Partial<AgentActivity> = {}): AgentActivity => ({
  agentId: "a1",
  taskActive: false,
  liveChat: false,
  cronRunning: false,
  meetingId: null,
  a2aWith: null,
  reviewOf: null,
  ...overrides,
});

describe("resolveDuty", () => {
  it("returns idle only when every flag is false and every id is null", () => {
    expect(resolveDuty(activity())).toBe("idle");
  });

  it("returns meeting when meetingId is set, even with every other state active", () => {
    expect(
      resolveDuty(
        activity({
          meetingId: "m1",
          a2aWith: "a2",
          taskActive: true,
          liveChat: true,
          cronRunning: true,
          reviewOf: "task-9",
        }),
      ),
    ).toBe("meeting");
  });

  it("returns a2a when a2aWith is set, beating desk and review", () => {
    expect(
      resolveDuty(
        activity({
          a2aWith: "a2",
          taskActive: true,
          liveChat: true,
          cronRunning: true,
          reviewOf: "task-9",
        }),
      ),
    ).toBe("a2a");
  });

  it("returns desk for an active task, beating review", () => {
    expect(resolveDuty(activity({ taskActive: true, reviewOf: "task-9" }))).toBe("desk");
  });

  it("returns desk for a live chat, beating review", () => {
    expect(resolveDuty(activity({ liveChat: true, reviewOf: "task-9" }))).toBe("desk");
  });

  it("returns desk for a running cron, beating review", () => {
    expect(resolveDuty(activity({ cronRunning: true, reviewOf: "task-9" }))).toBe("desk");
  });

  it("returns review when only reviewOf is set", () => {
    expect(resolveDuty(activity({ reviewOf: "task-9" }))).toBe("review");
  });

  it("is deterministic and does not mutate its input", () => {
    const input = Object.freeze(
      activity({ taskActive: true, meetingId: "m1", reviewOf: "task-9" }),
    );

    expect(resolveDuty(input)).toBe("meeting");
    expect(resolveDuty(input)).toBe("meeting");
    expect(input).toEqual(
      activity({ taskActive: true, meetingId: "m1", reviewOf: "task-9" }),
    );
  });
});

describe("resolveAll", () => {
  it("maps every agent id to its own duty", () => {
    const agents = [
      activity({ agentId: "meeter", meetingId: "m1", taskActive: true }),
      activity({ agentId: "caller", a2aWith: "meeter" }),
      activity({ agentId: "worker", cronRunning: true }),
      activity({ agentId: "checker", reviewOf: "task-9" }),
      activity({ agentId: "lounger" }),
    ];

    expect(resolveAll(agents)).toEqual({
      meeter: "meeting",
      caller: "a2a",
      worker: "desk",
      checker: "review",
      lounger: "idle",
    });
  });

  it("returns an empty record for no agents", () => {
    expect(resolveAll([])).toEqual({});
  });

  it("does not mutate the input list", () => {
    const agents = [activity({ agentId: "a1", liveChat: true })];
    const snapshot = structuredClone(agents);

    resolveAll(agents);

    expect(agents).toEqual(snapshot);
  });
});
