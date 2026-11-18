import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Duty } from "../../src/protocol";
import { TH, TW, diamond, project } from "./iso";
import { LAYOUT } from "./layout";
import { DAY, NIGHT, type Palette } from "./palette";
import { createScene } from "./renderer";

const PALETTE_KEYS: (keyof Palette)[] = [
  "tileA",
  "tileB",
  "meetA",
  "meetB",
  "rugA",
  "rugB",
  "tileStroke",
  "skirtA",
  "skirtB",
  "wall",
  "wallTop",
  "deskTop",
  "deskTop2",
  "deskStroke",
  "deskBase",
  "monitor",
  "screen",
  "screenOff",
  "scrLine",
  "lampWork",
  "lampFree",
  "kb",
  "kbStroke",
  "chair",
  "chairBase",
  "sofa1",
  "sofa2",
  "sofa3",
  "sofaLine",
  "pot",
  "plantA",
  "plantB",
  "plantC",
  "rack",
  "rackStroke",
  "rackSlot",
  "rackLabel",
  "rackLed",
  "table",
  "table2",
  "tableStroke",
  "laptop",
  "laptopScreen",
  "glassFill",
  "glassStroke",
  "glassTop",
  "shadow",
  "tagFill",
  "tagStroke",
  "tagInk",
  "spk",
  "sel",
];

function stubCanvas(): { canvas: HTMLCanvasElement; calls: string[] } {
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const canvas = {
    width: 960,
    height: 540,
    clientWidth: 0,
    clientHeight: 0,
  } as unknown as HTMLCanvasElement;

  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === "canvas") return canvas;
      if (prop === "measureText") return () => ({ width: 24 });
      if (typeof prop === "symbol") return undefined;
      const stored = target[prop];
      if (stored !== undefined) return stored;
      return (...args: unknown[]) => {
        calls.push(`${String(prop)}:${args.length}`);
      };
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });

  (canvas as unknown as { getContext: (id: string) => unknown }).getContext =
    () => ctx;
  return { canvas, calls };
}

describe("isometric projection", () => {
  it("moves one grid step by half a tile width and height", () => {
    const origin = project(0, 0);
    const east = project(1, 0);
    const south = project(0, 1);

    expect(east.x - origin.x).toBeCloseTo(TW / 2, 10);
    expect(east.y - origin.y).toBeCloseTo(TH / 2, 10);
    expect(south.x - origin.x).toBeCloseTo(-TW / 2, 10);
    expect(south.y - origin.y).toBeCloseTo(TH / 2, 10);
  });

  it("uses the mockup constants by default and accepts overrides", () => {
    expect(project(0, 0)).toEqual({ x: 470, y: 88 });
    expect(project(2, 1, { tw: 100, th: 50, ox: 10, oy: 20 })).toEqual({
      x: 10 + 50,
      y: 20 + 75,
    });
  });

  it("builds diamonds ordered top, right, bottom, left", () => {
    expect(diamond({ x: 10, y: 20 })).toEqual([
      { x: 10, y: 5.5 },
      { x: 39, y: 20 },
      { x: 10, y: 34.5 },
      { x: -19, y: 20 },
    ]);
    expect(diamond({ x: 0, y: 0 }, 10, 20)).toEqual([
      { x: 0, y: -10 },
      { x: 5, y: 0 },
      { x: 0, y: 10 },
      { x: -5, y: 0 },
    ]);
  });
});

describe("palettes", () => {
  it("contains every token from the mockup in both themes", () => {
    for (const key of PALETTE_KEYS) {
      expect(typeof DAY[key], `DAY.${key}`).toBe("string");
      expect(typeof NIGHT[key], `NIGHT.${key}`).toBe("string");
    }
    expect(Object.keys(DAY).sort()).toEqual([...PALETTE_KEYS].sort());
    expect(Object.keys(NIGHT).sort()).toEqual([...PALETTE_KEYS].sort());
  });

  it("keeps the exact day/night values from the mockup", () => {
    expect(DAY.tileA).toBe("#f3ebdb");
    expect(DAY.tileB).toBe("#ece2cc");
    expect(DAY.glassFill).toBe("rgba(158,186,196,.28)");
    expect(NIGHT.tileA).toBe("#37322a");
    expect(NIGHT.screen).toBe("#f4e6b8");
    expect(NIGHT.glassFill).toBe("rgba(130,160,180,.14)");
    expect(DAY.sel).toBe("#d07a2a");
    expect(NIGHT.sel).toBe("#d98936");
  });
});

