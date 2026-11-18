import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Task } from "../api";
import { ChatPanel } from "./ChatPanel";
import { KanbanPanel } from "./KanbanPanel";

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  listAgents: vi.fn(),
  sendAgentMessage: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

const sceneMock = vi.hoisted(() => ({
  createScene: vi.fn(),
  draw: vi.fn(),
}));

vi.mock("../api", () => mocks);

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
    color: null,
    desk: 1,
    status: "meeting",
  },
];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Audit tunnel",
    status: "review",
    office_label: null,
    owner_agent: "damar",
    updated_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.listAgents.mockResolvedValue(AGENTS);
  mocks.listTasks.mockResolvedValue([]);
  mocks.sendAgentMessage.mockResolvedValue({
    reply: "Siap, kukerjakan.",
    sessionId: "session-1",
  });
  mocks.updateTaskStatus.mockResolvedValue(task({ status: "done" }));
  mocks.createTask.mockResolvedValue(task({ id: "t2", status: "todo" }));
  sceneMock.createScene.mockReturnValue({ draw: sceneMock.draw });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ChatPanel", () => {
  it("sends the message text and shows the reply", async () => {
    let resolveReply!: (value: { reply: string; sessionId: string }) => void;
    mocks.sendAgentMessage.mockReturnValue(
      new Promise((resolve) => {
        resolveReply = resolve;
      }),
    );

    render(() => <ChatPanel />);

    const input = await screen.findByLabelText("Pesan");
    fireEvent.input(input, { target: { value: "Halo Damar" } });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    await waitFor(() => {
      expect(mocks.sendAgentMessage).toHaveBeenCalledWith("damar", "Halo Damar");
    });
    expect(screen.getByTestId("chat-typing")).toBeTruthy();

    resolveReply({ reply: "Halo juga, ada yang bisa kubantu?", sessionId: "s-1" });

    expect(
      await screen.findByText("Halo juga, ada yang bisa kubantu?"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("chat-typing")).toBeNull());
  });

  it("switches the conversation when another agent card is picked", async () => {
    render(() => <ChatPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Pilih Sari" }));
    const input = screen.getByLabelText("Pesan");
    fireEvent.input(input, { target: { value: "Halo Sari" } });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    await waitFor(() => {
      expect(mocks.sendAgentMessage).toHaveBeenCalledWith("sari", "Halo Sari");
    });
  });

  it("shows an API failure as a message row instead of crashing", async () => {
    mocks.sendAgentMessage.mockRejectedValue(new Error("network down"));

    render(() => <ChatPanel />);

    const input = await screen.findByLabelText("Pesan");
    fireEvent.input(input, { target: { value: "Halo Damar" } });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/gagal mengirim/i);
    expect(screen.getByLabelText("Pesan")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kirim" })).toBeTruthy();
  });
});

