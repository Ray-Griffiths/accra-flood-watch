/**
 * Which theme the interface is wearing, and who decided.
 *
 * Dark is the condition this app is opened in -- rain, often after dark. But a
 * dark map is genuinely harder to read in direct midday sun, so the light pair
 * is not a preference bolted on afterwards, it is the answer to that problem.
 *
 * Storage is treated as hostile throughout: private browsing and locked-down
 * profiles both throw on access, and a flood map that fails to render because
 * it could not read a colour preference would be a poor trade.
 */

export type Theme = "light" | "dark";
export type ThemeChoice = Theme | "system";

export const THEME_STORAGE_KEY = "afw.theme";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/** Anything unrecognised means "nobody has chosen", never a hard default. */
export function readStoredChoice(storage: StorageLike): ThemeChoice {
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isChoice(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function storeChoice(storage: StorageLike, choice: ThemeChoice): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // A preference we cannot persist is still a preference we can honour for
    // this session. Failing here must never reach the user.
  }
}

/**
 * A manual choice wins. Absent one, the system decides -- and keeps deciding,
 * so the app follows a phone that switches at dusk.
 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  if (choice === "light" || choice === "dark") return choice;
  return prefersDark ? "dark" : "light";
}

/** The switch acts on what is on screen, not on what was last stored. */
export function nextChoice(current: Theme): ThemeChoice {
  return current === "dark" ? "light" : "dark";
}
