/**
 * Last-known risk data, held so the map still says something useful when the
 * network does not.
 *
 * The project rule is that degrading must stay readable: never show nothing,
 * and never show old data without saying how old it is. So everything stored
 * here comes back out with a timestamp attached, and the caller is expected to
 * label it. A cached flood warning presented as current would be worse than an
 * empty map.
 */

import type { RiskResponse } from "./api.ts";

const KEY = "afw:last-risk";

/** Beyond this, terrain is still true but the reading is not worth showing. */
const MAX_AGE_HOURS = 72;

interface Snapshot {
  storedAt: string;
  bbox: [number, number, number, number];
  risk: RiskResponse;
}

export interface CachedRisk {
  risk: RiskResponse;
  storedAt: Date;
  /** "8 minutes ago", "yesterday" -- ready to print next to the data. */
  ageLabel: string;
}

export function storeRisk(bbox: [number, number, number, number], risk: RiskResponse): void {
  if (risk.cells.length === 0) return;

  const snapshot: Snapshot = { storedAt: new Date().toISOString(), bbox, risk };
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // Private browsing, or the quota is full. Caching is a nicety; losing it
    // must never break the live path.
  }
}

export function loadRisk(): CachedRisk | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(raw) as Snapshot;
  } catch {
    return null;
  }

  const storedAt = new Date(snapshot.storedAt);
  if (Number.isNaN(storedAt.getTime())) return null;

  const ageHours = (Date.now() - storedAt.getTime()) / 3_600_000;
  if (ageHours > MAX_AGE_HOURS) return null;

  if (!snapshot.risk || !Array.isArray(snapshot.risk.cells)) return null;

  return { risk: snapshot.risk, storedAt, ageLabel: describeAge(storedAt) };
}

export function describeAge(when: Date): string {
  const minutes = Math.round((Date.now() - when.getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
