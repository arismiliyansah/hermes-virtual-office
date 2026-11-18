import { createSignal } from "solid-js";
import { ApiError } from "../api";

export interface LoginProps {
  onSubmit: (email: string, password: string) => Promise<void>;
}

export function Login(props: LoginProps) {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy()) return;

    setError("");
    setBusy(true);

    try {
      await props.onSubmit(email().trim(), password());
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 401
          ? "Email atau kata sandi tidak cocok."
          : "Tidak bisa masuk. Periksa koneksi lalu coba lagi.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-ink">
      <div class="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 shadow-[0_8px_24px_rgba(47,43,37,.10)] sm:p-8">
        <div class="flex items-center gap-2.5">
          <span class="gem h-5 w-5" aria-hidden="true" />
          <span class="text-[15px] font-bold">Hermes Office</span>
        </div>
        <p class="mt-1 pl-[30px] text-[12.5px] text-ink-soft">Kantor Pusat</p>

        <h1 class="mt-7 text-lg font-bold">Masuk</h1>
        <p class="mt-1 text-[13px] leading-relaxed text-ink-soft">
          Gunakan akun owner untuk membuka kantor.
        </p>

        <form
          class="mt-5 flex flex-col gap-4"
          aria-label="Masuk"
          onSubmit={(event) => void submit(event)}
        >
          <label class="flex flex-col gap-1.5 text-[12.5px] font-semibold">
            Email
            <input
              class="min-h-11 rounded-[9px] border border-line bg-[var(--input-bg)] px-3 text-[13.5px] font-normal text-ink outline-none placeholder:text-ink-soft/70 focus:border-accent focus:ring-2 focus:ring-accent/20"
              type="email"
              name="email"
              autocomplete="username"
              required
              value={email()}
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
          </label>

          <label class="flex flex-col gap-1.5 text-[12.5px] font-semibold">
            Kata sandi
            <input
              class="min-h-11 rounded-[9px] border border-line bg-[var(--input-bg)] px-3 text-[13.5px] font-normal text-ink outline-none placeholder:text-ink-soft/70 focus:border-accent focus:ring-2 focus:ring-accent/20"
              type="password"
              name="password"
              autocomplete="current-password"
              required
              value={password()}
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
          </label>

          <p
            class="min-h-4 text-[12.5px] text-[#a8422f]"
            role="alert"
            aria-live="polite"
          >
            {error()}
          </p>

          <button
            class="min-h-11 rounded-[9px] bg-accent px-4 text-[13.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            type="submit"
            disabled={busy()}
          >
            {busy() ? "Memeriksa…" : "Masuk"}
          </button>
        </form>
      </div>
    </main>
  );
}
