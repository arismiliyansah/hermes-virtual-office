import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMsg } from "../../src/protocol";
import type { Agent, MeetingResult } from "../api";
import { NIGHT } from "../scene/palette";
import { themeStorageKey } from "../theme";
import { CronPanel } from "./CronPanel";
import { MeetingPanel } from "./MeetingPanel";
import { backoffMs, useOffice } from "./useOffice";

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  listAgents: vi.fn(),
  sendAgentMessage: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  startMeeting: vi.fn(),
  getMeeting: vi.fn(),
  listCrons: vi.fn(),
  setCronEnabled: vi.fn(),
  runCron: vi.fn(),
}));

vi.mock("../api", () => mocks);

const sceneMock = vi.hoisted(() => ({
  createScene: vi.fn(),
  draw: vi.fn(),
}));

vi.mock("../scene/renderer", () => ({
  createScene: sceneMock.createScene,
}));

import App from "../App";

const AGENTS: Agent[] = [
  {
    id: "damar",
    name: "Damar",
    role: "Reviewer",
    color: "#6f9a63",
    desk: 0,
    status: "desk",
  },
  {
    id: "sari",
    name: "Sari",
    role: "Engineer",
    color: "#4f7fa8",
    desk: 1,
    status: "meeting",
  },
];

const MEETING: MeetingResult = {
  meeting: {
    id: "meeting-1",
    title: "Rapat harian",
    room: "Ruang Kaca",
    status: "done",
    created_at: null,
  },
  minutes: [
    {
      id: "minute-1",
      meeting_id: "meeting-1",
      content: "Notulen: rilis ditunda besok.",
      created_at: null,
    },
  ],
};

class FakeSocket {
  static instances: FakeSocket[] = [];

