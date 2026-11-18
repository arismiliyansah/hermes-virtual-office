import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import App from "../App";

vi.mock("../api", () => ({
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setUnauthorizedHandler: vi.fn(() => () => {}),
}));

const mocked = vi.mocked(api);

function touchTargets(container: HTMLElement): Element[] {
  return Array.from(
    container.querySelectorAll("button, input, a[href], [role='tab']"),
  );
}

function expectTouchTargets(container: HTMLElement): void {
  const controls = touchTargets(container);
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.className).toMatch(/min-h-11|min-w-11/);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("App authentication", () => {
  it("shows the login screen when me returns 401/null", async () => {
    mocked.me.mockResolvedValue(null);

    const view = render(() => <App />);

    expect(await screen.findByRole("form", { name: "Masuk" })).toBeTruthy();
    expectTouchTargets(view.container);
  });

  it("submits the login body and enters the office on success", async () => {
    mocked.me.mockResolvedValue(null);
    mocked.login.mockResolvedValue(undefined);

    render(() => <App />);

    const email = await screen.findByLabelText("Email");
    const password = screen.getByLabelText("Kata sandi");
    fireEvent.input(email, { target: { value: "owner@example.com" } });
    fireEvent.input(password, { target: { value: "hunter2-correct" } });
    fireEvent.submit(screen.getByRole("form", { name: "Masuk" }));

    await waitFor(() => {
      expect(mocked.login).toHaveBeenCalledWith(
        "owner@example.com",
        "hunter2-correct",
      );
    });
    expect(await screen.findByText("Hermes Office")).toBeTruthy();
    expect(screen.getByTestId("dock-sheet")).toBeTruthy();
  });

  it("renders the office directly when a session already exists", async () => {
    mocked.me.mockResolvedValue({ userId: "owner-1" });

    render(() => <App />);

    expect(await screen.findByText("Hermes Office")).toBeTruthy();
    expect(screen.getByTestId("dock-sheet")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Chat" })).toBeTruthy();
  });
});

describe("responsive dock", () => {
  beforeEach(() => {
    mocked.me.mockResolvedValue({ userId: "owner-1" });
  });

  it("toggles the expanded class from the mobile sheet handle", async () => {
    render(() => <App />);

    const sheet = await screen.findByTestId("dock-sheet");
    const handle = screen.getByTestId("dock-handle");
    expect(sheet.classList.contains("expanded")).toBe(false);

    fireEvent.click(handle);
    expect(sheet.classList.contains("expanded")).toBe(true);
    expect(handle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(handle);
    expect(sheet.classList.contains("expanded")).toBe(false);
    expect(handle.getAttribute("aria-expanded")).toBe("false");
  });

  it("gives every office control a 44px touch target", async () => {
    const view = render(() => <App />);

    await screen.findByTestId("dock-sheet");
    expectTouchTargets(view.container);
  });
});

describe("login touch targets", () => {
  it("gives login controls a 44px touch target", async () => {
    mocked.me.mockResolvedValue(null);

    const view = render(() => <App />);

    await screen.findByRole("form", { name: "Masuk" });
    expectTouchTargets(view.container);
  });
});


describe("logout and expired sessions", () => {
  beforeEach(() => {
    mocked.me.mockResolvedValue({ userId: "owner-1" });
  });

  it("opens the account menu and logs out back to the login screen", async () => {
    mocked.logout.mockResolvedValue(undefined);

    render(() => <App />);
    await screen.findByTestId("dock-sheet");

    fireEvent.click(screen.getByRole("button", { name: "Akun owner" }));
    const keluar = screen.getByRole("menuitem", { name: "Keluar" });
    expect(keluar.className).toMatch(/min-h-11/);

    fireEvent.click(keluar);

    await waitFor(() => expect(mocked.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("form", { name: "Masuk" })).toBeTruthy();
  });

  it("returns to login when an API call reports 401", async () => {
    const captured: { handler: (() => void) | null } = { handler: null };
    mocked.setUnauthorizedHandler.mockImplementation((handler) => {
      captured.handler = handler;
      return () => {
        captured.handler = null;
      };
    });

    render(() => <App />);
    await screen.findByTestId("dock-sheet");

    captured.handler?.();

    expect(await screen.findByRole("form", { name: "Masuk" })).toBeTruthy();
  });

  it("still drops the local shell when the logout request fails", async () => {
    mocked.logout.mockRejectedValue(new Error("offline"));

    render(() => <App />);
    await screen.findByTestId("dock-sheet");

    fireEvent.click(screen.getByRole("button", { name: "Akun owner" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Keluar" }));

    expect(await screen.findByRole("form", { name: "Masuk" })).toBeTruthy();
  });
});
