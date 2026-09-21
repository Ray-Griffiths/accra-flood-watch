/**
 * Risk levels and the plain-language explanation that must accompany them.
 *
 * Every level explains itself. This is a functional requirement rather than a
 * nicety: a number a user cannot interrogate is a number they will not trust,
 * and an untrusted warning is an ignored warning.
 */

export type RiskLevel = "low" | "watch" | "high" | "confirmed";

/** What the score was computed from. Shown to the user, not decoration. */
export type RiskBasis = "terrain-only" | "terrain-and-forecast" | "reports";

export const WATCH_THRESHOLD = 45;
export const HIGH_THRESHOLD = 70;

/** Reports at or above this depth count toward confirming flooding. */
export const CONFIRMING_DEPTHS = ["knee", "waist", "impassable"] as const;

/** Independent reports within the window required to confirm flooding. */
export const CONFIRMATION_REPORT_COUNT = 2;
export const CONFIRMATION_WINDOW_MINUTES = 180;

export const DEPTH_LEVELS = ["ankle", "knee", "waist", "impassable"] as const;
export type DepthLevel = (typeof DEPTH_LEVELS)[number];

export function isDepthLevel(value: unknown): value is DepthLevel {
  return typeof value === "string" && (DEPTH_LEVELS as readonly string[]).includes(value);
}

export const DEPTH_LABELS: Record<DepthLevel, string> = {
  ankle: "ankle deep",
  knee: "knee deep",
  waist: "waist deep",
  impassable: "impassable",
};

export function levelFromScore(score: number): RiskLevel {
  if (score >= HIGH_THRESHOLD) return "high";
  if (score >= WATCH_THRESHOLD) return "watch";
  return "low";
}

/**
 * Explain a terrain-only score in one plain sentence.
 *
 * Used until the hourly scoring job exists. It says what it knows and, just as
 * importantly, what it does not: showing a terrain score as though it were a
 * live forecast would overstate what the map actually knows.
 */
export function explainTerrain(
  susceptibility: number,
  hand: number,
  historicalFloodPoint?: string,
): string {
  const parts: string[] = [];

  if (hand <= 1) {
    parts.push("ground here is barely above the nearest drain");
  } else if (hand <= 4) {
    parts.push(`ground here is about ${hand.toFixed(1)}m above the nearest drain`);
  } else {
    parts.push(`ground here sits ${hand.toFixed(0)}m above the nearest drain`);
  }

  if (historicalFloodPoint) {
    parts.push(`flooding has been recorded at ${historicalFloodPoint}`);
  }

  const level = levelFromScore(susceptibility);
  const outlook =
    level === "high"
      ? "this area floods readily when it rains hard"
      : level === "watch"
        ? "this area can flood in heavy rain"
        : "this area drains reasonably well";

  return `${parts.join(", ")}. Based on terrain only — ${outlook}. No rainfall forecast yet.`;
}
