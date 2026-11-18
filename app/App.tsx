import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import * as api from "./api";
import { LAYOUT } from "./scene/layout";
import { DAY } from "./scene/palette";
import {
  createScene,
  type Scene,
  type SceneSnapshot,
} from "./scene/renderer";
import {
  bindSceneViewport,
  defaultViewport,
  loadViewport,
  saveViewport,
  type Viewport,
} from "./scene/viewport";
import { Dock } from "./ui/Dock";
import { Login } from "./ui/Login";
import { SceneToolbar } from "./ui/SceneToolbar";
import { Topbar } from "./ui/Topbar";

type Mode = "loading" | "login" | "office";

const SAVE_VIEWPORT_DELAY = 400;

function Loading() {
  return (
    <div class="grid h-dvh place-items-center bg-bg text-sm text-ink-soft">
      Memuat kantor…
    </div>
  );
}

function Office() {
  const [snapshot, setSnapshot] = createSignal<SceneSnapshot>({ agents: [] });
  const [viewport, setViewport] = createSignal<Viewport>({
    ...defaultViewport,
  });
  const [scene, setScene] = createSignal<Scene | null>(null);
  const [error, setError] = createSignal("");

  let canvas: HTMLCanvasElement | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | undefined;

  function scheduleSave(next: Viewport): void {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      saveViewport(next);
    }, SAVE_VIEWPORT_DELAY);
  }

  function applyViewport(next: Viewport): void {
    setViewport(next);
    scheduleSave(next);
  }

  function paint(): void {
    const current = scene();
    if (current === null) return;

    try {
      current.draw(snapshot(), viewport());
    } catch {
      setError("Tidak bisa menggambar kantor di perangkat ini.");
    }
  }

  async function loadAgents(): Promise<void> {
    try {
      const agents = await api.listAgents();
      const safe = Array.isArray(agents) ? agents : [];
      setSnapshot({
        agents: safe.map((agent) => ({ id: agent.id, duty: agent.status })),
      });
    } catch {
      setError("Tidak bisa memuat agent kantor. Coba muat ulang halaman.");
    }
  }

  // Re-draw whenever the snapshot or viewport changes. The renderer owns all
  // canvas geometry; App only owns state and persistence.
  createEffect(paint);

  onMount(() => {
    setViewport(loadViewport());

    if (canvas === undefined) return;

    try {
      setScene(createScene(canvas, { palette: DAY, layout: LAYOUT }));
    } catch {
      setError("Tidak bisa menyiapkan panggung kantor.");
    }

    const unbind = bindSceneViewport(canvas, () => viewport(), applyViewport);
    onCleanup(unbind);

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => paint());
      resizeObserver.observe(canvas);
      onCleanup(() => resizeObserver?.disconnect());
    }

    void loadAgents();
  });

  onCleanup(() => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveViewport(viewport());
  });

  return (
    <section
      class="relative flex min-h-0 flex-1 overflow-hidden bg-bg"
      aria-label="Kantor"
    >
      <canvas
        ref={(element) => {
          canvas = element;
        }}
        class="h-full w-full touch-none select-none"
        data-testid="office-canvas"
        role="img"
        aria-label="Kantor isometrik Hermes"
      />

      <div class="pointer-events-none absolute left-3 top-3 rounded-lg border border-line bg-panel/90 px-3 py-2 text-[11.5px] text-ink-soft shadow-sm">
        Pratinjau kantor · {snapshot().agents.length} agent
      </div>

      <div class="pointer-events-none absolute bottom-3 right-3 z-10">
        <SceneToolbar viewport={viewport()} onChange={applyViewport} />
      </div>

      <Show when={error()}>
        <p
          class="absolute bottom-3 left-3 max-w-[60%] rounded-lg border border-[#d9a08e] bg-[#fbebe5] px-3 py-2 text-[11.5px] leading-relaxed text-[#8f3c27] shadow-sm"
          role="alert"
        >
          {error()}
        </p>
      </Show>
    </section>
  );
}

export default function App() {
  const [mode, setMode] = createSignal<Mode>("loading");

  onMount(async () => {
    try {
      const session = await api.me();
      setMode(session === null ? "login" : "office");
    } catch {
      setMode("login");
    }
  });

  async function handleLogin(email: string, password: string): Promise<void> {
    await api.login(email, password);
    setMode("office");
  }

  return (
    <Show when={mode() !== "loading"} fallback={<Loading />}>
      <Show when={mode() === "office"} fallback={<Login onSubmit={handleLogin} />}>
        <div class="flex h-dvh flex-col bg-bg text-ink">
          <Topbar />
          <main class="office-main">
            <Office />
            <Dock />
          </main>
        </div>
      </Show>
    </Show>
  );
}
