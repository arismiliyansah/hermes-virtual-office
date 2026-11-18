export type Theme = "day" | "night";

export const themeStorageKey = "hermes-office-theme";

/** A valid stored choice wins; otherwise follow the OS preference. */
export function resolveInitialTheme(
  prefersDark: boolean,
  stored: string | null,
): Theme {
  if (stored === "day" || stored === "night") return stored;
  return prefersDark ? "night" : "day";
}
