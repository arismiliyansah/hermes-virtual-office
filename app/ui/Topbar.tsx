import { Show, createSignal } from "solid-js";
import type { Theme } from "../theme";

export interface TopbarProps {
  theme: Theme;
  /** Browser <-> Worker websocket state. */
  wsConnected: boolean;
  /** Last REST poll to Hermes failed. */
  hermesFailed: boolean;
  /** Last REST poll is older than the stale threshold. */
  hermesStale?: boolean;
  onThemeChange: (theme: Theme) => void;
  onLogout?: () => void | Promise<void>;
}

export function Topbar(props: TopbarProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [loggingOut, setLoggingOut] = createSignal(false);

  async function logout(): Promise<void> {
    if (loggingOut()) return;
    setLoggingOut(true);
    try {
      await props.onLogout?.();
    } finally {
      setLoggingOut(false);
      setMenuOpen(false);
    }
  }

  return (
    <header class="relative flex h-14 flex-none items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3.5 sm:px-[18px]">
      <div class="flex items-center gap-2">
        <span class="gem h-[18px] w-[18px]" aria-hidden="true" />
        <span class="text-[15px] font-bold">Hermes Office</span>
      </div>

      <span class="hidden border-l border-line pl-3.5 text-[13px] text-ink-soft sm:inline">
        Kantor Pusat
      </span>

      <span class="flex-1" />

      <div
        class="flex min-h-8 items-center gap-2 rounded-full border border-line bg-panel-2 px-2 text-[12.5px] text-ink-soft sm:px-3"
        aria-label={`Realtime ${props.wsConnected ? "terhubung" : "terputus"}`}
        role="status"
      >
        <i
          class="h-2 w-2 rounded-full"
          classList={{
            "bg-sage": props.wsConnected,
            "bg-idle": !props.wsConnected,
          }}
          aria-hidden="true"
        />
        <span class="hidden min-[861px]:inline">
          {props.wsConnected ? "terhubung" : "terputus"}
        </span>
      </div>

      <div
        class="flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11px] font-semibold"
        classList={{
          "border-[#d9a08e] bg-[#fbebe5] text-[#8f3c27]": props.hermesFailed,
          "border-line bg-panel-2 text-ink-soft": !props.hermesFailed,
        }}
        role="status"
        data-testid="hermes-status"
        aria-label={
          props.hermesFailed
            ? "Mesin terputus"
            : props.hermesStale
              ? "Data mesin tertunda"
              : "Mesin terhubung"
        }
      >
        <i
          class="h-2 w-2 flex-none rounded-full"
          classList={{
            "bg-[#b4523d]": props.hermesFailed,
            "bg-sage": !props.hermesFailed,
          }}
          aria-hidden="true"
        />
        <span>
          {props.hermesFailed
            ? "Mesin terputus"
            : props.hermesStale
              ? "Data tertunda"
              : "Mesin terhubung"}
        </span>
      </div>

      <div
        class="flex overflow-hidden rounded-lg border border-line"
        role="group"
        aria-label="Tema"
      >
        <button
          class="min-h-11 px-2.5 text-xs font-semibold"
          classList={{
            "bg-panel-2 text-ink": props.theme === "day",
            "text-ink-soft": props.theme !== "day",
          }}
          type="button"
          aria-pressed={props.theme === "day"}
          onClick={() => props.onThemeChange("day")}
        >
          Siang
        </button>
        <button
          class="min-h-11 px-2.5 text-xs font-semibold"
          classList={{
            "bg-panel-2 text-ink": props.theme === "night",
            "text-ink-soft": props.theme !== "night",
          }}
          type="button"
          aria-pressed={props.theme === "night"}
          onClick={() => props.onThemeChange("night")}
        >
          Malam
        </button>
      </div>

      <div class="relative">
        <button
          class="flex min-h-11 min-w-11 items-center justify-center rounded-full"
          type="button"
          aria-label="Akun owner"
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span class="flex h-8 w-8 items-center justify-center rounded-full bg-[#8a6f4d] text-[12px] font-bold text-white">
            AR
          </span>
        </button>

        <Show when={menuOpen()}>
          <div
            class="absolute right-0 top-full z-20 mt-1 min-w-40 rounded-[10px] border border-line bg-panel p-1.5 shadow-lg"
            role="menu"
            aria-label="Menu akun"
          >
            <button
              class="min-h-11 w-full rounded-lg px-3 text-left text-[13px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60"
              type="button"
              role="menuitem"
              disabled={loggingOut()}
              onClick={() => void logout()}
            >
              {loggingOut() ? "Keluar…" : "Keluar"}
            </button>
          </div>
        </Show>
      </div>
    </header>
  );
}