describe("KanbanPanel", () => {
  it("shows an office label in amber and keeps unknown statuses in the first column", async () => {
    mocks.listTasks.mockResolvedValue([
      task({
        id: "t-label",
        title: "Audit tunnel",
        status: "blocked",
        office_label: "menunggu review",
      }),
    ]);

    const view = render(() => <KanbanPanel />);

    expect(await screen.findByText("Audit tunnel")).toBeTruthy();
    const label = screen.getByTestId("office-label");
    expect(label.textContent).toBe("menunggu review");
    expect(label.className).toMatch(/amber|e6c88a|f8e9c9/i);

    const todo = view.container.querySelector('[data-column="todo"]');
    expect(todo?.textContent).toContain("Audit tunnel");
    expect(todo?.textContent).toContain("blocked");
    expect(screen.getByTestId("status-chip").textContent).toBe("blocked");
  });

  it("approves a review card with status done and moves it to Done after refresh", async () => {
    mocks.listTasks
      .mockResolvedValueOnce([task({ status: "review" })])
      .mockResolvedValueOnce([task({ status: "done" })]);

    const view = render(() => <KanbanPanel />);

    await screen.findByText("Audit tunnel");
    const review = view.container.querySelector('[data-column="review"]');
    expect(review).toBeTruthy();
    fireEvent.click(within(review as HTMLElement).getByRole("button", { name: "Setujui" }));

    await waitFor(() => {
      expect(mocks.updateTaskStatus).toHaveBeenCalledWith("t1", "done");
    });
    await waitFor(() => {
      expect(mocks.listTasks).toHaveBeenCalledTimes(2);
    });

    const done = view.container.querySelector('[data-column="done"]');
    expect(done?.textContent).toContain("Audit tunnel");
  });

  it("shows Setujui on a review card", async () => {
    mocks.listTasks.mockResolvedValue([task({ status: "review" })]);

    const view = render(() => <KanbanPanel />);

    await screen.findByText("Audit tunnel");
    const review = view.container.querySelector('[data-column="review"]');
    expect(
      within(review as HTMLElement).getByRole("button", { name: "Setujui" }),
    ).toBeTruthy();
  });

  it("shows Setujui for a labelled card whose status is not done", async () => {
    mocks.listTasks.mockResolvedValue([
      task({ status: "doing", office_label: "perlu persetujuan" }),
    ]);

    const view = render(() => <KanbanPanel />);

    await screen.findByText("Audit tunnel");
    const doing = view.container.querySelector('[data-column="doing"]');
    expect(
      within(doing as HTMLElement).getByRole("button", { name: "Setujui" }),
    ).toBeTruthy();
  });

  it("hides Setujui on a done card that still carries an office label", async () => {
    mocks.listTasks.mockResolvedValue([
      task({ status: "done", office_label: "arsip" }),
    ]);

    const view = render(() => <KanbanPanel />);

    await screen.findByText("Audit tunnel");
    const done = view.container.querySelector('[data-column="done"]');
    expect(
      within(done as HTMLElement).queryByRole("button", { name: "Setujui" }),
    ).toBeNull();
    expect(screen.getByTestId("office-label").textContent).toBe("arsip");
  });

  it("creates a task from the compact form with a title and owner", async () => {
    mocks.listTasks
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task({ id: "t2", status: "todo" })]);

    render(() => <KanbanPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Tugas baru" }));
    fireEvent.input(screen.getByLabelText("Judul tugas"), {
      target: { value: "Tulis notulen" },
    });
    fireEvent.change(screen.getByLabelText("Pemilik"), {
      target: { value: "sari" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Tugas baru" }));

    await waitFor(() => {
      expect(mocks.createTask).toHaveBeenCalledWith({
        title: "Tulis notulen",
        ownerAgentId: "sari",
      });
    });
    expect(await screen.findByText("Audit tunnel")).toBeTruthy();
  });

  it("shows a task load failure as an alert row", async () => {
    mocks.listTasks.mockRejectedValue(new Error("offline"));

    render(() => <KanbanPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/tidak bisa memuat task/i);
  });
});

describe("App scene", () => {
  it("mounts a full-size canvas, creates the scene and draws the agent snapshot", async () => {
    mocks.me.mockResolvedValue({ userId: "owner-1" });

    render(() => <App />);

    const canvas = await screen.findByTestId("office-canvas");
    expect(canvas.className).toMatch(/\bw-full\b/);
    expect(canvas.className).toMatch(/\bh-full\b/);
    expect(sceneMock.createScene).toHaveBeenCalledWith(canvas, expect.anything());

    await waitFor(() => {
      const drawn = sceneMock.draw.mock.calls.some(
        (call) =>
          Array.isArray(call[0]?.agents) && call[0].agents.length === AGENTS.length,
      );
      expect(drawn).toBe(true);
    });

    const lastSnapshot = sceneMock.draw.mock.calls.at(-1)?.[0];
    expect(lastSnapshot.agents).toEqual([
      { id: "damar", duty: "desk" },
      { id: "sari", duty: "meeting" },
    ]);
    expect(screen.getByRole("toolbar", { name: "Kontrol tampilan kantor" })).toBeTruthy();
  });
});
