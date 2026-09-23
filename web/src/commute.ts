/**
 * One saved journey, so the daily question takes one tap.
 *
 * Almost every use of the routing feature is the same trip: home to work, or
 * work to home, checked once in the morning and once at the close of the day.
 * Re-picking both ends on a map every time is the kind of friction that turns
 * a useful tool into one people stop opening.
 *
 * Stored in localStorage and nowhere else. That is not a shortcut, it is the
 * design: a commute is the single most identifying thing this application
 * could hold — it is a home address and a workplace and a time of day — and
 * the project's standing promise is no accounts and nothing on the server
 * that describes a person. Keeping it on the device means the server never
 * learns it, there is nothing to breach, and clearing site data is a complete
 * and verifiable delete.
 */

import type { TravelMode } from "./api.ts";

const KEY = "afw:commute";

export interface SavedCommute {
  origin: [number, number];
  destination: [number, number];
  mode: TravelMode;
  /** What to call it in the button. Chosen from a short fixed list. */
  label: string;
  savedAt: string;
}

function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/**
 * The saved journey, or null.
 *
 * Validates rather than trusting: localStorage is writable by anything else
 * running on this origin, and a malformed entry must read as "none saved"
 * rather than reaching the routing request as NaN coordinates.
 */
export function loadCommute(): SavedCommute | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<SavedCommute>;
    if (!isPosition(parsed.origin) || !isPosition(parsed.destination)) return null;
    if (parsed.mode !== "walking" && parsed.mode !== "driving") return null;

    return {
      origin: parsed.origin,
      destination: parsed.destination,
      mode: parsed.mode,
      label: typeof parsed.label === "string" && parsed.label ? parsed.label : "my usual trip",
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveCommute(commute: Omit<SavedCommute, "savedAt">): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...commute, savedAt: new Date().toISOString() }),
    );
  } catch {
    /* Private browsing or a full quota. Routing itself is unaffected. */
  }
}

export function forgetCommute(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Nothing useful to do. */
  }
}

/**
 * What to offer calling it.
 *
 * A short fixed list rather than a free text field, for two reasons. A text
 * input is one more thing to fill in on a phone in the rain, and a free label
 * invites people to type an address — which would put exactly the identifying
 * detail this feature avoids into storage, and eventually into a screenshot.
 */
export const COMMUTE_LABELS = [
  "my usual trip",
  "to work",
  "to home",
  "to school",
  "to the market",
] as const;
