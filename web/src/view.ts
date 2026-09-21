/**
 * Which reading the map shows, and why.
 *
 * The map answers two different questions with the same rectangles:
 *
 *   "now"      Is this street dangerous right now? Terrain, plus the rainfall
 *              forecast, plus what people are reporting.
 *   "terrain"  Which streets go under when it rains? The ground alone, with no
 *              reference to today.
 *
 * On a dry day — most days — the first question has the same quiet answer
 * everywhere, and a map that says "low" across the whole city every day is a
 * map people stop opening. The second question always has something to say,
 * and what it says is the thing this project knows that nobody else publishes.
 *
 * So the view follows the weather by default. The rules below are ordered, and
 * the first two are safety rules that a user's manual choice cannot override:
 * whatever somebody selected an hour ago, they must not be looking at a map of
 * dry-weather ground while water is rising.
 */

import type { RainOutlook, RiskCell } from "./api.ts";
import type { MapView } from "./levels.ts";

export interface ViewInputs {
  /** Null when the forecast feed was down. Not the same as "no rain". */
  outlook: RainOutlook | null | undefined;
  /** Somebody is reporting water in the current viewport. */
  anyConfirmed: boolean;
  /** What the user last chose, if anything. Null means "follow the weather". */
  manual: MapView | null;
}

export interface ViewDecision {
  view: MapView;
  /**
   * True when the rules overrode a manual choice. The interface has to say so
   * — a toggle that silently moves is a toggle the user stops trusting.
   */
  overrodeChoice: boolean;
  /** One sentence for the banner, explaining what is on screen and why. */
  reason: string;
}

export function decideView(inputs: ViewInputs): ViewDecision {
  const { outlook, anyConfirmed, manual } = inputs;

  // 1. Somebody is standing in water. Nothing outranks that, including a
  //    preference expressed before it started.
  if (anyConfirmed) {
    return {
      view: "now",
      overrodeChoice: manual === "terrain",
      reason: "People are reporting water in this area right now.",
    };
  }

  // 2. Rain that can actually flood is coming. The live warning is the only
  //    thing worth the screen.
  if (outlook === "significant") {
    return {
      view: "now",
      overrodeChoice: manual === "terrain",
      reason: "Rain heavy enough to flood is forecast. Showing risk right now.",
    };
  }

  // 3. Below that threshold the user's choice stands.
  if (manual) {
    return {
      view: manual,
      overrodeChoice: false,
      reason:
        manual === "terrain"
          ? "Showing which streets flood when it rains, not today's risk."
          : "Showing flood risk right now.",
    };
  }

  // 4. No rain coming: the warning has nothing to say, so show the ground.
  if (outlook === "none") {
    return {
      view: "terrain",
      overrodeChoice: false,
      reason: "No rain forecast. Showing which streets flood when it rains.",
    };
  }

  // 5. Light rain, or no forecast at all. Both keep the live view: a feed that
  //    failed is not evidence of a dry day, and switching to terrain on the
  //    strength of a missing number would be inventing good news.
  return {
    view: "now",
    overrodeChoice: false,
    reason:
      outlook === "light"
        ? "Some rain forecast. Showing flood risk right now."
        : "Showing flood risk right now.",
  };
}

/** Whether anything in view is being reported as flooded at this moment. */
export function hasConfirmedCell(cells: readonly RiskCell[]): boolean {
  return cells.some((cell) => cell.level === "confirmed");
}
