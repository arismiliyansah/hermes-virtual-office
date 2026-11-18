import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultViewport, viewStorageKey, type Viewport } from "../scene/viewport";
import { SceneToolbar } from "./SceneToolbar";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

beforeEach(() => {
  localStorage.clear();
});

function view(overrides: Partial<Viewport> = {}): Viewport {
  return { ...defaultViewport, ...overrides };
}

function setup(viewport: Viewport) {
  const onChange = vi.fn<(next: Viewport) => void>();
  render(() => <SceneToolbar viewport={viewport} onChange={onChange} />);
  return onChange;
}

describe("SceneToolbar", () => {
  it("clamps zoom out and zoom in to the viewport limits", () => {
    const out = setup(view({ zoom: 0.6 }));
    fireEvent.click(screen.getByRole("button", { name: "Perkecil tampilan" }));
    expect(out).toHaveBeenCalledWith(expect.objectContaining({ zoom: 0.6 }));

    cleanup();

    const input = setup(view({ zoom: 2.4 }));
    fireEvent.click(screen.getByRole("button", { name: "Perbesar tampilan" }));
    expect(input).toHaveBeenCalledWith(expect.objectContaining({ zoom: 2.5 }));
  });

  it("sends the next rotation and wraps from 3 to 0", () => {
    const onChange = setup(view({ rotation: 3 }));
    fireEvent.click(screen.getByRole("button", { name: "Putar tampilan 90 derajat" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rotation: 0, zoom: 1 }),
    );

    cleanup();

    const next = setup(view({ rotation: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Putar tampilan 90 derajat" }));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ rotation: 2 }));
  });

  it("resets zoom, rotation and pan", () => {
    const onChange = setup(view({ zoom: 2.1, rotation: 2, panX: 45, panY: -30 }));
    fireEvent.click(screen.getByRole("button", { name: "Reset tampilan" }));
    expect(onChange).toHaveBeenCalledWith(defaultViewport);
  });

  it("gives every toolbar button a 44px touch target", () => {
    setup(view());
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const button of buttons) {
      expect(button.className).toMatch(/min-h-11/);
      expect(button.className).toMatch(/min-w-11/);
    }
  });

  it("supports +, - and R from the keyboard", () => {
    const [viewport, setViewport] = createSignal<Viewport>(
      view({ zoom: 1, rotation: 0 }),
    );
    const onChange = vi.fn<(next: Viewport) => void>((next) => {
      setViewport(next);
    });
    render(() => <SceneToolbar viewport={viewport()} onChange={onChange} />);

    fireEvent.keyDown(document.body, { key: "+" });
    expect(viewport().zoom).toBeCloseTo(1.2, 9);

    fireEvent.keyDown(document.body, { key: "-" });
    expect(viewport().zoom).toBeCloseTo(1, 9);

    fireEvent.keyDown(document.body, { key: "r" });
    expect(viewport().rotation).toBe(1);
  });

  it("persists the latest viewport in localStorage", () => {
    const onChange = setup(view({ zoom: 1.4, rotation: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Putar tampilan 90 derajat" }));
    expect(onChange).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(viewStorageKey) ?? "null")).toEqual(
      expect.objectContaining({ zoom: 1.4, rotation: 2 }),
    );
  });
});