  readonly url: string;
  readyState = 0;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(payload: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  send(): void {
    // The office protocol is server-owned; no client frames are expected.
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);

  mocks.me.mockResolvedValue({ userId: "owner-1" });
  mocks.listAgents.mockResolvedValue(AGENTS);
  mocks.listTasks.mockResolvedValue([]);
  mocks.startMeeting.mockResolvedValue(MEETING);
  mocks.getMeeting.mockResolvedValue(MEETING);
  mocks.listCrons.mockResolvedValue([
    {
      id: "nightly",
      name: "Cron nightly",
      schedule: "0 2 * * *",
      enabled: true,
      agentId: "damar",
    },
  ]);
  mocks.setCronEnabled.mockResolvedValue({
    id: "nightly",
    name: "Cron nightly",
    schedule: "0 2 * * *",
    enabled: false,
    agentId: "damar",
  });
  mocks.runCron.mockResolvedValue({ runId: "run-1" });
  sceneMock.createScene.mockReturnValue({
    draw: sceneMock.draw,
    hitTest: vi.fn(() => null),
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.dataset.theme = "day";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("backoffMs", () => {
  it("(a) doubles from 500ms and caps at 15s", () => {
    expect([0, 1, 2, 3, 4].map(backoffMs)).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
    expect(backoffMs(5)).toBe(15_000);
    expect(backoffMs(20)).toBe(15_000);
  });
});

describe("useOffice", () => {
  it("(b) marks the connection down and reconnects with backoff after a close", () => {
    vi.useFakeTimers();

    let office!: ReturnType<typeof useOffice>;
    const dispose = createRoot((cleanupRoot) => {
      office = useOffice();
      return cleanupRoot;
    });

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toMatch(/\/api\/ws$/);
    expect(office.connected()).toBe(false);

    FakeSocket.instances[0].open();
    expect(office.connected()).toBe(true);

    FakeSocket.instances[0].serverClose();
    expect(office.connected()).toBe(false);

    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    // A successful reconnect resets the delay to 500ms.
    FakeSocket.instances[1].open();
    FakeSocket.instances[1].serverClose();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    dispose();
    expect(FakeSocket.instances[2].closed).toBe(true);
  });

  it("hydrates snapshot, agent_state, events and meeting_turn frames", () => {
    let office!: ReturnType<typeof useOffice>;
    const dispose = createRoot((cleanupRoot) => {
      office = useOffice();
      return cleanupRoot;
    });

    const socket = FakeSocket.instances[0];
    socket.open();
    socket.message({
      type: "snapshot",
      payload: {
        agents: [
          { id: "damar", duty: "desk" },
          { id: "sari", duty: "meeting" },
        ],
        tasks: [],
      },
    });
    expect(office.agents()).toEqual({ damar: "desk", sari: "meeting" });

    socket.message({
      type: "agent_state",
      payload: { agentId: "damar", duty: "a2a" },
    });
    expect(office.agents()).toEqual({ damar: "a2a", sari: "meeting" });

    socket.message({
      type: "meeting_turn",
      payload: { agentId: "sari", text: "Saya setuju." },
    });
    expect(office.meetingTurn()).toEqual({
      agentId: "sari",
      text: "Saya setuju.",
    });

    for (let index = 0; index <= 20; index += 1) {
      socket.message({
        type: "event",
        payload: { text: `event ${index}`, ts: index },
      });
    }
    expect(office.events()).toHaveLength(20);
    expect(office.events()[0]).toEqual({ text: "event 20", ts: 20 });
    expect(office.events()[19]).toEqual({ text: "event 1", ts: 1 });

    dispose();
  });
});

describe("MeetingPanel", () => {
  it("(c) highlights the agent speaking over the websocket and starts a meeting", async () => {
    const [turn, setTurn] = createSignal<{
      agentId: string;
      text: string;
    } | null>({ agentId: "sari", text: "Pendapat Sari" });

    render(() => <MeetingPanel meetingTurn={turn()} />);

    const sari = await screen.findByRole("button", { name: "Pilih Sari" });
    expect(sari.getAttribute("data-speaking")).toBe("true");
    expect(screen.getByTestId("meeting-turn").textContent).toContain(
      "Pendapat Sari",
    );

    setTurn({ agentId: "damar", text: "Pendapat Damar" });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Pilih Damar" }).getAttribute(
          "data-speaking",
        ),
      ).toBe("true");
    });
    expect(sari.getAttribute("data-speaking")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pilih Damar" }));
    fireEvent.click(screen.getByRole("button", { name: "Pilih Sari" }));
    fireEvent.click(screen.getByRole("button", { name: "Mulai meeting" }));

    await waitFor(() => {
      expect(mocks.startMeeting).toHaveBeenCalledWith({
        title: "Rapat harian",
        participantIds: ["damar", "sari"],
      });
    });

    expect(await screen.findByText("Notulen: rilis ditunda besok.")).toBeTruthy();
    expect(screen.getByText(/Peserta: Damar, Sari/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Akhiri meeting" }));
    await waitFor(() => {
      expect(mocks.getMeeting).toHaveBeenCalledWith("meeting-1");
    });
  });

  it("requires at least two participants before starting", async () => {
    render(() => <MeetingPanel />);

    await screen.findByRole("button", { name: "Pilih Damar" });
    const start = screen.getByRole("button", { name: "Mulai meeting" });
    expect(start.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Pilih Damar" }));
    expect(start.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Pilih Sari" }));
    expect(start.hasAttribute("disabled")).toBe(false);
  });
});

describe("CronPanel", () => {
  it("(d) reverts an optimistic toggle and shows an error row when the API fails", async () => {
    let rejectToggle!: (cause: unknown) => void;
    mocks.setCronEnabled.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectToggle = reject;
      }),
    );

    render(() => <CronPanel />);

    const toggle = await screen.findByRole("switch", { name: "Cron nightly" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
    expect(mocks.setCronEnabled).toHaveBeenCalledWith("nightly", false);

    rejectToggle(new Error("offline"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/gagal mengubah cron/i);
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("runs a cron job from the row", async () => {
    render(() => <CronPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Jalankan Cron nightly" }),
    );

    await waitFor(() => {
      expect(mocks.runCron).toHaveBeenCalledWith("nightly");
    });
    expect(await screen.findByText(/run-1/)).toBeTruthy();
  });
});

describe("App realtime, theme and roster", () => {
  it("(f) applies the stored theme to the document and the scene palette", async () => {
    localStorage.clear();
    document.documentElement.dataset.theme = "day";

    render(() => <App />);

    await screen.findByText("Hermes Office");
    expect(document.documentElement.dataset.theme).toBe("day");

    fireEvent.click(screen.getByRole("button", { name: "Malam" }));

    expect(document.documentElement.dataset.theme).toBe("night");
    expect(localStorage.getItem(themeStorageKey)).toBe("night");
    await waitFor(() => {
      const options = sceneMock.createScene.mock.calls.at(-1)?.[1];
      expect(options?.palette).toBe(NIGHT);
    });
  });

  it("uses the websocket snapshot once the hub connects", async () => {
    render(() => <App />);

    await screen.findByTestId("office-canvas");
    const socket = FakeSocket.instances.at(-1);
    expect(socket).toBeTruthy();

    socket?.open();
    socket?.message({
      type: "snapshot",
      payload: {
        agents: [
          { id: "damar", duty: "review" },
          { id: "sari", duty: "a2a" },
        ],
        tasks: [],
      },
    });

    await waitFor(() => {
      const last = sceneMock.draw.mock.calls.at(-1)?.[0];
      expect(last?.agents).toEqual([
        { id: "damar", duty: "review" },
        { id: "sari", duty: "a2a" },
      ]);
    });
  });

  it("opens the chat for the agent picked from the dock roster", async () => {
    render(() => <App />);

    fireEvent.click(await screen.findByRole("button", { name: "Chat Sari" }));

    expect(
      await screen.findByLabelText("Percakapan dengan Sari"),
    ).toBeTruthy();
  });

  it("opens the chat for the agent clicked on the scene canvas", async () => {
    sceneMock.createScene.mockReturnValue({
      draw: sceneMock.draw,
      hitTest: () => "sari",
    });

    render(() => <App />);

    const canvas = await screen.findByTestId("office-canvas");
    fireEvent.click(canvas, { clientX: 24, clientY: 24 });

    expect(
      await screen.findByLabelText("Percakapan dengan Sari"),
    ).toBeTruthy();
  });
});
