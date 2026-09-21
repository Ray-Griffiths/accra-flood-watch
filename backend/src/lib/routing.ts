/**
 * The safe-routing model: what counts as impassable, and how to say so.
 *
 * Pure functions, no I/O, because the rules encoded here are the ones the
 * project promises in section 11 of the plan and in CLAUDE.md:
 *
 *   - never return a route through a confirmed cell, even if it is faster;
 *   - when avoidance lengthens a route, say so explicitly;
 *   - if no safe route exists, say that plainly and advise not travelling,
 *     never silently falling back to a route through water.
 *
 * Each of those is a sentence a person reads while deciding whether to walk
 * down a street, so each of them is tested against fixed inputs.
 */

import type { Bounds } from "./geohash.ts";
import { CONFIRMING_DEPTHS, type DepthLevel } from "./risk.ts";

export type TravelMode = "walking" | "driving";

export function isTravelMode(value: unknown): value is TravelMode {
  return value === "walking" || value === "driving";
}

/**
 * Why a cell is being routed around.
 *
 *   reported   Somebody is standing in water here, or was within the last few
 *              hours. Observation, not inference.
 *   confirmed  Two independent reports agree. The model's own override.
 *   likely     The score says high. Inference, and treated as softer, because
 *              routing somebody a kilometre out of their way on the strength
 *              of a forecast is its own kind of harm.
 */
export type HazardReason = "confirmed" | "reported" | "likely";

export interface Hazard {
  cell: string;
  bounds: Bounds;
  reason: HazardReason;
}

/**
 * Hard blocks are never traded away for a shorter route. Soft avoidance is
 * passed to the router as a preference and accepted if it cannot be honoured.
 *
 * The split is the difference between evidence and inference. A `confirmed`
 * cell has two people saying there is water in it; a `high` cell has a model
 * saying there might be. Refusing to travel on the first is protective;
 * refusing on the second, every time it rains, is how a tool gets uninstalled.
 */
export function isHardBlock(reason: HazardReason): boolean {
  return reason === "confirmed" || reason === "reported";
}

export interface HazardInputs {
  /** Cells in the corridor, as scored by the hourly job. */
  cells: ReadonlyArray<{ cell: string; bounds: Bounds; level?: string }>;
  /** Active reports, already filtered to unexpired. */
  reports: ReadonlyArray<{ cell: string; depth: DepthLevel }>;
}

/**
 * Turn scored cells and standing reports into the areas a route must avoid.
 *
 * A cell is hard-blocked when the scoring job called it `confirmed`, or when
 * somebody has reported water knee deep or worse in it. The second clause is
 * not redundant: confirmation needs two independent reports within three
 * hours, and one person reporting waist-deep water is already reason enough
 * not to send somebody else down that street.
 */
export function classifyHazards(input: HazardInputs): Hazard[] {
  const confirming = new Set<string>();
  for (const report of input.reports) {
    if ((CONFIRMING_DEPTHS as readonly string[]).includes(report.depth)) {
      confirming.add(report.cell);
    }
  }

  const hazards: Hazard[] = [];
  for (const cell of input.cells) {
    if (cell.level === "confirmed") {
      hazards.push({ cell: cell.cell, bounds: cell.bounds, reason: "confirmed" });
    } else if (confirming.has(cell.cell)) {
      hazards.push({ cell: cell.cell, bounds: cell.bounds, reason: "reported" });
    } else if (cell.level === "high") {
      hazards.push({ cell: cell.cell, bounds: cell.bounds, reason: "likely" });
    }
  }

  return hazards;
}

// ---------------------------------------------------------------------------
// Saying it in words
// ---------------------------------------------------------------------------

/**
 * A detour below these is not worth mentioning.
 *
 * Reporting "this adds 12 seconds" trains people to skip the sentence, and
 * the sentence is the one that has to survive for the day it says nine
 * minutes. Route durations are estimates either way.
 */
export const DETOUR_NOTICE_SECONDS = 60;
export const DETOUR_NOTICE_METRES = 100;

export interface RouteExplanationInput {
  mode: TravelMode;
  /** Cells routed around that were hard blocks. */
  blocked: number;
  /** Cells routed around that were only `high`. */
  likely: number;
  /** Seconds this route takes beyond the direct one. Null when not compared. */
  extraSeconds: number | null;
  extraMetres: number | null;
}

/**
 * One or two plain sentences saying what this route did and what it cost.
 *
 * The cost is stated whenever it is material. A route that quietly takes
 * somebody nine minutes out of their way, with no explanation, is a route they
 * will abandon halfway and finish through the water.
 */
export function explainRoute(input: RouteExplanationInput): string {
  const total = input.blocked + input.likely;

  if (total === 0) {
    return "No flooding is being reported along this route right now.";
  }

  const first = `This route goes around ${describeHazards(input.blocked, input.likely)}.`;
  const cost = describeDetour(input.extraSeconds, input.extraMetres, input.mode);
  return cost ? `${first} ${cost}` : first;
}

function describeHazards(blocked: number, likely: number): string {
  const blockedPhrase = `${blocked} ${plural(blocked, "place")} where people are reporting water`;
  const likelyPhrase = `${likely} where flooding is likely`;

  if (blocked > 0 && likely > 0) return `${blockedPhrase}, and ${likelyPhrase}`;
  if (blocked > 0) return blockedPhrase;
  return `${likely} ${plural(likely, "place")} where flooding is likely`;
}

/**
 * The extra time, in the terms the traveller is actually thinking in.
 *
 * Returns null when there is nothing worth saying, so the caller can leave the
 * sentence out rather than print "this adds about 0 minutes".
 */
export function describeDetour(
  extraSeconds: number | null,
  extraMetres: number | null,
  mode: TravelMode,
): string | null {
  if (extraSeconds === null && extraMetres === null) return null;

  const seconds = extraSeconds ?? 0;
  const metres = extraMetres ?? 0;

  if (seconds < DETOUR_NOTICE_SECONDS && metres < DETOUR_NOTICE_METRES) {
    return "It is no longer than the direct way.";
  }

  const verb = mode === "walking" ? "walking" : "driving";
  if (seconds >= DETOUR_NOTICE_SECONDS) {
    return `That is about ${describeMinutes(seconds)} more ${verb}.`;
  }
  return `That is about ${describeDistance(metres)} further.`;
}

function describeMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${plural(minutes, "minute")}`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = `${hours} ${plural(hours, "hour")}`;
  return rest === 0 ? hourPart : `${hourPart} ${rest} ${plural(rest, "minute")}`;
}

function describeDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 10) * 10}m`;
  return `${(metres / 1000).toFixed(1)}km`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/**
 * What to say when every way through is flooded.
 *
 * This is the message the safety rule exists for. It does not hedge, it does
 * not offer the route anyway "with caution", and it gives the person
 * somewhere to go next — waiting is an action, and naming it is what makes
 * "do not travel" something other than a dead end.
 */
export function explainNoSafeRoute(mode: TravelMode): string {
  const verb = mode === "walking" ? "walk" : "drive";
  return (
    `Every way through goes past water that people are reporting right now. ` +
    `Do not ${verb} this route. Wait for the water to drop, or find somewhere ` +
    `to shelter — flood water in Accra moves faster and runs deeper than it looks.`
  );
}
