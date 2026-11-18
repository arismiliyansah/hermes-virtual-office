import { Index, Show, createSignal, onCleanup, onMount } from "solid-js";
import * as api from "../api";
import type { CronJob } from "../api";
import { markCronRunning } from "./officeActivity";

function failureText(cause: unknown, fallback: string): string {
  const status = (cause as { status?: unknown } | null)?.status;
  if (status === 401) {
    return "Sesi berakhir. Masuk lagi untuk melanjutkan.";
  }
  return fallback;
}

export function CronPanel() {
  const [crons, setCrons] = createSignal<CronJob[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal<string | null>(null);
  const [lastRun, setLastRun] = createSignal("");
  let activeCronAgent: string | null = null;

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const list = await api.listCrons();
      setCrons(Array.isArray(list) ? list : []);
      setError("");
    } catch (cause) {
      setError(
        failureText(cause, "Tidak bisa memuat cron. Periksa koneksi lalu coba lagi."),
      );
    } finally {
      setLoading(false);
    }
  }

  async function toggle(job: CronJob): Promise<void> {
    if (pending() !== null) return;

    const nextEnabled = !job.enabled;
    setCrons((previous) =>
      previous.map((item) =>
        item.id === job.id ? { ...item, enabled: nextEnabled } : item,
      ),
    );
    setPending(`${job.id}:toggle`);
    setError("");
    setLastRun("");

    try {
      const updated = await api.setCronEnabled(job.id, nextEnabled);
      setCrons((previous) =>
        previous.map((item) =>
          item.id === job.id ? { ...item, enabled: updated.enabled } : item,
        ),
      );
    } catch (cause) {
      setCrons((previous) =>
        previous.map((item) =>
          item.id === job.id ? { ...item, enabled: job.enabled } : item,
        ),
      );
      setError(
        failureText(
          cause,
          `Gagal mengubah cron "${job.name}". Perubahan dibatalkan.`,
        ),
      );
    } finally {
      setPending(null);
    }
  }

  async function run(job: CronJob): Promise<void> {
    if (pending() !== null) return;

    setPending(`${job.id}:run`);
    setError("");
    setLastRun("");
    activeCronAgent = job.agentId;
    markCronRunning(job.agentId, true);

    try {
      const result = await api.runCron(job.id);
      setLastRun(`Jalan terakhir ${job.name}: ${result.runId}`);
    } catch (cause) {
      setError(
        failureText(cause, `Gagal menjalankan cron "${job.name}". Coba lagi.`),
      );
    } finally {
      markCronRunning(job.agentId, false);
      activeCronAgent = null;
      setPending(null);
    }
  }

  onCleanup(() => {
    if (activeCronAgent !== null) markCronRunning(activeCronAgent, false);
  });

  onMount(() => {
    void load();
  });

  return (
    <div class="flex flex-col gap-3">
      <div>
        <h4 class="text-sm font-bold">Cron</h4>
        <p class="text-[11px] text-ink-soft">
          {loading() ? "Memuat cron…" : `${crons().length} jadwal dari Hermes`}
        </p>
      </div>

      <Show when={error()}>
        <p
          class="rounded-lg border border-[#d9a08e] bg-[#fbebe5] px-2.5 py-2 text-[12px] leading-relaxed text-[#8f3c27]"
          role="alert"
        >
          {error()}
        </p>
      </Show>

      <Show when={lastRun()}>
        {(message) => (
          <p class="rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[11.5px] text-ink-soft">
            {message()}
          </p>
        )}
      </Show>

      <Show
        when={crons().length > 0}
        fallback={
          <p class="text-[11.5px] text-ink-soft">
            {loading() ? "Memuat cron…" : "Belum ada cron dari Hermes."}
          </p>
        }
      >
        <div class="flex flex-col gap-2.5">
          <Index each={crons()}>
            {(job) => {
              const busy = () =>
                pending()?.startsWith(`${job().id}:`) ?? false;
              return (
                <div class="flex flex-col gap-2 rounded-[10px] border border-line bg-panel-2 px-3 py-2.5">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <b class="block truncate text-[13px]">{job().name}</b>
                      <small class="block truncate text-[11.5px] text-ink-soft">
                        {job().schedule}
                      </small>
                    </div>
                    <span
                      class="flex-none rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] font-semibold"
                      classList={{
                        "text-sage": job().enabled,
                        "text-ink-soft": !job().enabled,
                      }}
                      data-testid="cron-status"
                    >
                      {job().enabled ? "aktif" : "nonaktif"}
                    </span>
                  </div>

                  <div class="flex items-center gap-2">
                    <button
                      class="min-h-11 min-w-11 flex-none rounded-[9px] border px-3 text-[12px] font-semibold disabled:opacity-60"
                      classList={{
                        "border-sage bg-sage/10 text-sage": job().enabled,
                        "border-line bg-panel text-ink-soft": !job().enabled,
                      }}
                      type="button"
                      role="switch"
                      aria-checked={job().enabled}
                      aria-label={job().name}
                      disabled={busy()}
                      onClick={() => void toggle(job())}
                    >
                      {job().enabled ? "Nonaktifkan" : "Aktifkan"}
                    </button>

                    <button
                      class="min-h-11 min-w-11 flex-none rounded-[9px] border border-line bg-panel px-3 text-[12px] font-semibold text-ink hover:border-accent disabled:opacity-60"
                      type="button"
                      aria-label={`Jalankan ${job().name}`}
                      disabled={busy()}
                      onClick={() => void run(job())}
                    >
                      {pending() === `${job().id}:run`
                        ? "Menjalankan…"
                        : "Jalankan"}
                    </button>
                  </div>
                </div>
              );
            }}
          </Index>
        </div>
      </Show>
    </div>
  );
}
