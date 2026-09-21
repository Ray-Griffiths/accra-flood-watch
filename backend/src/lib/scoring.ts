/**
 * The risk scoring model.
 *
 * Pure functions, no I/O, so the whole model can be tested against fixed
 * inputs including the boundary at every threshold. That matters more here
 * than anywhere else in the codebase: this is the part that decides whether a
 * street is painted as safe.
 *
 * Per section 10 of the project plan:
 *
 *   ~40%  static susceptibility   terrain, constant per cell
 *   ~40%  forecast rainfall       scaled NON-LINEARLY
 *   ~20%  live reports            severity and count, decaying with age
 *
 * There is no machine learning, deliberately. No labelled dataset of Accra
 * flooding at cell resolution exists to train or validate against, and a model
 * that cannot be validated has no business telling somebody a road is passable.
 */

import {
  CONFIRMATION_REPORT_COUNT,
  CONFIRMATION_WINDOW_MINUTES,
  CONFIRMING_DEPTHS,
  type DepthLevel,
  type RiskLevel,
} from "./risk.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export interface ScoringWeights {
  susceptibility: number;
  rainfall: number;
  reports: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  susceptibility: 0.4,
  rainfall: 0.4,
  reports: 0.2,
};

export interface ScoringThresholds {
  watch: number;
  high: number;
}

export const DEFAULT_THRESHOLDS: ScoringThresholds = { watch: 45, high: 70 };

/**
 * Rainfall totals at which the forecast component reaches its maximum.
 *
 * 60mm inside six hours is the level at which Accra's drains are overwhelmed
 * in practice; the June 2015 flood delivered several times this. These are
 * reference points for a warning scale, not predictions of depth.
 */
export const RAIN_REFERENCE_6H_MM = 60;
export const RAIN_REFERENCE_24H_MM = 120;

/**
 * Convexity of the rainfall curve.
 *
 * The plan requires non-linear scaling because "sixty millimetres in six hours
 * is far more than twice as dangerous as thirty". An exponent above 1 delivers
 * exactly that: at the reference total the curve reaches 100, and at half the
 * reference it reaches 33 rather than 50 — so doubling the rain roughly triples
 * the score. Drainage capacity is a threshold, not a slope.
 */
export const RAIN_EXPONENT = 1.6;

/** Reports older than this contribute nothing. */
export const REPORT_WINDOW_MINUTES = 360;

/** Weight halves every this many minutes. Water recedes; old news is weak. */
export const REPORT_HALF_LIFE_MINUTES = 180;

/** A report in a neighbouring cell is evidence, but weaker evidence. */
export const NEIGHBOUR_WEIGHT = 0.5;

/** How dangerous each reported depth is, on the same 0-100 scale. */
export const DEPTH_SEVERITY: Record<DepthLevel, number> = {
  ankle: 25,
  knee: 55,
  waist: 85,
  impassable: 100,
};

/** Added per corroborating report. Agreement raises confidence, not severity. */
const CORROBORATION_BONUS = 10;
const MAX_CORROBORATION = 3;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface RainfallForecast {
  /** Accumulated precipitation over the next 6 hours, in mm. */
  next6hMm: number;
  /** Accumulated precipitation over the next 24 hours, in mm. */
  next24hMm: number;
}

function convex(total: number, reference: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ratio = Math.min(1, total / reference);
  return 100 * Math.pow(ratio, RAIN_EXPONENT);
}

/**
 * The rainfall component, 0-100.
 *
 * The acute and sustained readings are combined with `max` rather than a
 * blend, because either one alone is sufficient to flood: a cloudburst
 * overwhelms the drains, and a day of steady rain saturates the ground until
 * the next shower has nowhere to go. Averaging them would let a severe six
 * hour total be diluted by a dry twenty four hour outlook.
 */
export function rainfallComponent(forecast: RainfallForecast): number {
  const acute = convex(forecast.next6hMm, RAIN_REFERENCE_6H_MM);
  const sustained = convex(forecast.next24hMm, RAIN_REFERENCE_24H_MM);
  return Math.max(acute, sustained);
}

export interface ScoringReport {
  cell: string;
  depth: DepthLevel;
  submittedAt: string;
  /** False when the report came from an adjacent cell. */
  sameCell: boolean;
}

