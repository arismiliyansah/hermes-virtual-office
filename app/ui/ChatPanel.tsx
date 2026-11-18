import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onMount,
} from "solid-js";
import * as api from "../api";
import type { Agent } from "../api";

type ChatMessage = {
  id: number;
  from: "me" | "them";
  text: string;
};

type AgentStatus = Agent["status"];

const STATUS: Record<AgentStatus, { label: string; chip: string }> = {
  desk: { label: "bekerja", chip: "text-sage" },
  review: { label: "review", chip: "text-a2a" },
  meeting: { label: "meeting", chip: "text-meet" },
  a2a: { label: "a2a", chip: "text-a2a" },
  idle: { label: "menganggur", chip: "text-idle" },
};

function statusFor(status: AgentStatus): { label: string; chip: string } {
  return STATUS[status] ?? STATUS.idle;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const raw = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return raw.toUpperCase();
}

function failureText(cause: unknown, fallback: string): string {
  const status = (cause as { status?: unknown } | null)?.status;
  if (status === 401) {
    return "Sesi berakhir. Masuk lagi untuk melanjutkan.";
  }
  return fallback;
}

export function ChatPanel(
  props: {
    selectedAgentId?: string | null;
    onSelectAgent?: (agentId: string) => void;
  } = {},
) {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [conversations, setConversations] = createSignal<
    Record<string, ChatMessage[]>
  >({});
  const [draft, setDraft] = createSignal("");
  const [pendingAgentId, setPendingAgentId] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);

  let nextMessageId = 1;

  const selected = createMemo(
    () => agents().find((agent) => agent.id === selectedId()) ?? null,
  );
  const messages = createMemo<ChatMessage[]>(() => {
    const agent = selected();
    return agent === null ? [] : (conversations()[agent.id] ?? []);
  });
  const typing = createMemo(
    () =>
      pendingAgentId() !== null && pendingAgentId() === selected()?.id,
  );

  function choose(agent: Agent): void {
    setSelectedId(agent.id);
    setError("");
    props.onSelectAgent?.(agent.id);
  }

  function pushMessage(agentId: string, from: ChatMessage["from"], text: string): void {
    const message: ChatMessage = { id: nextMessageId, from, text };
    nextMessageId += 1;
    setConversations((previous) => ({
      ...previous,
      [agentId]: [...(previous[agentId] ?? []), message],
    }));
  }

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const agent = selected();
    const text = draft().trim();
    if (agent === null || text.length === 0 || pendingAgentId() !== null) return;

    const agentId = agent.id;
    pushMessage(agentId, "me", text);
    setDraft("");
    setError("");
    setPendingAgentId(agentId);

    try {
      const reply = await api.sendAgentMessage(agentId, text);
      if (typeof reply?.reply === "string" && reply.reply.length > 0) {
        pushMessage(agentId, "them", reply.reply);
      }
    } catch (cause) {
      setError(
        failureText(
          cause,
          "Gagal mengirim pesan. Periksa koneksi lalu coba lagi.",
        ),
      );
    } finally {
      setPendingAgentId(null);
    }
  }

  createEffect(
    on(
      () => props.selectedAgentId ?? null,
      (id) => {
        if (id !== null && agents().some((agent) => agent.id === id)) {
          setSelectedId(id);
        }
      },
      { defer: true },
    ),
  );

  onMount(async () => {
    try {
      const list = await api.listAgents();
      const safe = Array.isArray(list) ? list : [];
      setAgents(safe);
      const wanted = props.selectedAgentId ?? null;
      const preferred =
        wanted === null
          ? null
          : (safe.find((agent) => agent.id === wanted) ?? null);
      if (preferred !== null) setSelectedId(preferred.id);
      else if (safe.length > 0) setSelectedId(safe[0].id);
    } catch (cause) {
      setError(
        failureText(cause, "Tidak bisa memuat daftar agent. Coba lagi nanti."),
      );
    } finally {
      setLoading(false);
    }
  });

  return (
    <div class="flex min-h-0 flex-col gap-3">
      <div class="flex gap-2 overflow-x-auto pb-1" aria-label="Daftar agent">
        <For each={agents()}>
          {(agent) => {
            const active = () => agent.id === selectedId();
            return (
              <button
                class="flex min-h-11 min-w-11 flex-none flex-col items-center gap-1 rounded-[10px] px-1.5 py-1 text-[10.5px] text-ink-soft hover:bg-panel-2 aria-pressed:text-ink"
                classList={{ "bg-panel-2 text-ink": active() }}
                type="button"
                aria-pressed={active()}
                aria-label={`Pilih ${agent.name}`}
                onClick={() => choose(agent)}
              >
                <span
                  class="flex h-9 w-9 items-center justify-center rounded-[10px] text-[11.5px] font-bold text-white"
                  style={{
                    "background-color":
                      agent.color ?? (active() ? "var(--accent)" : "var(--idle)"),
                  }}
                  aria-hidden="true"
                >
                  {initials(agent.name)}
                </span>
                <span class="max-w-14 truncate">{agent.name}</span>
              </button>
            );
          }}
        </For>
      </div>

      <Show
        when={selected()}
        fallback={
          <p class="text-[12px] leading-relaxed text-ink-soft">
            {loading()
              ? "Memuat agent…"
              : "Belum ada agent yang bisa dihubungi."}
          </p>
        }
      >
        {(agent) => {
          const status = () => statusFor(agent().status);
          return (
            <>
              <div class="flex items-center gap-2.5 border-b border-line pb-3">
                <span
                  class="flex h-9 w-9 items-center justify-center rounded-[10px] text-[12px] font-bold text-white"
                  style={{
                    "background-color": agent().color ?? "var(--accent)",
                  }}
                  aria-hidden="true"
                >
                  {initials(agent().name)}
                </span>
                <div class="min-w-0">
                  <b class="block truncate text-sm">{agent().name}</b>
                  <small class="block truncate text-[11.5px] text-ink-soft">
                    {agent().role}
                  </small>
                </div>
                <span
                  class={`ml-auto inline-flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[11px] font-semibold ${status().chip}`}
                >
                  <i class="h-[7px] w-[7px] rounded-full bg-current" aria-hidden="true" />
                  {status().label}
                </span>
              </div>

              <p class="rounded-lg border border-line bg-panel-2 px-2.5 py-2 font-mono text-[11px] text-ink-soft">
                tool: belum ada aktivitas
              </p>

              <div
                class="flex min-h-16 flex-col gap-2.5"
                aria-label={`Percakapan dengan ${agent().name}`}
                aria-live="polite"
              >
                <Show when={messages().length === 0}>
                  <p class="text-[11.5px] leading-relaxed text-ink-soft">
                    Belum ada pesan. Mulai percakapan dengan {agent().name}.
                  </p>
                </Show>

                <For each={messages()}>
                  {(message) => (
                    <div
                      class="max-w-[85%] rounded-xl px-3 py-2.5 text-[13px] leading-relaxed"
                      classList={{
                        "self-start rounded-tl-[4px] border border-line bg-panel-2":
                          message.from === "them",
                        "self-end rounded-tr-[4px] bg-accent text-white":
                          message.from === "me",
                      }}
                    >
                      {message.text}
                    </div>
                  )}
                </For>

                <Show when={typing()}>
                  <div
                    class="flex items-center gap-1.5 rounded-xl rounded-tl-[4px] border border-line bg-panel-2 px-3 py-2.5"
                    data-testid="chat-typing"
                    aria-label={`${agent().name} mengetik`}
                  >
                    <i class="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft [animation-delay:-.24s]" />
                    <i class="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft [animation-delay:-.12s]" />
                    <i class="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft" />
                    <span class="sr-only">mengetik…</span>
                  </div>
                </Show>

                <Show when={error()}>
                  <p
                    class="rounded-lg border border-[#d9a08e] bg-[#fbebe5] px-2.5 py-2 text-[12px] leading-relaxed text-[#8f3c27]"
                    role="alert"
                  >
                    {error()}
                  </p>
                </Show>
              </div>

              <form
                class="flex gap-2 border-t border-line pt-3"
                aria-label={`Kirim pesan ke ${agent().name}`}
                onSubmit={(event) => void send(event)}
              >
                <input
                  class="min-h-11 min-w-0 flex-1 rounded-[9px] border border-line bg-[var(--input-bg)] px-3 text-[13px] text-ink outline-none placeholder:text-ink-soft/70 focus:border-accent focus:ring-2 focus:ring-accent/20"
                  type="text"
                  aria-label="Pesan"
                  autocomplete="off"
                  placeholder={`Ketik pesan untuk ${agent().name}…`}
                  value={draft()}
                  disabled={pendingAgentId() !== null}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                />
                <button
                  class="min-h-11 flex-none rounded-[9px] bg-accent px-3.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
                  type="submit"
                  disabled={
                    pendingAgentId() !== null || draft().trim().length === 0
                  }
                >
                  Kirim
                </button>
              </form>
            </>
          );
        }}
      </Show>

      <Show when={selected() === null && error()}>
        <p
          class="rounded-lg border border-[#d9a08e] bg-[#fbebe5] px-2.5 py-2 text-[12px] leading-relaxed text-[#8f3c27]"
          role="alert"
        >
          {error()}
        </p>
      </Show>
    </div>
  );
}
