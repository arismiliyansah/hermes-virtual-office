export type Rotation = 0 | 1 | 2 | 3;

export interface Viewport {
  zoom: number;
  rotation: Rotation;
  panX: number;
  panY: number;
}

export const defaultViewport: Viewport = {
  zoom: 1,
  rotation: 0,
  panX: 0,
  panY: 0,
};

export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 2.5;
export const viewStorageKey = "hermes-office-view";

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function nextRotation(rotation: Rotation): Rotation {
  return ((rotation + 1) % 4) as Rotation;
}

function normalizeRotation(value: unknown): Rotation {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const wrapped = ((Math.round(value) % 4) + 4) % 4;
  return wrapped as Rotation;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeViewport(value: unknown): Viewport {
  const raw = (value ?? {}) as Partial<Viewport>;
  return {
    zoom: clampZoom(finiteOr(raw.zoom, defaultViewport.zoom)),
    rotation: normalizeRotation(raw.rotation),
    panX: finiteOr(raw.panX, defaultViewport.panX),
    panY: finiteOr(raw.panY, defaultViewport.panY),
  };
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadViewport(storage?: ReadStorage): Viewport {
  const store = storage ?? browserStorage();
  if (!store) return { ...defaultViewport };
  try {
    const raw = store.getItem(viewStorageKey);
    return raw ? normalizeViewport(JSON.parse(raw)) : { ...defaultViewport };
  } catch {
    return { ...defaultViewport };
  }
}

export function saveViewport(viewport: Viewport, storage?: WriteStorage): void {
  const store = storage ?? browserStorage();
  if (!store) return;
  try {
    store.setItem(viewStorageKey, JSON.stringify(viewport));
  } catch {
    // Storage can be full or blocked; the office keeps working in memory.
  }
}

/**
 * Rotates a grid coordinate 90° clockwise around (cx, cy). Rotating the
 * coordinates (not the canvas) keeps sprites and labels upright.
 */
export function rotatePoint(
  i: number,
  j: number,
  rotation: Rotation,
  cx: number,
  cy: number,
): { i: number; j: number } {
  const di = i - cx;
  const dj = j - cy;
  switch (rotation) {
    case 1:
      return { i: cx - dj, j: cy + di };
    case 2:
      return { i: cx - di, j: cy - dj };
    case 3:
      return { i: cx + dj, j: cy - di };
    default:
      return { i, j };
  }
}

/**
 * Wires wheel zoom, pointer drag pan and two-finger pinch zoom to a canvas
 * surface. Returns a cleanup function for the mounting component.
 */
export function bindSceneViewport(
  surface: HTMLElement,
  getViewport: () => Viewport,
  onChange: (viewport: Viewport) => void,
): () => void {
  let drag: { id: number; x: number; y: number } | null = null;
  let touch:
    | { mode: "pan"; x: number; y: number; panX: number; panY: number }
    | {
        mode: "pinch";
        distance: number;
        zoom: number;
        panX: number;
        panY: number;
        midX: number;
        midY: number;
      }
    | null = null;

  const wheel = (event: Event) => {
    event.preventDefault();
    const deltaY = (event as WheelEvent).deltaY ?? 0;
    const current = getViewport();
    const factor = deltaY < 0 ? 1.12 : 1 / 1.12;
    onChange({ ...current, zoom: clampZoom(current.zoom * factor) });
  };

  const pointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    surface.setPointerCapture?.(event.pointerId);
  };

  const pointerMove = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    event.preventDefault();
    const current = getViewport();
    onChange({
      ...current,
      panX: current.panX + (event.clientX - drag.x),
      panY: current.panY + (event.clientY - drag.y),
    });
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const pointerUp = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    surface.releasePointerCapture?.(event.pointerId);
  };

  const touchDistance = (a: Touch, b: Touch): number =>
    Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  const touchStart = (event: TouchEvent) => {
    if (event.touches.length === 1) {
      const current = getViewport();
      const first = event.touches[0];
      touch = {
        mode: "pan",
        x: first.clientX,
        y: first.clientY,
        panX: current.panX,
        panY: current.panY,
      };
    } else if (event.touches.length === 2) {
      const current = getViewport();
      const first = event.touches[0];
      const second = event.touches[1];
      touch = {
        mode: "pinch",
        distance: Math.max(1, touchDistance(first, second)),
        zoom: current.zoom,
        panX: current.panX,
        panY: current.panY,
        midX: (first.clientX + second.clientX) / 2,
        midY: (first.clientY + second.clientY) / 2,
      };
    }
    event.preventDefault();
  };

  const touchMove = (event: TouchEvent) => {
    if (!touch) return;
    if (touch.mode === "pinch") {
      if (event.touches.length < 2) return;
      const first = event.touches[0];
      const second = event.touches[1];
      const current = getViewport();
      const midX = (first.clientX + second.clientX) / 2;
      const midY = (first.clientY + second.clientY) / 2;
      onChange({
        ...current,
        zoom: clampZoom(
          touch.zoom * (touchDistance(first, second) / touch.distance),
        ),
        panX: touch.panX + (midX - touch.midX),
        panY: touch.panY + (midY - touch.midY),
      });
    } else if (event.touches.length === 1) {
      const first = event.touches[0];
      onChange({
        ...getViewport(),
        panX: touch.panX + (first.clientX - touch.x),
        panY: touch.panY + (first.clientY - touch.y),
      });
    }
    event.preventDefault();
  };

  const touchEnd = () => {
    touch = null;
  };

  surface.addEventListener("wheel", wheel, { passive: false });
  surface.addEventListener("pointerdown", pointerDown);
  surface.addEventListener("pointermove", pointerMove);
  surface.addEventListener("pointerup", pointerUp);
  surface.addEventListener("pointercancel", pointerUp);
  surface.addEventListener("touchstart", touchStart, { passive: false });
  surface.addEventListener("touchmove", touchMove, { passive: false });
  surface.addEventListener("touchend", touchEnd);
  surface.addEventListener("touchcancel", touchEnd);

  return () => {
    surface.removeEventListener("wheel", wheel);
    surface.removeEventListener("pointerdown", pointerDown);
    surface.removeEventListener("pointermove", pointerMove);
    surface.removeEventListener("pointerup", pointerUp);
    surface.removeEventListener("pointercancel", pointerUp);
    surface.removeEventListener("touchstart", touchStart);
    surface.removeEventListener("touchmove", touchMove);
    surface.removeEventListener("touchend", touchEnd);
    surface.removeEventListener("touchcancel", touchEnd);
  };
}
