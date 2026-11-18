import { onCleanup, onMount } from "solid-js";
import {
  clampZoom,
  defaultViewport,
  nextRotation,
  saveViewport,
  type Viewport,
} from "../scene/viewport";

const ZOOM_STEP = 0.2;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export function SceneToolbar(props: {
  viewport: Viewport;
  onChange: (viewport: Viewport) => void;
}) {
  function apply(next: Viewport): void {
    saveViewport(next);
    props.onChange(next);
  }

  function zoomBy(delta: number): void {
    apply({ ...props.viewport, zoom: clampZoom(props.viewport.zoom + delta) });
  }

  function rotate(): void {
    apply({
      ...props.viewport,
      rotation: nextRotation(props.viewport.rotation),
    });
  }

  function reset(): void {
    apply({ ...defaultViewport });
  }

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(-ZOOM_STEP);
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        rotate();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  return (
    <div
      class="pointer-events-auto flex items-center gap-1 rounded-xl border border-line bg-panel/95 p-1 text-ink shadow-sm backdrop-blur"
      role="toolbar"
      aria-label="Kontrol tampilan kantor"
    >
      <button
        class="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg leading-none hover:bg-panel-2 active:bg-panel-2"
        type="button"
        aria-label="Perkecil tampilan"
        onClick={() => zoomBy(-ZOOM_STEP)}
      >
        −
      </button>

      <output
        class="min-w-11 text-center text-[11px] font-semibold tabular-nums text-ink-soft"
        aria-live="polite"
        aria-label="Tingkat zoom"
      >
        {Math.round(props.viewport.zoom * 100)}%
      </output>

      <button
        class="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg leading-none hover:bg-panel-2 active:bg-panel-2"
        type="button"
        aria-label="Perbesar tampilan"
        onClick={() => zoomBy(ZOOM_STEP)}
      >
        +
      </button>

      <span class="mx-0.5 h-6 w-px bg-line" aria-hidden="true" />

      <button
        class="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-base hover:bg-panel-2 active:bg-panel-2"
        type="button"
        aria-label="Putar tampilan 90 derajat"
        aria-describedby="scene-toolbar-rotation"
        onClick={rotate}
      >
        ⟳
      </button>
      <span id="scene-toolbar-rotation" class="sr-only">
        Rotasi {props.viewport.rotation * 90} derajat
      </span>

      <button
        class="flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 text-[11px] font-semibold hover:bg-panel-2 active:bg-panel-2"
        type="button"
        aria-label="Reset tampilan"
        onClick={reset}
      >
        Reset
      </button>
    </div>
  );
}
