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
import type { AgentStatus } from "../src/duty";
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
import { officeActivity, overlayDuty } from "./ui/officeActivity";
import { Login } from "./ui/Login";
import { SceneToolbar } from "./ui/SceneToolbar";
import { Topbar } from "./ui/Topbar";
import { staleMessage, useAgentPoll } from "./ui/useAgentPoll";
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

  // A tap selects; a drag pans. Mobile browsers cancel the synthetic click
  // after we preventDefault on touchmove, so selection must come from the
  // pointer/touch stream itself.
  const TAP_SLOP_PX = 8;
  const TOUCH_CLICK_GUARD_MS = 500;
  let press: { x: number; y: number } | null = null;
  let lastPointerTapAt = 0;

  function pickAt(clientX: number, clientY: number): void {
    const current = scene();
    if (current?.hitTest === undefined || canvas === undefined) return;

    const rect = canvas.getBoundingClientRect();
    const agentId = current.hitTest(clientX - rect.left, clientY - rect.top);
    if (agentId !== null) props.onPickAgent(agentId);
  }

  function isTap(clientX: number, clientY: number): boolean {
    if (press === null) return false;
    return Math.hypot(clientX - press.x, clientY - press.y) < TAP_SLOP_PX;
  }

  function startPress(clientX: number, clientY: number): void {
    press = { x: clientX, y: clientY };
  }

  function endPress(clientX: number, clientY: number): void {
    const tapped = isTap(clientX, clientY);
    press = null;
    if (!tapped) return;
    const agentId = scene()?.hitTest?.(clientX, clientY) ?? null;
    if (agentId === null) return;
    lastPointerTapAt = Date.now();
    pickAt(clientX, clientY);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startPress(event.clientX, event.clientY);
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    endPress(event.clientX, event.clientY);
  }

  function onTouchStart(event: TouchEvent): void {
    const touch = event.touches[0];
    if (touch !== undefined) startPress(touch.clientX, touch.clientY);
  }

  function onTouchEnd(event: TouchEvent): void {
    // A pointerup already handled this tap on devices that emit both.
    if (Date.now() - lastPointerTapAt < TOUCH_CLICK_GUARD_MS) {
      press = null;
      return;
    }
    const touch = event.changedTouches[0];
    if (touch !== undefined) endPress(touch.clientX, touch.clientY);
    else press = null;
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
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press = null;
        }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => {
          press = null;
        }}
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

function OfficeShell(props: { onLogout: () => Promise<void> }) {
  const office = useOffice();
  const poll = useAgentPoll();
  const [theme, setTheme] = createSignal<Theme>(initialTheme());
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

  // Hermes is the baseline; live office activity (meeting, chat, cron) upgrades
  // it through the same resolveDuty the domain tests cover. Polling replaces
  // the old one-shot REST fetch, so a server-side status change shows up
  // without any user action.
  const sceneAgents = createMemo<SceneSnapshot["agents"]>(() => {
    const base = poll.agents();
    if (base.length > 0) {
      const activity = officeActivity();
      return base.map((agent) => ({
        id: agent.id,
        name: agent.name,
        color: agent.color,
        desk: agent.desk,
        duty: overlayDuty(agent.id, agent.status, activity),
      }));
    }

    // The first poll may still be in flight; reuse the hub snapshot meanwhile.
    return Object.entries(office.agents()).map(([id, duty]) => ({ id, duty }));
  });

  const snapshot = createMemo<SceneSnapshot>(() => ({
    agents: sceneAgents(),
  }));

  const duties = createMemo<Record<string, AgentStatus>>(() =>
    Object.fromEntries(sceneAgents().map((agent) => [agent.id, agent.duty])),
  );

  const stale = createMemo(() =>
    staleMessage({
      lastSuccessAt: poll.lastSuccessAt(),
      failed: poll.lastError() !== null,
      now: poll.now(),
    }),
  );

  const hermesStale = createMemo(
    () => stale() !== null && poll.lastError() === null,
  );

  const latestEvent = createMemo(() => office.events()[0]?.text ?? "");

  return (
    <div class="flex h-dvh flex-col bg-bg text-ink">
      <Topbar
        theme={theme()}
        wsConnected={office.connected()}
        hermesFailed={poll.lastError() !== null}
        hermesStale={hermesStale()}
        onThemeChange={changeTheme}
        onLogout={props.onLogout}
      />
      <Show when={stale()}>
        {(message) => (
          <p
            class="flex-none border-b border-[#d9a08e] bg-[#fbebe5] px-3 py-2 text-[12px] leading-relaxed text-[#8f3c27]"
            role="alert"
            data-testid="stale-banner"
          >
            {message()}
          </p>
        )}
      </Show>
      <main class="office-main">
        <Office
          snapshot={snapshot()}
          theme={theme()}
          onPickAgent={setSelectedAgentId}
        />
        <Dock
          agents={poll.agents()}
          duties={duties()}
          selectedAgentId={selectedAgentId()}
          onSelectAgent={setSelectedAgentId}
          meetingTurn={office.meetingTurn()}
          onClearMeetingTurn={office.clearMeetingTurn}
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

  onMount(() => {
    const off = api.setUnauthorizedHandler(() => setMode("login"));
    onCleanup(off);

    void (async () => {
      try {
        const session = await api.me();
        setMode(session === null ? "login" : "office");
      } catch {
        setMode("login");
      }
    })();
  });

  async function handleLogin(email: string, password: string): Promise<void> {
    await api.login(email, password);
    setMode("office");
  }

  async function handleLogout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      // The session cookie may already be gone; the local shell still closes.
    } finally {
      setMode("login");
    }
  }

  return (
    <Show when={mode() !== "loading"} fallback={<Loading />}>
      <Show when={mode() === "office"} fallback={<Login onSubmit={handleLogin} />}>
        <OfficeShell onLogout={handleLogout} />
      </Show>
    </Show>
  );
}
