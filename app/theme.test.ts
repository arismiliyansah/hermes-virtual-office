import { describe, expect, it } from "vitest";
import { resolveInitialTheme, themeStorageKey } from "./theme";

describe("theme resolution", () => {
  it("uses the stored theme before the OS preference", () => {
    expect(resolveInitialTheme(true, "day")).toBe("day");
    expect(resolveInitialTheme(false, "night")).toBe("night");
  });

  it("falls back to prefers-color-scheme when nothing valid is stored", () => {
    expect(resolveInitialTheme(true, null)).toBe("night");
    expect(resolveInitialTheme(false, null)).toBe("day");
    expect(resolveInitialTheme(true, "sepia")).toBe("night");
    expect(resolveInitialTheme(false, "")).toBe("day");
  });

  it("keeps the stable storage key", () => {
    expect(themeStorageKey).toBe("hermes-office-theme");
  });
});
