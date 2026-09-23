/**
 * Reports held on the device until there is a connection to send them on.
 *
 * This is the one write path in the application, and it is used in the exact
 * conditions that break mobile data: heavy rain, a crowd on the same mast, a
 * dead spot under a bridge. Before this, a report submitted with no signal was
 * simply lost — the user got "try again" and, standing in water, did not.
 *
 * Two properties make the queue safe rather than merely convenient:
 *
 *   - **Every entry carries when the water was SEEN.** The server writes that
 *     as the report's timestamp instead of the arrival time, so a report held
 *     for ten minutes does not describe itself as current. Without it, a queue
 *     would quietly turn stale observations into fresh ones, which is the
 *     opposite of what this application is for.
 *   - **Entries expire.** Past the window the server will accept, an entry is
 *     dropped rather than sent and refused. Half an hour is enough to cover
 *     walking out of a dead spot and far short of the water having changed.
 *
 * Storage is localStorage rather than IndexedDB: the payload is a handful of
 * small objects, and every failure path here has to be survivable, which a
 * synchronous API with a try/catch around it is.
 */

import { ApiError, submitReport, type Depth } from "./api.ts";

const KEY = "afw:pending-reports";

/**
 * Must stay at or below the server's own limit on how old an observation may
 * be. Sending past it earns a 422 and loses the report either way, so the
 * client drops it first and says so.
 */
export const MAX_QUEUE_AGE_MINUTES = 30;

/**
 * A cap, not a capacity target. Somebody walking a flooded street might file
 * several reports; nobody files twenty. The bound exists so a bug or a jammed
 * connection cannot grow localStorage without limit.
 */
const MAX_ENTRIES = 20;

export interface PendingReport {
  latitude: number;
  longitude: number;
  /** Null for "the water has gone", which has no depth to report. */
  depth: Depth | null;
  /** ISO 8601. When the water was seen, not when this was last sent. */
  observedAt: string;
}

function read(): PendingReport[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PendingReport[]) : [];
  } catch {
    // Private browsing, a full quota, or something else wrote over the key.
    // An unreadable queue is an empty queue; it must never break reporting.
    return [];
  }
}

function write(entries: readonly PendingReport[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* Nothing useful to do. The live path does not depend on this. */
  }
}

function ageMinutes(entry: PendingReport, now: number): number {
  const at = Date.parse(entry.observedAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : (now - at) / 60_000;
}

/** Entries still recent enough to be worth sending. */
function fresh(entries: readonly PendingReport[], now: number): PendingReport[] {
  return entries.filter((entry) => ageMinutes(entry, now) <= MAX_QUEUE_AGE_MINUTES);
}

export function pendingCount(now = Date.now()): number {
  return fresh(read(), now).length;
}

/**
 * Hold a report that could not be sent.
 *
 * Returns false when the queue is full, so the caller can tell the user their
 * report was not kept rather than implying it was.
 */
export function enqueue(report: PendingReport): boolean {
  const entries = fresh(read(), Date.now());
  if (entries.length >= MAX_ENTRIES) return false;

  entries.push(report);
  write(entries);
  return true;
}

export interface FlushResult {
  sent: number;
  /** Too old to be a useful description of the water; dropped unsent. */
  expired: number;
  /** Still queued: the connection is still down. */
  remaining: number;
}

/**
 * Try to send everything held, oldest first.
 *
 * A network failure stops the run and leaves the rest queued — if one request
 * could not reach the service, the next will not either, and hammering a dead
 * connection drains the battery of somebody who may need it.
 *
 * A refusal from the server (any answered status) DISCARDS the entry. The
 * service has seen it and said no; keeping it would mean retrying a rejection
 * forever.
 */
export async function flush(): Promise<FlushResult> {
  const now = Date.now();
  const all = read();
  if (all.length === 0) return { sent: 0, expired: 0, remaining: 0 };

  const sendable = fresh(all, now);
  const expired = all.length - sendable.length;

  // Oldest first, so that if the connection dies again the reports most at
  // risk of expiring are the ones that already went.
  sendable.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

  let sent = 0;
  let index = 0;

  for (; index < sendable.length; index += 1) {
    const entry = sendable[index]!;
    try {
      await submitReport(entry.latitude, entry.longitude, entry.depth, entry.observedAt);
      sent += 1;
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) break;
      // Answered and refused. Drop it and carry on with the rest.
    }
  }

  // Everything before `index` was either accepted or refused outright; both
  // are finished with. Everything from `index` on is what the loop stopped
  // before, so it stays queued.
  const stillQueued = sendable.slice(index);
  write(stillQueued);

  return { sent, expired, remaining: stillQueued.length };
}

/** Discard everything held. Used when the user is told the reports were lost. */
export function clear(): void {
  write([]);
}
