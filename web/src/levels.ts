/**
 * How a risk level presents itself.
 *
 * The rule from the project plan is that levels must differ by *shape and
 * label* as well as by colour: the user is outdoors in glare, possibly
 * colour-blind, and a map that encodes its only warning in hue is a map that
 * fails exactly the people it was built for.
 *
 * So each level carries three independent signals:
 *   - a colour,
 *   - a fill pattern (dots, hatch, cross-hatch, solid),
 *   - a word.
 *
 * Any one of them alone is enough to read the map.
 *
 * The wording describes the CURRENT situation, not the ground. Before the
 * hourly scoring job existed these read as terrain descriptions ("floods
 * readily when it rains hard"), which stopped being true the moment the score
 * started responding to the forecast: on a dry day a flood-prone street is
 * genuinely not a concern right now, and saying otherwise every day is how a
 * warning gets ignored on the day it matters.
 */

import { t } from "./i18n.ts";

export type RiskLevel = "low" | "watch" | "high" | "confirmed";

export const RISK_LEVELS: readonly RiskLevel[] = ["low", "watch", "high", "confirmed"];

export interface LevelStyle {
  /** The word shown on the cell and in the legend. Never abbreviated away. */
  label: string;
  /** One line a person can act on, for the legend. */
  meaning: string;
  /**
   * Colour-blind-distinguishable by lightness as well as hue, so the ramp
   * still reads as an ordering under deuteranopia or in direct sun.
   */
  colour: string;
  /** Pattern id registered with the map. The shape channel. */
  pattern: string;
  /** Outline weight. Danger gets a heavier edge, another non-colour cue. */
  outlineWidth: number;
  opacity: number;
}

export const LEVEL_STYLES: Record<RiskLevel, LevelStyle> = {
  low: {
    label: "Low",
    meaning: "No particular concern right now",
    colour: "#2b83ba",
    pattern: "risk-dots",
    outlineWidth: 0.5,
    opacity: 0.25,
  },
  watch: {
    label: "Watch",
    meaning: "Could develop — stay aware",
    colour: "#e08214",
    pattern: "risk-hatch",
    outlineWidth: 1,
    opacity: 0.4,
  },
  high: {
    label: "High",
    meaning: "Flooding likely — avoid if you can",
    colour: "#d7301f",
    pattern: "risk-cross",
    outlineWidth: 1.5,
    opacity: 0.45,
  },
  confirmed: {
    label: "Flooded now",
    meaning: "People are reporting water now",
    colour: "#6b0000",
    pattern: "risk-solid",
    outlineWidth: 2.5,
    opacity: 0.6,
  },
};

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

/** Unknown levels fall back to the least alarming reading, never the most. */
export function levelStyle(level: string): LevelStyle {
  return isRiskLevel(level) ? LEVEL_STYLES[level] : LEVEL_STYLES.low;
}

// ---------------------------------------------------------------------------
// The terrain view
// ---------------------------------------------------------------------------

/**
 * What the map shows when no rain is coming.
 *
 * On a dry day every cell scores near its terrain value and the warning map
 * goes uniformly quiet. That is the correct answer to "is it dangerous now",
 * and it also discards the one thing this project knows that nobody else
 * publishes: which specific streets go under first. The terrain view puts that
 * back on screen for the days when the warning has nothing to say.
 *
 * It is deliberately a different LANGUAGE, not a different shade of the same
 * one:
 *
 *   - a purple ramp, nowhere near the blue-orange-red warning ramp, so the two
 *     cannot be confused at a glance or in a screenshot;
 *   - horizontal banding rather than diagonals, which reads as contour lines
 *     and as water finding a level;
 *   - verbs about the ground ("floods first") rather than about today
 *     ("flooding likely").
 *
 * Someone who glances at this map must not come away believing they were
 * warned about right now. That constraint drives every choice here.
 */
