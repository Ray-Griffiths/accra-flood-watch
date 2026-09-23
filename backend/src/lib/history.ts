/**
 * How often a place floods, recorded as weakly as it can usefully be.
 *
 * This is the one thing the project knows that nobody else publishes: not
 * that Accra floods, which everybody knows, but that *this* junction goes
 * under and that one does not. Reports are deleted at 24 hours and that
 * promise is kept — what survives here is a tally that could have been
 * produced by counting rainfall.
 *
 * A row is **a cell and a date**. Deliberately absent:
 *
 *   - coordinates, so a row cannot be traced to a doorway;
 *   - a time of day, so it cannot be matched against anybody's movements;
 *   - a depth or a count, so a street with one loud reporter looks exactly
 *     like a street with twenty quiet ones;
 *   - any identifier at all, so two rows cannot be tied to one device.
 *
 * The strongest statement a row supports is "somebody reported flooding in
 * this 152m square on this date", which is the statement the feature needs
 * and nothing more. Writing the same cell and date twice is idempotent: the
 * second write replaces the first rather than incrementing anything, which is
 * what keeps it a record of DAYS rather than a popularity contest.
 */

/**
 * How long a day marker survives.
 *
 * Long enough to describe a rainy season, short enough that the record stays
 * about current behaviour rather than becoming a permanent archive of a
 * neighbourhood. A cell that stopped flooding after a drain was cleared
 * should stop saying it floods.
 */
export const HISTORY_RETENTION_DAYS = 180;

/** The UTC date a moment falls on, as `YYYY-MM-DD`. */
export function dayKey(when: Date): string {
  return when.toISOString().slice(0, 10);
}

export interface HistoryMarker {
  cell: string;
  day: string;
  expiresAt: number;
}

export function markerFor(cell: string, when: Date): HistoryMarker {
  return {
    cell,
    day: dayKey(when),
    expiresAt:
      Math.floor(when.getTime() / 1000) + HISTORY_RETENTION_DAYS * 24 * 60 * 60,
  };
}

export interface HistorySummary {
  /** Distinct days with at least one flooding report, inside the window. */
  days: number;
  /** How far back the tally looks. */
  windowDays: number;
  /** A sentence, or null when there is nothing worth saying. */
  sentence: string | null;
}

/**
 * Turn a set of day markers into something a person can read.
 *
 * Returns `null` rather than "0 days" for a cell with no history: an absence
 * of reports is not evidence a place does not flood, it is evidence nobody
 * with a phone has walked past. Printing a confident zero would invert that.
 *
 * One day is also not a pattern, so it is reported as the single observation
 * it is rather than dressed up as a frequency.
 */
export function summarise(
  days: readonly string[],
  windowDays = HISTORY_RETENTION_DAYS,
): HistorySummary {
  const count = new Set(days).size;

  if (count === 0) {
    return { days: 0, windowDays, sentence: null };
  }

  const months = Math.round(windowDays / 30);
  const period = months >= 12 ? "year" : `${months} months`;

  const sentence =
    count === 1
      ? `Flooding has been reported here on one day in the last ${period}.`
      : `Flooding has been reported here on ${count} separate days in the last ${period}.`;

  return { days: count, windowDays, sentence };
}