export interface ReportsAssessment {
  score: number;
  /** Reports in THIS cell, at a confirming depth, inside the confirm window. */
  confirmingCount: number;
  /** Everything that contributed at all, for the explanation. */
  contributingCount: number;
  strongestDepth: DepthLevel | null;
}

function ageMinutes(submittedAt: string, now: Date): number {
  const then = Date.parse(submittedAt);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 60_000;
}

function decay(minutes: number): number {
  return Math.pow(0.5, minutes / REPORT_HALF_LIFE_MINUTES);
}

/**
 * The live reports component, 0-100.
 *
 * Built from the strongest single piece of evidence rather than a sum: ten
 * ankle-deep reports do not add up to impassable, and a sum would let a busy
 * street outrank a genuinely dangerous quiet one. Corroboration is then added
 * separately, because several people agreeing raises confidence in what was
 * reported without changing how deep the water is.
 */
export function reportsComponent(
  reports: readonly ScoringReport[],
  now: Date,
): ReportsAssessment {
  let strongest = 0;
  let strongestDepth: DepthLevel | null = null;
  let contributingCount = 0;
  let confirmingCount = 0;

  for (const report of reports) {
    const age = ageMinutes(report.submittedAt, now);
    if (age < 0 || age > REPORT_WINDOW_MINUTES) continue;

    const proximity = report.sameCell ? 1 : NEIGHBOUR_WEIGHT;
    const weighted = DEPTH_SEVERITY[report.depth] * decay(age) * proximity;

    contributingCount += 1;
    if (weighted > strongest) {
      strongest = weighted;
      strongestDepth = report.depth;
    }

    if (
      report.sameCell &&
      age <= CONFIRMATION_WINDOW_MINUTES &&
      (CONFIRMING_DEPTHS as readonly string[]).includes(report.depth)
    ) {
      confirmingCount += 1;
    }
  }

  const corroboration =
    Math.min(MAX_CORROBORATION, Math.max(0, contributingCount - 1)) * CORROBORATION_BONUS;

  return {
    score: contributingCount === 0 ? 0 : Math.min(100, strongest + corroboration),
    confirmingCount,
    contributingCount,
    strongestDepth,
  };
}

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------

export type ScoreBasis = "terrain-only" | "terrain-and-reports" | "terrain-and-forecast";

export interface CellScore {
  score: number;
  level: RiskLevel;
  basis: ScoreBasis;
  /** Component values kept so the explanation can name what actually drove it. */
  components: {
    susceptibility: number;
    rainfall: number | null;
    reports: number;
  };
  confirmed: boolean;
}

export interface ScoreInput {
  susceptibility: number;
  /** Null when the forecast feed failed. Never silently treated as zero rain. */
  forecast: RainfallForecast | null;
  reports: ReportsAssessment;
  thresholds?: ScoringThresholds;
  weights?: ScoringWeights;
}

export function levelFor(score: number, thresholds: ScoringThresholds): RiskLevel {
  if (score >= thresholds.high) return "high";
  if (score >= thresholds.watch) return "watch";
  return "low";
}

/**
 * Combine the components into a 0-100 score and a level.
 *
 * A component that has no data does not contribute a zero — its weight is
 * redistributed across the components that ARE available. This applies to both
 * optional inputs, for the same reason in two different disguises:
 *
 *   - A missing forecast counted as zero rain would quietly mark the whole
 *     city safe at the exact moment the feed broke.
 *   - An absence of reports counted as zero danger would hold every quiet cell
 *     20 points below what the terrain and forecast justify. Nobody reporting
 *     water is not evidence that there is no water; it is evidence that nobody
 *     with a phone has walked past yet. Penalising silence would under-warn
 *     precisely the areas with the fewest users — which is the opposite of who
 *     this is built for.
 *
 * With neither, the score is the terrain susceptibility itself, which is the
 * honest answer and matches what the read path already shows for a cell the
 * scoring job has never touched.
 */