export type TerrainBand = "floods-first" | "floods-heavy" | "usually-dry";

/** Worst ground first, matching the risk legend's most-serious-first ordering. */
export const TERRAIN_BANDS: readonly TerrainBand[] = [
  "floods-first",
  "floods-heavy",
  "usually-dry",
];

export const TERRAIN_STYLES: Record<TerrainBand, LevelStyle> = {
  "floods-first": {
    label: "Floods first",
    meaning: "Goes under earliest when it rains hard",
    colour: "#3f007d",
    pattern: "terrain-dense",
    outlineWidth: 1.5,
    opacity: 0.4,
  },
  "floods-heavy": {
    label: "Floods in heavy rain",
    meaning: "Goes under when rain is heavy or long",
    colour: "#6a51a3",
    pattern: "terrain-medium",
    outlineWidth: 1,
    opacity: 0.3,
  },
  "usually-dry": {
    label: "Usually stays dry",
    meaning: "Drains reasonably well",
    colour: "#9e9ac8",
    pattern: "terrain-sparse",
    outlineWidth: 0.5,
    opacity: 0.18,
  },
};

export function isTerrainBand(value: unknown): value is TerrainBand {
  return typeof value === "string" && (TERRAIN_BANDS as readonly string[]).includes(value);
}

/** Unknown bands fall back to the least alarming reading, never the most. */
export function terrainStyle(band: string): LevelStyle {
  return isTerrainBand(band) ? TERRAIN_STYLES[band] : TERRAIN_STYLES["usually-dry"];
}

// ---------------------------------------------------------------------------
// Switching between them
// ---------------------------------------------------------------------------

/** Which reading the overlay is currently drawing. */
/**
 * Which question the rectangles are answering.
 *
 *   now      Is this street dangerous right now?
 *   later    Will it be, over the rest of today?
 *   terrain  Which streets go under when it rains, regardless of today?
 *
 * `later` reuses the live vocabulary rather than inventing a third one. It is
 * the same question as `now` asked about a different hour, and giving it its
 * own colours would imply a different kind of claim.
 */
export type MapView = "now" | "later" | "terrain";

/** Every style the overlay can paint, in the order the legend lists them. */
/**
 * Styles with their words resolved in the active language.
 *
 * Colour, pattern and outline are language-independent; only the label and
 * the one-line meaning change. That split is deliberate — it means a
 * translation gap can cost a word but can never cost the shape or colour
 * channel that the map's readability actually depends on.
 */
export function stylesForView(view: MapView): ReadonlyArray<[string, LevelStyle]> {
  return view === "terrain"
    ? TERRAIN_BANDS.map(
        (band) =>
          [band, localise(TERRAIN_STYLES[band], `terrain.${band}`)] as [string, LevelStyle],
      )
    : RISK_LEVELS.map(
        (level) =>
          [level, localise(LEVEL_STYLES[level], `level.${level}`)] as [string, LevelStyle],
      );
}

function localise(style: LevelStyle, key: string): LevelStyle {
  const label = t(key);
  const meaning = t(`${key}.meaning`);
  return {
    ...style,
    label: label === key ? style.label : label,
    meaning: meaning === `${key}.meaning` ? style.meaning : meaning,
  };
}

/**
 * Build a MapLibre `match` expression over whichever vocabulary is in play.
 *
 * Keeping this in one place means colour, pattern and outline weight cannot
 * drift apart from each other across layers, and that the two views cannot
 * drift apart in how they are assembled.
 */
export function matchByView<T>(
  view: MapView,
  pick: (style: LevelStyle) => T,
  fallback: T,
): unknown[] {
  const key = view === "terrain" ? "terrainBand" : view === "later" ? "levelLater" : "level";
  const expression: unknown[] = ["match", ["get", key]];
  for (const [value, style] of stylesForView(view)) {
    expression.push(value, pick(style));
  }
  expression.push(fallback);
  return expression;
}
