/**
 * When the water was seen.
 *
 * Its own module so the handler and its tests share one implementation. A test
 * that restates the rule is a test of itself: the window below is a safety
 * boundary, and the only useful assertion about it is one made against the
 * code that actually runs.
 */

/**
 * When the water was seen, as a Date, or a sentence explaining the refusal.
 *
 * Absent means "now" -- the ordinary online submission, where arrival and
 * observation are the same moment.
 *
 * The window is deliberately narrow. It exists to cover a walk out of a dead
 * spot, not to accept a backlog: beyond half an hour the observation is no
 * longer a useful statement about a street, and accepting it would let stale
 * water confirm a cell. A clock running fast is refused for the same reason a
 * future-dated report would be nonsense.
 */
export const MAX_OBSERVATION_AGE_MINUTES = 30;
/** Tolerance for an unsynchronised phone clock. */
export const CLOCK_SKEW_MINUTES = 2;

export function resolveObservedAt(raw: unknown, now: Date): Date | string {
  if (raw === undefined || raw === null) return now;
  if (typeof raw !== "string") return "observedAt must be an ISO 8601 timestamp.";

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return "observedAt must be an ISO 8601 timestamp.";

  const ageMinutes = (now.getTime() - parsed) / 60_000;

  if (ageMinutes < -CLOCK_SKEW_MINUTES) {
    return "That report is dated in the future. Check your device clock.";
  }
  if (ageMinutes > MAX_OBSERVATION_AGE_MINUTES) {
    return (
      "That report is more than half an hour old, so it is no longer a " +
      "reliable description of the water. Please report again if it is still there."
    );
  }

  // Inside the skew allowance but still ahead of us: treat as now rather than
  // writing a timestamp the rest of the system would read as the future.
  return ageMinutes < 0 ? now : new Date(parsed);
}
