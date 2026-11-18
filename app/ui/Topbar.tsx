import type { Theme } from "../theme";

export function Topbar(props: {
  theme: Theme;
  connected: boolean;
  onThemeChange: (theme: Theme) => void;
}) {
  return (
    <header class="flex h-14 flex-none items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3.5 sm:px-[18px]">
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
        aria-label="Status koneksi"
        role="status"
      >
        <i
          class="h-2 w-2 rounded-full"
          classList={{
            "bg-sage": props.connected,
            "bg-idle": !props.connected,
          }}
          aria-hidden="true"
        />
        <span class="hidden min-[861px]:inline">
          {props.connected ? "terhubung" : "terputus"}
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

      <button
        class="flex min-h-11 min-w-11 items-center justify-center rounded-full"
        type="button"
        aria-label="Akun owner"
      >
        <span class="flex h-8 w-8 items-center justify-center rounded-full bg-[#8a6f4d] text-[12px] font-bold text-white">
          AR
        </span>
      </button>
    </header>
  );
}
