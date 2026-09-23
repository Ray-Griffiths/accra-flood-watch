/**
 * Risk levels and the plain-language explanation that must accompany them.
 *
 * Every level explains itself. This is a functional requirement rather than a
 * nicety: a number a user cannot interrogate is a number they will not trust,
 * and an untrusted warning is an ignored warning.
 */

export type RiskLevel = "low" | "watch" | "high" | "confirmed";

/** What the score was computed from. Shown to the user, not decoration. */
export type RiskBasis =
  | "terrain-only"
  | "terrain-and-reports"
  | "terrain-and-forecast";

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

/**
 * The deepest water among a set of reported depths, or undefined if there are
 * none.
 *
 * Ordering is read off `DEPTH_LEVELS`, which is already ascending, rather than
 * restated as a second list. A separate severity ranking would be one more
 * place to forget when a depth is added, and the failure would be silent: an
 * alert quietly naming the second-worst water anybody reported.
 */
export function strongestDepth(
  depths: readonly DepthLevel[],
): DepthLevel | undefined {
  let strongest: DepthLevel | undefined;
  let rank = -1;

  for (const depth of depths) {
    const index = DEPTH_LEVELS.indexOf(depth);
    if (index > rank) {
      rank = index;
      strongest = depth;
    }
  }

  return strongest;
}

// ---------------------------------------------------------------------------
// "The water has gone"
// ---------------------------------------------------------------------------

/**
 * What a report asserts. Absent on rows written before clearing existed, and
 * those are all observations of water, so the default is `flooded`.
 */
export type ReportCondition = "flooded" | "cleared";

export function isReportCondition(value: unknown): value is ReportCondition {
  return value === "flooded" || value === "cleared";
}

/**
 * Clearing is deliberately harder than confirming, and the asymmetry is the
 * whole safety argument.
 *
 * Two people saying "there is water here" marks a cell confirmed. It takes
 * THREE saying it has gone, inside a much shorter window, to lift that. The
 * reason is that the two errors are not comparable: a false alarm sends
 * somebody the long way round, and a false all-clear sends them into water.
 *
 * The window is short because "it has gone" decays fast in a way "there is
 * water" does not. Standing water an hour old is still probably there; an
 * hour-old report that a road had drained tells you very little about now.
 */
export const CLEARING_REPORT_COUNT = 3;
export const CLEARING_WINDOW_MINUTES = 60;

export interface ConditionedReport {
  condition?: ReportCondition;
  submittedAt: string;
}

function conditionOf(report: ConditionedReport): ReportCondition {
  return report.condition ?? "flooded";
}

function ageMinutesOf(report: ConditionedReport, now: Date): number {
  const then = Date.parse(report.submittedAt);
  return Number.isNaN(then) ? Number.POSITIVE_INFINITY : (now.getTime() - then) / 60_000;
}

/**
 * Have residents cleared this cell?
 *
 * Requires enough recent agreement AND that nobody has reported water since
 * that agreement began. The second clause is what makes this safe: if water
 * comes back, the newest flooding report is newer than the clears, the clear
 * is stale, and the cell floods again without waiting for anything to expire.
 *
 * Note what a `true` here does NOT mean. It does not assert that the cell is
 * safe. It only means the community's evidence of water has been withdrawn,
 * so the cell falls back to what the terrain and the forecast say on their
 * own. Clearing can never push a cell below that floor, because it never adds
 * anything -- it only stops reports counting.
 */
export function isClearedByReports(
  reports: readonly ConditionedReport[],
  now: Date,
): boolean {
  const recentClears = reports
    .filter(
      (report) =>
        conditionOf(report) === "cleared" &&
        ageMinutesOf(report, now) >= 0 &&
        ageMinutesOf(report, now) <= CLEARING_WINDOW_MINUTES,
    )
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));

  if (recentClears.length < CLEARING_REPORT_COUNT) return false;

  // The moment the agreement started. Anything reporting water after this
  // overrides it.
  const clearedFrom = Date.parse(recentClears[0]!.submittedAt);

  const waterSince = reports.some(
    (report) =>
      conditionOf(report) === "flooded" && Date.parse(report.submittedAt) > clearedFrom,
  );

  return !waterSince;
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

// ---------------------------------------------------------------------------
// Terrain bands
// ---------------------------------------------------------------------------

/**
 * How this ground behaves when it rains. A permanent property, not a warning.
 *
 * Risk levels answer "is it dangerous now"; on a dry day the honest answer for
 * the whole city is no, and the map goes uniformly quiet. That is correct, and
 * it also throws away the one thing this project knows that nobody else
 * publishes: which specific streets go under first. The terrain band is that
 * knowledge, kept in its own vocabulary so it can never be mistaken for a
 * live warning.
 */
export type TerrainBand = "floods-first" | "floods-heavy" | "usually-dry";

export const TERRAIN_BANDS: readonly TerrainBand[] = [
  "floods-first",
  "floods-heavy",
  "usually-dry",
];

/**
 * Banded at the same cut points as the risk levels.
 *
 * Not a coincidence worth avoiding: susceptibility IS the score on a cell with
 * no forecast and no reports, so a cell that reads `high` from terrain alone
 * must not fall into a different band than the one the level would give it.
 * Two sets of cut points over the same number would eventually disagree.
 */
export function terrainBand(susceptibility: number): TerrainBand {
  if (susceptibility >= HIGH_THRESHOLD) return "floods-first";
  if (susceptibility >= WATCH_THRESHOLD) return "floods-heavy";
  return "usually-dry";
}

const BAND_OUTLOOK: Record<TerrainBand, string> = {
  "floods-first": "this area floods readily when it rains hard",
  "floods-heavy": "this area can flood in heavy rain",
  "usually-dry": "this area drains reasonably well",
};

/** Where the ground sits relative to the drain it would overflow from. */
function heightPhrase(hand: number): string {
  if (hand <= 1) return "ground here is barely above the nearest drain";
  if (hand <= 4) return `ground here is about ${hand.toFixed(1)}m above the nearest drain`;
  return `ground here sits ${hand.toFixed(0)}m above the nearest drain`;
}

/**
 * The terrain reading in one plain sentence, with no reference to today.
 *
 * This is what the map says when it is showing ground rather than weather, so
 * it deliberately carries no forecast caveat: the view around it already
 * states that no rain is coming. Appending "no forecast yet" here would read
 * as a fault when it is in fact the point.
 */
export function describeTerrain(
  susceptibility: number,
  hand: number,
  historicalFloodPoint?: string,
): string {
  const parts = [heightPhrase(hand)];
  if (historicalFloodPoint) {
    parts.push(`flooding has been recorded at ${historicalFloodPoint}`);
  }
  const outlook = BAND_OUTLOOK[terrainBand(susceptibility)];
  return `${capitalise(parts.join(", "))}. ${capitalise(outlook)}.`;
}

/**
 * Explain a cell the scoring job has never reached.
 *
 * Says what it knows and, just as importantly, what it does not: showing a
 * terrain score as though it were a live forecast would overstate what the map
 * actually knows.
 */
export function explainTerrain(
  susceptibility: number,
  hand: number,
  historicalFloodPoint?: string,
): string {
  const parts = [heightPhrase(hand)];
  if (historicalFloodPoint) {
    parts.push(`flooding has been recorded at ${historicalFloodPoint}`);
  }
  const outlook = BAND_OUTLOOK[terrainBand(susceptibility)];
  return `${parts.join(", ")}. Based on terrain only — ${outlook}. No rainfall forecast yet.`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
