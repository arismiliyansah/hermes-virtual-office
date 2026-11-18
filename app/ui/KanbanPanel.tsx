import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import * as api from "../api";
import type { Agent, Task } from "../api";

const COLUMNS = [
  { key: "todo", label: "To do" },
  { key: "doing", label: "Doing" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

const KNOWN_STATUSES = new Set<string>(COLUMNS.map((column) => column.key));

function columnFor(task: Task): ColumnKey {
  const status = task.status ?? "";
  return KNOWN_STATUSES.has(status) ? (status as ColumnKey) : "todo";
}

function unknownStatus(task: Task): string | null {
  const status = task.status;
  return status !== null && status.length > 0 && !KNOWN_STATUSES.has(status)
    ? status
    : null;
}

function canApprove(task: Task): boolean {
  return (
    task.status === "review" ||
    (Boolean(task.office_label) && task.status !== "done")
  );
}

function titleFor(task: Task): string {
  const title = task.title?.trim();
  return title && title.length > 0 ? title : "Tanpa judul";
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

export function KanbanPanel() {
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [showForm, setShowForm] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [owner, setOwner] = createSignal("");
  const [creating, setCreating] = createSignal(false);

  const byColumn = createMemo<Record<ColumnKey, Task[]>>(() => {
    const grouped: Record<ColumnKey, Task[]> = {
      todo: [],
      doing: [],
      review: [],
      done: [],
    };
    for (const task of tasks()) grouped[columnFor(task)].push(task);
    return grouped;
  });

  const agentById = createMemo(
    () => new Map(agents().map((agent) => [agent.id, agent])),
  );

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const list = await api.listTasks();
      setTasks(Array.isArray(list) ? list : []);
      setError("");
    } catch (cause) {
      setError(
        failureText(cause, "Tidak bisa memuat task. Periksa koneksi lalu coba lagi."),
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadAgents(): Promise<void> {
    try {
      const list = await api.listAgents();
      setAgents(Array.isArray(list) ? list : []);
    } catch {
      // Owner names are a convenience; the board still works without them.
    }
  }

  async function approve(task: Task): Promise<void> {
    if (pendingId() !== null) return;

    setPendingId(task.id);
    setError("");
    try {
      await api.updateTaskStatus(task.id, "done");
      await load();
    } catch (cause) {
      setError(
        failureText(cause, `Gagal menyetujui "${titleFor(task)}". Coba lagi.`),
      );
    } finally {
      setPendingId(null);
    }
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (creating()) return;

    const trimmed = title().trim();
    if (trimmed.length === 0) {
      setError("Judul tugas wajib diisi.");
      return;
    }

    setCreating(true);
    setError("");
    try {
      await api.createTask({
        title: trimmed,
        ownerAgentId: owner().length > 0 ? owner() : undefined,
      });
      setTitle("");
      setOwner("");
      setShowForm(false);
      await load();
    } catch (cause) {
      setError(failureText(cause, "Gagal membuat tugas. Coba lagi."));
    } finally {
      setCreating(false);
    }
  }

  onMount(() => {
    void load();
    void loadAgents();
  });

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <div>
          <h4 class="text-sm font-bold">Kanban</h4>
          <p class="text-[11px] text-ink-soft">
            {loading() ? "Memuat task…" : `${tasks().length} task dari Hermes`}
          </p>
        </div>
        <button
          class="min-h-11 flex-none rounded-[9px] border border-line bg-panel-2 px-3 text-[12.5px] font-semibold text-ink hover:border-accent"
          type="button"
          aria-expanded={showForm()}
          onClick={() => setShowForm((value) => !value)}
        >
          Tugas baru
        </button>
      </div>

      <Show when={showForm()}>
        <form
          class="flex flex-col gap-2 rounded-[10px] border border-line bg-panel-2 p-2.5"
          aria-label="Tugas baru"
          onSubmit={(event) => void create(event)}
        >
          <input
            class="min-h-11 rounded-[9px] border border-line bg-[var(--input-bg)] px-3 text-[13px] text-ink outline-none placeholder:text-ink-soft/70 focus:border-accent focus:ring-2 focus:ring-accent/20"
            type="text"
            aria-label="Judul tugas"
            placeholder="Judul tugas…"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
          <select
            class="min-h-11 rounded-[9px] border border-line bg-[var(--input-bg)] px-2 text-[13px] text-ink outline-none focus:border-accent"
            aria-label="Pemilik"
            value={owner()}
            onChange={(event) => setOwner(event.currentTarget.value)}
          >
            <option value="">Tanpa pemilik</option>
            <For each={agents()}>
              {(agent) => <option value={agent.id}>{agent.name}</option>}
            </For>
          </select>
          <div class="flex justify-end gap-2">
            <button
              class="min-h-11 rounded-[9px] border border-line bg-panel px-3 text-[12.5px] font-semibold text-ink"
              type="button"
              onClick={() => setShowForm(false)}
            >
              Batal
            </button>
            <button
              class="min-h-11 rounded-[9px] bg-accent px-3 text-[12.5px] font-semibold text-white disabled:opacity-60"
              type="submit"
              disabled={creating()}
            >
              {creating() ? "Menyimpan…" : "Simpan"}
            </button>
          </div>
        </form>
      </Show>

      <Show when={error()}>
        <p
          class="rounded-lg border border-[#d9a08e] bg-[#fbebe5] px-2.5 py-2 text-[12px] leading-relaxed text-[#8f3c27]"
          role="alert"
        >
          {error()}
        </p>
      </Show>

      <div class="grid grid-cols-2 gap-2.5">
        <For each={COLUMNS}>
          {(column) => (
            <section
              class="flex min-w-0 flex-col gap-2 rounded-[10px] border border-line bg-panel-2 p-2"
              data-column={column.key}
              aria-label={`Kolom ${column.label}`}
            >
              <h5 class="flex justify-between text-[10.5px] font-semibold uppercase tracking-[.05em] text-ink-soft">
                {column.label}
                <span>{byColumn()[column.key].length}</span>
              </h5>

              <Show when={byColumn()[column.key].length === 0}>
                <p class="rounded-lg border border-dashed border-line px-2 py-3 text-center text-[11px] text-ink-soft">
                  Kosong
                </p>
              </Show>

              <For each={byColumn()[column.key]}>
                {(task) => {
                  const columnKey = columnFor(task);
                  const chip = unknownStatus(task);
                  const ownerAgent = () =>
                    task.owner_agent === null
                      ? null
                      : (agentById().get(task.owner_agent) ?? null);
                  const ownerName = () =>
                    ownerAgent()?.name ?? task.owner_agent ?? "";
                  return (
                    <article
                      class="rounded-lg border border-line bg-[var(--card-bg)] px-2.5 py-2 text-[12.5px] shadow-sm"
                      classList={{
                        "border-l-[3px] border-l-accent bg-accent-soft":
                          columnKey === "review",
                      }}
                    >
                      <p class="leading-snug">{titleFor(task)}</p>

                      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Show when={chip}>
                          {(status) => (
                            <span
                              class="rounded-full border border-[#c9b28a] bg-[#efe3ca] px-2 py-0.5 text-[10.5px] font-semibold text-[#6d5124]"
                              data-testid="status-chip"
                            >
                              {status()}
                            </span>
                          )}
                        </Show>
                        <Show when={task.office_label}>
                          {(label) => (
                            <span
                              class="rounded-full border border-[#e6c88a] bg-[#f8e9c9] px-2 py-0.5 text-[10.5px] font-semibold text-[#8a5a12]"
                              data-testid="office-label"
                            >
                              {label()}
                            </span>
                          )}
                        </Show>
                      </div>

                      <Show when={task.owner_agent}>
                        <div class="mt-2 flex items-center gap-1.5 text-[11px] text-ink-soft">
                          <span
                            class="flex h-4 w-4 flex-none items-center justify-center rounded-[4px] text-[8px] font-bold text-white"
                            style={{
                              "background-color":
                                ownerAgent()?.color ?? "var(--idle)",
                            }}
                            aria-hidden="true"
                          >
                            {initials(ownerName())}
                          </span>
                          <span class="truncate">{ownerName()}</span>
                        </div>
                      </Show>

                      <Show when={canApprove(task)}>
                        <div class="mt-2">
                          <button
                            class="min-h-11 rounded-[9px] bg-accent px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
                            type="button"
                            disabled={pendingId() !== null}
                            onClick={() => void approve(task)}
                          >
                            {pendingId() === task.id ? "Menyetujui…" : "Setujui"}
                          </button>
                        </div>
                      </Show>
                    </article>
                  );
                }}
              </For>
            </section>
          )}
        </For>
      </div>

      <p class="text-[11px] leading-relaxed text-ink-soft">
        Setiap kartu adalah task di Hermes. Status di luar empat kolom tampil di
        To do bersama chip statusnya.
      </p>
    </div>
  );
}
