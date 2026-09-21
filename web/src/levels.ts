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

/**
 * Build a MapLibre `match` expression over the four levels.
 *
 * Keeping this in one place means colour, pattern and outline weight cannot
 * drift apart from each other across layers.
 */
export function matchByLevel<T>(pick: (style: LevelStyle) => T, fallback: T): unknown[] {
  const expression: unknown[] = ["match", ["get", "level"]];
  for (const level of RISK_LEVELS) {
    expression.push(level, pick(LEVEL_STYLES[level]));
  }
  expression.push(fallback);
  return expression;
}