export function scoreCell(input: ScoreInput): CellScore {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const weights = input.weights ?? DEFAULT_WEIGHTS;

  const hasForecast = input.forecast !== null;
  const hasReports = input.reports.contributingCount > 0;
  const rainfall = hasForecast ? rainfallComponent(input.forecast!) : null;

  const activeWeight =
    weights.susceptibility +
    (hasReports ? weights.reports : 0) +
    (hasForecast ? weights.rainfall : 0);

  const weighted =
    input.susceptibility * weights.susceptibility +
    (hasReports ? input.reports.score * weights.reports : 0) +
    (hasForecast ? rainfall! * weights.rainfall : 0);

  const score = activeWeight === 0 ? 0 : weighted / activeWeight;
  const rounded = Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;

  // Reality outranks the model. Two independent reports in three hours set
  // confirmed flooding whatever the computed score believes.
  const confirmed = input.reports.confirmingCount >= CONFIRMATION_REPORT_COUNT;

  const basis: ScoreBasis = hasForecast
    ? "terrain-and-forecast"
    : input.reports.contributingCount > 0
      ? "terrain-and-reports"
      : "terrain-only";

  return {
    score: rounded,
    level: confirmed ? "confirmed" : levelFor(rounded, thresholds),
    basis,
    components: {
      susceptibility: input.susceptibility,
      rainfall: rainfall === null ? null : Math.round(rainfall * 10) / 10,
      reports: input.reports.score,
    },
    confirmed,
  };
}

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

export interface ExplanationInput {
  scored: CellScore;
  hand: number;
  forecast: RainfallForecast | null;
  reports: ReportsAssessment;
  historicalFloodPoint?: string;
}

const DEPTH_WORDS: Record<DepthLevel, string> = {
  ankle: "ankle deep",
  knee: "knee deep",
  waist: "waist deep",
  impassable: "impassable",
};

/**
 * One plain sentence justifying the level, built from whatever actually drove
 * the score.
 *
 * Section 10.4 makes this a functional requirement, not a nicety: it is what
 * lets a user decide whether a warning applies to them, and what lets the
 * builder find a wrong answer. No jargon, no millimetre-of-rain figures
 * without a consequence attached.
 */
export function explain(input: ExplanationInput): string {
  const { scored, reports, forecast, hand } = input;

  // Confirmed flooding speaks first and on its own. Anything the terrain or
  // the forecast believes is now beside the point.
  if (scored.confirmed) {
    const depth = reports.strongestDepth ? DEPTH_WORDS[reports.strongestDepth] : "flooded";
    return (
      `People here are reporting water ${depth} right now. ` +
      `${reports.confirmingCount} independent reports in the last three hours. ` +
      `Avoid this area.`
    );
  }

  const parts: string[] = [];

  if (hand <= 1) {
    parts.push("ground here is barely above the nearest drain");
  } else if (hand <= 4) {
    parts.push(`ground here is about ${hand.toFixed(1)}m above the nearest drain`);
  } else {
    parts.push(`ground here sits ${hand.toFixed(0)}m above the nearest drain`);
  }

  if (input.historicalFloodPoint) {
    parts.push(`flooding has been recorded at ${input.historicalFloodPoint}`);
  }

  let sentence = `${capitalise(parts.join(", "))}.`;

  if (forecast) {
    sentence += ` ${rainSentence(forecast, scored.level)}`;
  } else {
    sentence += " No rainfall forecast available, so this is terrain only.";
  }

  if (reports.contributingCount > 0 && reports.strongestDepth) {
    sentence +=
      reports.contributingCount === 1
        ? ` One person has reported water ${DEPTH_WORDS[reports.strongestDepth]} nearby.`
        : ` ${reports.contributingCount} people have reported water nearby, the worst ${DEPTH_WORDS[reports.strongestDepth]}.`;
  }

  return sentence;
}

function rainSentence(forecast: RainfallForecast, level: RiskLevel): string {
  const six = Math.round(forecast.next6hMm);
  const day = Math.round(forecast.next24hMm);

  if (six < 1 && day < 2) {
    return "Little or no rain is forecast, so flooding is unlikely today.";
  }

  const consequence =
    level === "high"
      ? "enough to flood this spot"
      : level === "watch"
        ? "enough to be worth watching here"
        : "not usually enough to flood this spot";

  if (six >= 1) {
    return `About ${six}mm of rain is forecast in the next six hours — ${consequence}.`;
  }
  return `About ${day}mm of rain is forecast over the next day — ${consequence}.`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
