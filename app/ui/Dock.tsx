import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  on,
} from "solid-js";
import type { Duty } from "../../src/protocol";
import type { Agent } from "../api";
import { ChatPanel } from "./ChatPanel";
import { CronPanel } from "./CronPanel";
import { KanbanPanel } from "./KanbanPanel";
import { MeetingPanel } from "./MeetingPanel";
import type { MeetingTurn } from "./useOffice";

type Tab = "Chat" | "Kanban" | "Meeting" | "Cron";

const TABS: Tab[] = ["Chat", "Kanban", "Meeting", "Cron"];

type Dot = "sage" | "meet" | "a2a" | "idle";

const DOT_CLASS: Record<Dot, string> = {
  sage: "bg-sage",
  meet: "bg-meet",
  a2a: "bg-a2a",
  idle: "bg-idle",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const raw = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return raw.toUpperCase();
}

function dotFor(duty: Duty): Dot {
  if (duty === "meeting") return "meet";
  if (duty === "a2a") return "a2a";
  if (duty === "idle") return "idle";
  return "sage";
}

export interface DockProps {
  agents?: Agent[];
  duties?: Record<string, Duty>;
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string) => void;
  meetingTurn?: MeetingTurn | null;
}

export function Dock(props: DockProps = {}) {
  const [active, setActive] = createSignal<Tab>("Chat");
  const [expanded, setExpanded] = createSignal(false);

  createEffect(
    on(
      () => props.selectedAgentId ?? null,
      (id) => {
        if (id === null) return;
        setActive("Chat");
        setExpanded(true);
      },
      { defer: true },
    ),
  );

  return (
    <aside
      class="office-dock"
      classList={{ expanded: expanded() }}
      data-testid="dock-sheet"
      aria-label="Panel kantor"
    >
      <button
        class="dock-handle min-h-11 w-full items-center justify-center"
        data-testid="dock-handle"
        type="button"
        aria-label={expanded() ? "Tutup panel" : "Buka panel"}
        aria-expanded={expanded()}
        onClick={() => setExpanded((value) => !value)}
      >
        <span class="h-[5px] w-11 rounded-full bg-[#d3c6ab]" aria-hidden="true" />
      </button>

      <div class="flex border-b border-line" role="tablist" aria-label="Panel kantor">
        <For each={TABS}>
          {(tab) => (
            <button
              class="min-h-11 flex-1 border-b-2 px-1 pb-2.5 pt-3 text-[13px] font-semibold"
              classList={{
                "border-accent text-ink": active() === tab,
                "border-transparent text-ink-soft hover:text-ink": active() !== tab,
              }}
              type="button"
              role="tab"
              aria-selected={active() === tab}
              onClick={() => setActive(tab)}
            >
              {tab}
            </button>
          )}
        </For>
      </div>

      <Show when={(props.agents ?? []).length > 0}>
        <div
          class="dock-roster gap-3 overflow-x-auto px-3 py-1"
          aria-label="Roster agent"
        >
          <For each={props.agents ?? []}>
            {(agent) => {
              const duty = () => props.duties?.[agent.id] ?? agent.status;
              return (
                <button
                  class="flex min-h-11 min-w-11 flex-none flex-col items-center gap-1 bg-transparent"
                  type="button"
                  aria-label={`Chat ${agent.name}`}
                  onClick={() => {
                    props.onSelectAgent?.(agent.id);
                    setActive("Chat");
                    setExpanded(true);
                  }}
                >
                  <span
                    class="relative flex h-10 w-10 items-center justify-center rounded-xl text-[12px] font-bold text-white"
                    style={{ "background-color": agent.color ?? "#8a6f4d" }}
                  >
                    {initials(agent.name)}
                    <i
                      class={`absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] rounded-full border-2 border-panel ${DOT_CLASS[dotFor(duty())]}`}
                      aria-hidden="true"
                    />
                  </span>
                  <small class="text-[10.5px] text-ink-soft">{agent.name}</small>
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      <p class="dock-hint px-3 pb-2 text-center text-[11px] text-ink-soft">
        ketuk agent untuk mulai chat · buka handle untuk panel penuh
      </p>

      <div
        class="dock-body p-4"
        role="tabpanel"
        aria-label={`Panel ${active()}`}
      >
        <Switch>
          <Match when={active() === "Chat"}>
            <ChatPanel
              selectedAgentId={props.selectedAgentId ?? null}
              onSelectAgent={props.onSelectAgent}
            />
          </Match>
          <Match when={active() === "Kanban"}>
            <KanbanPanel />
          </Match>
          <Match when={active() === "Meeting"}>
            <MeetingPanel meetingTurn={props.meetingTurn ?? null} />
          </Match>
          <Match when={active() === "Cron"}>
            <CronPanel />
          </Match>
        </Switch>
      </div>
    </aside>
  );
}
