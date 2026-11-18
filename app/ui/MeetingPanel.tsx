import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import * as api from "../api";
import type { Agent, MeetingResult } from "../api";
import { markMeetingParticipants } from "./officeActivity";
import type { MeetingTurn } from "./useOffice";

function failureText(cause: unknown, fallback: string): string {
  const status = (cause as { status?: unknown } | null)?.status;
  if (status === 401) {
    return "Sesi berakhir. Masuk lagi untuk melanjutkan.";
  }
  return fallback;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const raw = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return raw.toUpperCase();
}

export function MeetingPanel(
  props: {
    meetingTurn?: MeetingTurn | null;
    onClearMeetingTurn?: () => void;
  } = {},
) {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [meetingParticipants, setMeetingParticipants] = createSignal<Agent[]>(
    [],
  );
  const [title, setTitle] = createSignal("Rapat harian");
  const [loading, setLoading] = createSignal(true);
  const [starting, setStarting] = createSignal(false);
  const [ending, setEnding] = createSignal(false);
  const [error, setError] = createSignal("");
  const [result, setResult] = createSignal<MeetingResult | null>(null);
  const [copyStatus, setCopyStatus] = createSignal("");

  const selectedAgents = createMemo(() =>
    agents().filter((agent) => selected().includes(agent.id)),
  );

  const speakerName = createMemo(() => {
    const turn = props.meetingTurn ?? null;
    if (turn === null) return "";
    return (
      agents().find((agent) => agent.id === turn.agentId)?.name ?? turn.agentId
    );
  });

  function toggleParticipant(id: string): void {
    if (starting()) return;
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
    setError("");
  }

  async function start(): Promise<void> {
    const trimmed = title().trim();
    const participants = [...selectedAgents()];
    const participantIds = participants.map((agent) => agent.id);
    if (starting()) return;

    if (trimmed.length === 0) {
      setError("Judul rapat wajib diisi.");
      return;
    }
    if (participantIds.length < 2) {
      setError("Pilih minimal dua peserta untuk memulai rapat.");
      return;
    }

    props.onClearMeetingTurn?.();
    setMeetingParticipants(participants);
    markMeetingParticipants(participantIds);
    setStarting(true);
    setError("");
    setResult(null);
    try {
      const meeting = await api.startMeeting({
        title: trimmed,
        participantIds,
      });
      setResult(meeting);
      props.onClearMeetingTurn?.();
    } catch (cause) {
      setError(
        failureText(
          cause,
          "Gagal memulai rapat. Periksa koneksi lalu coba lagi.",
        ),
      );
      props.onClearMeetingTurn?.();
    } finally {
      markMeetingParticipants(null);
      setStarting(false);
    }
  }

  async function copyMinutes(meeting: MeetingResult): Promise<void> {
    const text = meeting.minutes
      .map((minute) => minute.content?.trim() ?? "")
      .filter((content) => content.length > 0)
      .join("\n\n");

    if (text.length === 0) {
      setCopyStatus("Belum ada notulen untuk disalin.");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("Notulen tersalin.");
    } catch {
      setCopyStatus("Gagal menyalin notulen.");
    }
  }

  async function endMeeting(): Promise<void> {
    const current = result();
    if (current === null) return;

    props.onClearMeetingTurn?.();
    if (ending()) return;

    setEnding(true);
    setError("");
    try {
      const stored = await api.getMeeting(current.meeting.id);
      if (stored !== null) setResult(stored);
    } catch (cause) {
      setError(
        failureText(
          cause,
          "Tidak bisa memuat notulen tersimpan. Salinan terakhir tetap tampil.",
        ),
      );
    } finally {
      setEnding(false);
    }
  }

  onCleanup(() => markMeetingParticipants(null));

  onMount(async () => {
    try {
      const list = await api.listAgents();
      setAgents(Array.isArray(list) ? list : []);
    } catch (cause) {
      setError(
        failureText(cause, "Tidak bisa memuat agent. Coba lagi nanti."),
      );
    } finally {
      setLoading(false);
    }
  });

  return (
    <div class="flex flex-col gap-3">
      <div>
        <h4 class="text-sm font-bold">Meeting</h4>
        <p class="text-[11px] text-ink-soft">
          Pilih minimal dua agent, lalu mulai rapat.
        </p>
      </div>

      <label class="flex flex-col gap-1 text-[11.5px] text-ink-soft">
        Judul rapat
        <input
          class="min-h-11 rounded-[9px] border border-line bg-[var(--input-bg)] px-3 text-[13px] text-ink outline-none placeholder:text-ink-soft/70 focus:border-accent focus:ring-2 focus:ring-accent/20"
          type="text"
          aria-label="Judul rapat"
          value={title()}
          onInput={(event) => setTitle(event.currentTarget.value)}
        />
      </label>

      <div class="flex flex-col gap-2" aria-label="Peserta meeting">
        <Show
          when={agents().length > 0}
          fallback={
            <p class="text-[11.5px] text-ink-soft">
              {loading() ? "Memuat agent…" : "Belum ada agent yang bisa diundang."}
            </p>
          }
        >
          <For each={agents()}>
            {(agent) => {
              const picked = () => selected().includes(agent.id);
              const speaking = () =>
                props.meetingTurn?.agentId === agent.id;
              return (
                <button
                  class="flex min-h-11 items-center gap-2.5 rounded-[10px] border px-2.5 py-1.5 text-left disabled:opacity-60"
                  classList={{
                    "border-meet bg-panel": speaking(),
                    "border-accent bg-accent-soft": !speaking() && picked(),
                    "border-line bg-panel-2": !speaking() && !picked(),
                  }}
                  type="button"
                  aria-pressed={picked()}
                  aria-label={`Pilih ${agent.name}`}
                  data-speaking={speaking() ? "true" : undefined}
                  disabled={starting()}
                  onClick={() => toggleParticipant(agent.id)}
                >
                  <span
                    class="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-[11px] font-bold text-white"
                    style={{ "background-color": agent.color ?? "var(--accent)" }}
                    aria-hidden="true"
                  >
                    {initials(agent.name)}
                  </span>
                  <span class="min-w-0 flex-1">
                    <b class="block truncate text-[12.5px]">{agent.name}</b>
                    <small class="block truncate text-[11px] text-ink-soft">
                      {agent.role}
                    </small>
                  </span>
                  <Show when={speaking()}>
                    <span class="flex-none rounded-full bg-meet/10 px-2 py-0.5 text-[10.5px] font-semibold text-meet">
                      sedang bicara
                    </span>
                  </Show>
                  <Show when={picked()}>
                    <span
                      class="flex-none text-[11px] font-bold text-accent"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                  </Show>
                </button>
              );
            }}
          </For>
        </Show>
      </div>

      <Show when={props.meetingTurn}>
        {(turn) => (
          <p
            class="rounded-lg border border-meet/40 bg-meet/10 px-2.5 py-2 text-[12px] leading-relaxed text-ink"
            data-testid="meeting-turn"
            aria-live="polite"
          >
            <b>{speakerName()}</b>: {turn().text}
          </p>
        )}
      </Show>

      <Show when={error()}>
        <p
          class="rounded-lg border border-[#d9a08e] bg-[#fbebe5] px-2.5 py-2 text-[12px] leading-relaxed text-[#8f3c27]"
          role="alert"
        >
          {error()}
        </p>
      </Show>

      <button
        class="min-h-11 rounded-[9px] bg-accent px-3 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        type="button"
        disabled={starting() || selectedAgents().length < 2}
        onClick={() => void start()}
      >
        {starting() ? "Merapat…" : "Mulai meeting"}
      </button>

      <Show when={result()}>
        {(meeting) => (
          <section
            class="flex flex-col gap-2 rounded-[10px] border border-line bg-panel-2 p-3"
            aria-label="Notulen rapat"
            data-testid="meeting-minutes"
          >
            <div class="flex items-center justify-between gap-2">
              <b class="text-[12.5px]">{meeting().meeting.title}</b>
              <span class="rounded-full border border-line bg-panel px-2 py-0.5 text-[10.5px] text-ink-soft">
                {meeting().meeting.status ?? "selesai"}
              </span>
            </div>
            <p class="text-[11px] text-ink-soft">
              Peserta:{" "}
              {meetingParticipants()
                .map((agent) => agent.name)
                .join(", ")}
            </p>
            <For each={meeting().minutes}>
              {(minute) => (
                <p class="whitespace-pre-wrap text-[12px] leading-relaxed">
                  {minute.content}
                </p>
              )}
            </For>
            <div class="flex flex-wrap gap-2">
              <button
                class="min-h-11 rounded-[9px] border border-line bg-panel px-3 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-60"
                type="button"
                onClick={() => void copyMinutes(meeting())}
              >
                Salin notulen
              </button>
              <button
                class="min-h-11 rounded-[9px] border border-line bg-panel px-3 text-[12.5px] font-semibold text-ink hover:border-accent disabled:opacity-60"
                type="button"
                disabled={ending()}
                onClick={() => void endMeeting()}
              >
                {ending() ? "Memuat notulen…" : "Akhiri meeting"}
              </button>
            </div>
            <Show when={copyStatus()}>
              {(status) => (
                <p
                  class="text-[11.5px] text-ink-soft"
                  role="status"
                  aria-live="polite"
                >
                  {status()}
                </p>
              )}
            </Show>
          </section>
        )}
      </Show>
    </div>
  );
}
