import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import * as api from "./api";
import type { Agent } from "./api";
import { LAYOUT } from "./scene/layout";
import { DAY, NIGHT } from "./scene/palette";
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
import {
  resolveInitialTheme,
  themeStorageKey,
  type Theme,
} from "./theme";
import { Dock } from "./ui/Dock";
import { Login } from "./ui/Login";
import { SceneToolbar } from "./ui/SceneToolbar";
import { Topbar } from "./ui/Topbar";
import { useOffice } from "./ui/useOffice";

type Mode = "loading" | "login" | "office";

const SAVE_VIEWPORT_DELAY = 400;

function Loading() {
  return (
    <div class="grid h-dvh place-items-center bg-bg text-sm text-ink-soft">
      Memuat kantor…
    </div>
  );
}

function initialTheme(): Theme {
  let prefersDark = false;
  try {
    prefersDark =
      window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    prefersDark = false;
  }

  let stored: string | null = null;
  try {
    stored = localStorage.getItem(themeStorageKey);
  } catch {
    stored = null;
  }

  return resolveInitialTheme(prefersDark, stored);
}

function Office(props: {
  snapshot: SceneSnapshot;
  theme: Theme;
  error?: string;
  onPickAgent: (agentId: string) => void;
}) {
  const [viewport, setViewport] = createSignal<Viewport>({
    ...defaultViewport,
  });
  const [scene, setScene] = createSignal<Scene | null>(null);
  const [sceneError, setSceneError] = createSignal("");

  let canvas: HTMLCanvasElement | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | undefined;

  const message = () => props.error ?? sceneError();

  function scheduleSave(next: Viewport): void {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      saveViewport(next);
    }, SAVE_VIEWPORT_DELAY);
  }

  // Single owner for viewport persistence: gestures, toolbar and keyboard all
  // funnel through here, so saves are debounced once.
  function applyViewport(next: Viewport): void {
    setViewport(next);
    scheduleSave(next);
  }

  function paint(): void {
    const current = scene();
    if (current === null) return;

    try {
      current.draw(props.snapshot, viewport());
    } catch {
      setSceneError("Tidak bisa menggambar kantor di perangkat ini.");
    }
  }

  function buildScene(theme: Theme): void {
    if (canvas === undefined) return;

    try {
      setScene(
        createScene(canvas, {
          palette: theme === "night" ? NIGHT : DAY,
          layout: LAYOUT,
        }),
      );
      setSceneError("");
    } catch {
      setSceneError("Tidak bisa menyiapkan panggung kantor.");
    }
  }

  function pickAgent(event: MouseEvent): void {
    const current = scene();
    if (current?.hitTest === undefined || canvas === undefined) return;

    const rect = canvas.getBoundingClientRect();
    const agentId = current.hitTest(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    if (agentId !== null) props.onPickAgent(agentId);
  }

  // Re-draw whenever the snapshot or viewport changes. The renderer owns all
  // canvas geometry; App only owns state and persistence.
  createEffect(paint);

  // The scene captures its palette, so a theme switch rebuilds it.
  createEffect(
    on(
      () => props.theme,
      (theme) => buildScene(theme),
      { defer: true },
    ),
  );

  onMount(() => {
    setViewport(loadViewport());

    if (canvas === undefined) return;

    buildScene(props.theme);

    const unbind = bindSceneViewport(canvas, () => viewport(), applyViewport);
    onCleanup(unbind);

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => paint());
      resizeObserver.observe(canvas);
      onCleanup(() => resizeObserver?.disconnect());
    }
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
        onClick={pickAgent}
      />

      <div class="pointer-events-none absolute left-3 top-3 max-w-[60%] rounded-lg border border-line bg-panel/90 px-3 py-2 text-[11.5px] text-ink-soft shadow-sm">
        Pratinjau kantor · {props.snapshot.agents.length} agent
      </div>

      <div class="pointer-events-none absolute bottom-3 right-3 z-10">
        <SceneToolbar viewport={viewport()} onChange={applyViewport} />
      </div>

      <Show when={message()}>
        <p
          class="absolute bottom-3 left-3 max-w-[60%] rounded-lg border border-[#d9a08e] bg-[#fbebe5] px-3 py-2 text-[11.5px] leading-relaxed text-[#8f3c27] shadow-sm"
          role="alert"
        >
          {message()}
        </p>
      </Show>
    </section>
  );
}

function OfficeShell() {
  const office = useOffice();
  const [theme, setTheme] = createSignal<Theme>(initialTheme());
  const [restAgents, setRestAgents] = createSignal<Agent[]>([]);
  const [agentError, setAgentError] = createSignal("");
  const [selectedAgentId, setSelectedAgentId] = createSignal<string | null>(
    null,
  );

  createEffect(() => {
    document.documentElement.dataset.theme = theme();
  });

  function changeTheme(next: Theme): void {
    setTheme(next);
    try {
      localStorage.setItem(themeStorageKey, next);
    } catch {
      // Private-mode storage can reject writes; the in-memory theme still works.
    }
  }

  const snapshot = createMemo<SceneSnapshot>(() => {
    if (office.connected()) {
      const live = Object.entries(office.agents()).map(([id, duty]) => ({
        id,
        duty,
      }));
      if (live.length > 0) return { agents: live };
    }

    return {
      agents: restAgents().map((agent) => ({ id: agent.id, duty: agent.status })),
    };
  });

  const latestEvent = createMemo(() => office.events()[0]?.text ?? "");

  onMount(async () => {
    try {
      const agents = await api.listAgents();
      setRestAgents(Array.isArray(agents) ? agents : []);
    } catch {
      setAgentError("Tidak bisa memuat agent kantor. Coba muat ulang halaman.");
    }
  });

  return (
    <div class="flex h-dvh flex-col bg-bg text-ink">
      <Topbar
        theme={theme()}
        connected={office.connected()}
        onThemeChange={changeTheme}
      />
      <main class="office-main">
        <Office
          snapshot={snapshot()}
          theme={theme()}
          error={agentError() || undefined}
          onPickAgent={setSelectedAgentId}
        />
        <Dock
          agents={restAgents()}
          duties={office.agents()}
          selectedAgentId={selectedAgentId()}
          onSelectAgent={setSelectedAgentId}
          meetingTurn={office.meetingTurn()}
        />
        <Show when={latestEvent()}>
          <p class="sr-only" aria-live="polite">
            {latestEvent()}
          </p>
        </Show>
      </main>
    </div>
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
        <OfficeShell />
      </Show>
    </Show>
  );
}
