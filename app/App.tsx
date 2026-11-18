import { Show, createSignal, onMount } from "solid-js";
import * as api from "./api";
import { Dock } from "./ui/Dock";
import { Login } from "./ui/Login";
import { Topbar } from "./ui/Topbar";

type Mode = "loading" | "login" | "office";

function Loading() {
  return (
    <div class="grid h-dvh place-items-center bg-bg text-sm text-ink-soft">
      Memuat kantor…
    </div>
  );
}

function OfficePlaceholder() {
  return (
    <section
      class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
      aria-label="Kantor"
    >
      <div class="absolute left-4 top-4 rounded-lg border border-line bg-panel/90 px-3 py-2 text-[11.5px] text-ink-soft shadow-sm">
        Pratinjau kantor · 6 meja
      </div>
      <div class="max-w-md text-center">
        <div class="gem mx-auto h-12 w-12" aria-hidden="true" />
        <h1 class="mt-4 text-xl font-bold tracking-tight">Kantor Pusat</h1>
        <p class="mt-2 text-sm leading-relaxed text-ink-soft">
          Panggung isometrik dan aktivitas agent akan tampil di sini. Untuk
          sementara, ruang ini disiapkan agar layout desktop dan mobile bisa
          diuji.
        </p>
        <div class="mt-5 flex flex-wrap justify-center gap-2 text-[11.5px] text-ink-soft">
          <span class="rounded-full border border-line bg-panel px-3 py-1.5">
            <i class="mr-1.5 inline-block h-2 w-2 rounded-full bg-sage" />
            bekerja
          </span>
          <span class="rounded-full border border-line bg-panel px-3 py-1.5">
            <i class="mr-1.5 inline-block h-2 w-2 rounded-full bg-meet" />
            meeting
          </span>
          <span class="rounded-full border border-line bg-panel px-3 py-1.5">
            <i class="mr-1.5 inline-block h-2 w-2 rounded-full bg-idle" />
            menganggur
          </span>
        </div>
      </div>
      <div class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line bg-panel/90 px-3 py-1.5 text-[11px] text-ink-soft shadow-sm">
        cubit untuk zoom · geser untuk pan
      </div>
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
            <OfficePlaceholder />
            <Dock />
          </main>
        </div>
      </Show>
    </Show>
  );
}
