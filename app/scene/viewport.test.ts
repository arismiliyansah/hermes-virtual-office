import { describe, expect, it } from "vitest";
import {
  bindSceneViewport,
  clampZoom,
  defaultViewport,
  nextRotation,
  rotatePoint,
  viewStorageKey,
} from "./viewport";

describe("viewport state", () => {
  it("starts at 100%, unrotated and unpanned", () => {
    expect(defaultViewport).toEqual({
      zoom: 1,
      rotation: 0,
      panX: 0,
      panY: 0,
    });
    expect(viewStorageKey).toBe("hermes-office-view");
  });

  it("clamps zoom to the 0.6–2.5 range", () => {
    expect(clampZoom(0.1)).toBe(0.6);
    expect(clampZoom(9)).toBe(2.5);
    expect(clampZoom(1.4)).toBe(1.4);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("wraps rotation 0 → 1 → 2 → 3 → 0", () => {
    expect(nextRotation(0)).toBe(1);
    expect(nextRotation(1)).toBe(2);
    expect(nextRotation(2)).toBe(3);
    expect(nextRotation(3)).toBe(0);
  });
});

describe("rotatePoint", () => {
  const cx = 6;
  const cy = 4.5;

  it("is the identity at rotation 0", () => {
    expect(rotatePoint(2.25, 7.75, 0, cx, cy)).toEqual({ i: 2.25, j: 7.75 });
  });

  it("rotates 90° clockwise in grid space around the centre", () => {
    expect(rotatePoint(7, 4.5, 1, cx, cy)).toEqual({ i: 6, j: 5.5 });
    expect(rotatePoint(6, 5.5, 1, cx, cy)).toEqual({ i: 5, j: 4.5 });
    expect(rotatePoint(cx, cy, 1, cx, cy)).toEqual({ i: cx, j: cy });
  });

  it("returns to the original point after four 90° rotations", () => {
    let point = { i: 2.3, j: 6.7 };
    for (let step = 0; step < 4; step += 1) {
      point = rotatePoint(point.i, point.j, 1, cx, cy);
    }
    expect(point.i).toBeCloseTo(2.3, 9);
    expect(point.j).toBeCloseTo(6.7, 9);
  });

  it("matches 180° and 270° with two and three quarter turns", () => {
    const half = rotatePoint(2, 6.5, 2, cx, cy);
    expect(half.i).toBeCloseTo(10, 9);
    expect(half.j).toBeCloseTo(2.5, 9);

    const threeQuarters = rotatePoint(7, 4.5, 3, cx, cy);
    expect(threeQuarters.i).toBeCloseTo(6, 9);
    expect(threeQuarters.j).toBeCloseTo(3.5, 9);
  });
});

describe("canvas gestures", () => {
  it("zooms on wheel and stops listening after cleanup", () => {
    const surface = document.createElement("div");
    let viewport = { ...defaultViewport };
    const stop = bindSceneViewport(
      surface,
      () => viewport,
      (next) => {
        viewport = next;
      },
    );

    const wheel = new Event("wheel", { cancelable: true });
    Object.defineProperty(wheel, "deltaY", { value: -100 });
    surface.dispatchEvent(wheel);
    expect(viewport.zoom).toBeGreaterThan(1);
    expect(viewport.zoom).toBeLessThanOrEqual(2.5);

    stop();
    const before = viewport.zoom;
    surface.dispatchEvent(wheel);
    expect(viewport.zoom).toBe(before);
  });
});
