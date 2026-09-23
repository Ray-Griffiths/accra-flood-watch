/**
 * How often the city gets rescored.
 *
 * Hourly was the right answer for a dry Tuesday and the wrong one for the
 * storm this application exists for. A cell can go from `watch` to people
 * standing in water inside fifteen minutes, and on an hourly schedule the
 * alert that mattered would sit behind the clock for up to an hour.
 *
 * Rescoring every fifteen minutes regardless would be the obvious fix and the
 * wrong one: it quadruples the write volume and the forecast fetches on the
 * ~340 days a year when nothing is happening, against a pilot budget of
 * $10-20 a month.
 *
 * So the schedule ticks every fifteen minutes and this decides. The rule is
 * deliberately biased towards running: the cost of a needless rescore is
 * fractions of a cent, and the cost of a missed one is somebody not being
 * told about water.
 */

import { RAIN_SIGNIFICANT_6H_MM, type RainOutlook } from "./scoring.ts";

/**
 * Longest gap tolerated between full runs.
 *
 * Just under an hour, so the hourly floor still lands on the next tick after
 * an hour has passed rather than skipping to the one after. Expressed as
 * elapsed time rather than "is it the top of the hour" so a missed tick
 * self-heals instead of waiting for the clock to come round again.
 */
export const MAX_INTERVAL_MINUTES = 55;

/** Wet weather: rescore on every tick. */
export const RAIN_INTERVAL_MINUTES = 14;

export interface CadenceInput {
  now: Date;
  /** When the last full rescore completed. Null if it never has. */
  lastRanAt: string | null;
  /** What the last run saw coming. Null when the forecast feed was down. */
  lastOutlook: RainOutlook | null;
}

export interface CadenceDecision {
  rescore: boolean;
  /** Why, for the log. An operator reading a quiet log needs to know it is quiet on purpose. */
  reason: string;
  minutesSinceLast: number | null;
}

export function decideCadence(input: CadenceInput): CadenceDecision {
  const { now, lastRanAt, lastOutlook } = input;

  if (!lastRanAt) {
    return { rescore: true, reason: "no previous run recorded", minutesSinceLast: null };
  }

  const then = Date.parse(lastRanAt);
  if (Number.isNaN(then)) {
    // An unreadable timestamp is not a reason to stop scoring the city.
    return { rescore: true, reason: "previous run timestamp unreadable", minutesSinceLast: null };
  }

  const minutesSinceLast = (now.getTime() - then) / 60_000;

  // A clock that has gone backwards, or a meta row written by a future
  // deployment. Rescore rather than sulk.
  if (minutesSinceLast < 0) {
    return { rescore: true, reason: "previous run is in the future", minutesSinceLast };
  }

  if (minutesSinceLast >= MAX_INTERVAL_MINUTES) {
    return {
      rescore: true,
      reason: `${Math.round(minutesSinceLast)} minutes since the last run`,
      minutesSinceLast,
    };
  }

  // Rain coming, or already here. `null` counts as rain: a forecast feed that
  // failed is not evidence of a dry afternoon, and slowing the cadence on a
  // missing number would be the same mistake as painting the map green on one.
  const wet = lastOutlook === null || lastOutlook === "significant";
  if (wet && minutesSinceLast >= RAIN_INTERVAL_MINUTES) {
    return {
      rescore: true,
      reason:
        lastOutlook === null
          ? "no forecast on the last run, so treating it as wet"
          : `rain at or above ${RAIN_SIGNIFICANT_6H_MM}mm/6h is forecast`,
      minutesSinceLast,
    };
  }

  return {
    rescore: false,
    reason: wet
      ? "rescored within the last quarter hour"
      : `dry: ${Math.round(minutesSinceLast)} of ${MAX_INTERVAL_MINUTES} minutes elapsed`,
    minutesSinceLast,
  };
}
