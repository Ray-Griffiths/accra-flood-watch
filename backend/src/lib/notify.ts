/**
 * Web push alerts for watched places.
 *
 * A saved location is not a person. It is a cell on a grid and an opaque push
 * endpoint the browser handed out, stored together so that when the cell turns
 * red the scoring job can find everyone who needs telling in one query. There
 * is no account, no name, no device identifier, and nothing that links two
 * watched places to the same browser beyond the endpoint the push service
 * already knows about.
 *
 * SMS was rejected in the plan on cost: at roughly $0.03-0.09 per message to a
 * Ghanaian number, one storm's alerts would cost more than everything else in
 * this system put together. Web push is free and arrives on the same phone.
 *
 * Dispatch is deliberately best-effort and never allowed to fail the scoring
 * run. A run that throws leaves the previous hour's numbers on the map
 * presented as current, which is a worse outcome than an alert that did not
 * arrive.
 */

import type { RiskLevel } from "./risk.ts";

/** Longest body a push notification shows before the phone truncates it. */
export const MAX_BODY_CHARS = 160;

export interface RaisedCell {
  cell: string;
  level: RiskLevel;
  /** The server-authored sentence that justifies the level. */
  explanation: string;
}

export interface AlertMessage {
  title: string;
  body: string;
  cell: string;
  level: RiskLevel;
}

/**
 * Compose the alert for a cell that has just become dangerous.
 *
 * The title separates observation from prediction, because they are different
 * claims and a person deciding whether to leave the house deserves to know
 * which one they are being handed. The body is the same sentence the map
 * shows, so tapping through to it does not present a second, differently
 * worded story.
 */
export function alertFor(raised: RaisedCell): AlertMessage {
  const title =
    raised.level === "confirmed"
      ? "Flooding reported at a place you watch"
      : "Flooding likely at a place you watch";

  return {
    title,
    body: truncate(raised.explanation, MAX_BODY_CHARS),
    cell: raised.cell,
    level: raised.level,
  };
}

/** Cut at a word boundary so the last word is not left as a fragment. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const clipped = text.slice(0, limit - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.replace(/[.,;:\s]+$/, "")}…`;
}

/**
 * Is this the transition worth interrupting somebody for?
 *
 * Only the crossing into danger. Re-alerting every hour while a cell stays
 * `high` is how a person turns notifications off, and they turn them off
 * before the hour that mattered. Cells falling back to safe are not announced
 * either: nobody needs to be woken to be told nothing is wrong.
 */
export function isNewlyDangerous(previous: string | undefined, next: RiskLevel): boolean {
  const wasDangerous = previous === "high" || previous === "confirmed";
  const isDangerous = next === "high" || next === "confirmed";
  if (!isDangerous) return false;
  if (!wasDangerous) return true;

  // An escalation from "likely" to "people are standing in it" is new
  // information, and is the one repeat worth sending.
  return previous === "high" && next === "confirmed";
}
