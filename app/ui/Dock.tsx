import { For, Match, Switch, createSignal } from "solid-js";
import { ChatPanel } from "./ChatPanel";
import { KanbanPanel } from "./KanbanPanel";

type Tab = "Chat" | "Kanban" | "Meeting" | "Cron";

const TABS: Tab[] = ["Chat", "Kanban", "Meeting", "Cron"];

interface RosterAgent {
  initials: string;
  name: string;
  color: string;
  dot: "sage" | "meet" | "a2a" | "idle";
}

const ROSTER: RosterAgent[] = [
  { initials: "DA", name: "Damar", color: "#6f9a63", dot: "sage" },
  { initials: "SA", name: "Sari", color: "#4f7fa8", dot: "meet" },
  { initials: "RA", name: "Raka", color: "#c08a2e", dot: "a2a" },
  { initials: "NU", name: "Nusa", color: "#a49c8b", dot: "idle" },
];

const DOT_CLASS: Record<RosterAgent["dot"], string> = {
  sage: "bg-sage",
  meet: "bg-meet",
  a2a: "bg-a2a",
  idle: "bg-idle",
};

function MeetingPanel() {
  return (
    <div class="flex flex-col gap-2.5">
      <div class="rounded-[10px] border border-line bg-panel-2 p-3">
        <span class="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] font-semibold text-meet">
          <i class="h-[7px] w-[7px] rounded-full bg-current" />
          ruang meeting
        </span>
        <b class="mt-2.5 block text-sm">Rapat harian</b>
        <small class="text-[11.5px] text-ink-soft">
          Agenda dan notulen akan tampil di sini.
        </small>
      </div>
      <p class="text-[11.5px] leading-relaxed text-ink-soft">
        Placeholder meeting. Giliran bicara dan notulen menyusul.
      </p>
    </div>
  );
}

function CronPanel() {
  const jobs = [
    { name: "Backup state kantor", schedule: "setiap hari · 02:00" },
    { name: "Sinkron Hermes", schedule: "setiap 15 menit" },
  ] as const;

  return (
    <div class="flex flex-col gap-2.5">
      <For each={jobs}>
        {(job) => (
          <div class="flex items-center gap-3 rounded-[10px] border border-line bg-panel-2 px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <b class="block text-[13px]">{job.name}</b>
              <small class="text-[11.5px] text-ink-soft">{job.schedule}</small>
            </div>
            <span class="rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] font-semibold text-ink-soft">
              placeholder
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

export function Dock() {
  const [active, setActive] = createSignal<Tab>("Chat");
  const [expanded, setExpanded] = createSignal(false);

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

      <div
        class="dock-roster gap-3 overflow-x-auto px-3 py-1"
        aria-label="Roster agent"
      >
        <For each={ROSTER}>
          {(agent) => (
            <button
              class="flex min-h-11 min-w-11 flex-none flex-col items-center gap-1 bg-transparent"
              type="button"
              aria-label={`Chat ${agent.name}`}
              onClick={() => {
                setActive("Chat");
                setExpanded(true);
              }}
            >
              <span
                class="relative flex h-10 w-10 items-center justify-center rounded-xl text-[12px] font-bold text-white"
                style={{ "background-color": agent.color }}
              >
                {agent.initials}
                <i
                  class={`absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] rounded-full border-2 border-panel ${DOT_CLASS[agent.dot]}`}
                />
              </span>
              <small class="text-[10.5px] text-ink-soft">{agent.name}</small>
            </button>
          )}
        </For>
      </div>

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
            <ChatPanel />
          </Match>
          <Match when={active() === "Kanban"}>
            <KanbanPanel />
          </Match>
          <Match when={active() === "Meeting"}>
            <MeetingPanel />
          </Match>
          <Match when={active() === "Cron"}>
            <CronPanel />
          </Match>
        </Switch>
      </div>
    </aside>
  );
}