describe("layout", () => {
  it("ports the mockup geometry", () => {
    expect(LAYOUT.width).toBe(12);
    expect(LAYOUT.height).toBe(9);
    expect(LAYOUT.desks).toEqual([
      [2, 2],
      [4, 2],
      [6, 2],
      [2, 4],
      [4, 4],
      [6, 4],
    ]);
    expect(LAYOUT.meetingRoom).toEqual({ i: 7, j: 0, w: 5, h: 4 });
    expect(LAYOUT.lounge).toEqual({ i: 0, j: 6, w: 3, h: 3 });
    expect(LAYOUT.rack).toEqual([1, 0.4]);
    expect(LAYOUT.plants).toEqual([
      [0.4, 1.2],
      [10.8, 4.6],
    ]);
    expect(LAYOUT.sofa).toEqual([1, 7]);
    expect(LAYOUT.meetingTable).toEqual([9, 1.6]);
    expect(LAYOUT.MEET_PATH[0]).toEqual([6, 4]);
    expect(LAYOUT.MEET_PATH.length).toBeGreaterThan(1);
  });

  it("draws glass dividers with a door gap", () => {
    expect(LAYOUT.glass).toEqual([
      [
        [6.5, 3.5],
        [8.5, 3.5],
      ],
      [
        [10.5, 3.5],
        [11.5, 3.5],
      ],
      [
        [6.5, -0.5],
        [6.5, 0.5],
      ],
      [
        [6.5, 2.5],
        [6.5, 3.5],
      ],
    ]);
  });
});

describe("scene renderer", () => {
  const agents: { id: string; duty: Duty }[] = [
    { id: "atlas", duty: "desk" },
    { id: "bimo", duty: "desk" },
    { id: "citra", duty: "meeting" },
    { id: "damar", duty: "review" },
    { id: "eka", duty: "a2a" },
    { id: "fajar", duty: "idle" },
  ];

  it("draws a six-agent snapshot with a canvas stub without throwing", () => {
    const { canvas, calls } = stubCanvas();
    const scene = createScene(canvas, { palette: DAY, layout: LAYOUT });

    expect(() => {
      for (const rotation of [0, 1, 2, 3] as const) {
        scene.draw(
          { agents },
          { zoom: 1.5, rotation, panX: 12, panY: -8 },
        );
      }
      scene.draw({ agents }, { zoom: 0.6, rotation: 0, panX: 0, panY: 0 });
      scene.draw({ agents }, { zoom: 2.5, rotation: 2, panX: 0, panY: 0 });
    }).not.toThrow();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toContain("fill:0");
  });

  it("renders the night palette as well", () => {
    const { canvas } = stubCanvas();
    const scene = createScene(canvas, { palette: NIGHT, layout: LAYOUT });
    expect(() =>
      scene.draw({ agents }, { zoom: 1, rotation: 0, panX: 0, panY: 0 }),
    ).not.toThrow();
  });

  it("hit-tests the agent painted at a canvas point", () => {
    const { canvas } = stubCanvas();
    const scene = createScene(canvas, { palette: DAY, layout: LAYOUT });
    scene.draw(
      { agents: [{ id: "atlas", duty: "desk" }] },
      { zoom: 1, rotation: 0, panX: 0, panY: 0 },
    );

    let hit: string | null = null;
    for (let y = 0; y < 540 && hit === null; y += 2) {
      for (let x = 0; x < 960; x += 2) {
        const found = scene.hitTest?.(x, y) ?? null;
        if (found !== null) {
          hit = found;
          break;
        }
      }
    }

    expect(hit).toBe("atlas");
    expect(scene.hitTest?.(1, 1)).toBeNull();
  });

  it("keeps every scene module free of network/API imports", () => {
    for (const file of [
      "iso.ts",
      "palette.ts",
      "layout.ts",
      "viewport.ts",
      "renderer.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*\/api(?:\.ts)?["']/);
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/XMLHttpRequest|WebSocket/);
    }
  });
});
