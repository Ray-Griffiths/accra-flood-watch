/**
 * Sending the alerts.
 *
 * Separated from `notify.ts` so the message wording stays pure and testable
 * and only the I/O lives here. Every rule in this file exists because the
 * alternative failure was worse than not sending:
 *
 *   - Nothing throws out of `dispatchAlerts`. The scoring run that produced
 *     these alerts must finish and write its numbers whatever the push
 *     services do.
 *   - A subscription the push service has retired is deleted, not retried
 *     forever. 404 and 410 are the documented way it tells us.
 *   - There is a ceiling on how many go out in one run, so a badly tuned
 *     threshold that reddens the whole grid cannot turn into thousands of
 *     requests and a Lambda timeout.
 */

import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import webpush from "web-push";

import { documents, queryAll } from "./dynamo.ts";
import { neighbours } from "./geohash.ts";
import { alertFor, type RaisedCell } from "./notify.ts";

/**
 * Upper bound on notifications per run.
 *
 * At one alert per raised cell per watcher, a mis-tuned threshold could redden
 * all 1,140 cells at once. This is the circuit breaker: it is far above any
 * plausible real storm in a pilot area and far below anything that would time
 * the function out.
 */
export const MAX_ALERTS_PER_RUN = 500;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** Contact address the push service can use. A mailto: or https: URL. */
  subject: string;
}

export interface DispatchResult {
  sent: number;
  /** Subscriptions the push service has retired, now deleted. */
  pruned: number;
  failed: number;
  /** True when the run hit MAX_ALERTS_PER_RUN and stopped early. */
  capped: boolean;
}

interface WatcherItem {
  cell: string;
  subscriptionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function watchersOf(table: string, cell: string): Promise<WatcherItem[]> {
  return queryAll<WatcherItem>(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "cell = :cell",
      ExpressionAttributeValues: { ":cell": cell },
    }),
  );
}

/**
 * Every cell whose watchers need telling when `cell` floods: the cell itself
 * and its eight neighbours.
 *
 * A watch is registered against one 152m cell — the one the user tapped. Water
 * does not respect that boundary. Somebody who saved their home and then
 * watched the next cell along go under, with no alert, has been failed by the
 * feature in a way they can only interpret as it not working.
 *
 * `neighbours` is symmetric, so querying the raised cell's own neighbourhood
 * finds exactly the watchers within one cell of it.
 */
function neighbourhoodOf(cell: string): string[] {
  return [cell, ...neighbours(cell)];
}

/**
 * Watchers for every cell in one pass, deduplicated.
 *
 * Built as a single map before dispatch rather than queried per raised cell.
 * Raised cells in a storm are contiguous, so their neighbourhoods overlap
 * almost completely — without this, expanding to neighbours would multiply the
 * read count by nine at exactly the moment the table is busiest.
 */
async function loadWatchers(
  table: string,
  cells: readonly string[],
): Promise<Map<string, WatcherItem[]>> {
  const wanted = new Set<string>();
  for (const cell of cells) {
    for (const near of neighbourhoodOf(cell)) wanted.add(near);
  }

  const byCell = new Map<string, WatcherItem[]>();
  const distinct = [...wanted];

  const results = await Promise.all(
    distinct.map(async (cell) => {
      try {
        return await watchersOf(table, cell);
      } catch (error) {
        console.error(`Could not read watchers for ${cell}`, error);
        return [];
      }
    }),
  );

  for (const [index, watchers] of results.entries()) {
    byCell.set(distinct[index]!, watchers);
  }

  return byCell;
}

/**
 * Notify everyone watching a cell that has just become dangerous.
 *
 * Returns counts rather than throwing. The caller emits them as metrics, which
 * is the only way a silent failure of the push path becomes visible: nobody
 * complains about an alert they never knew was coming.
 */
export async function dispatchAlerts(
  raised: readonly RaisedCell[],
  table: string,
  vapid: VapidKeys | null,
): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, pruned: 0, failed: 0, capped: false };
  if (raised.length === 0) return result;

  if (!vapid) {
    console.warn(`No VAPID keys configured; ${raised.length} alerts not sent.`);
    return result;
  }

  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  const byCell = await loadWatchers(
    table,
    raised.map((cell) => cell.cell),
  );

  // One alert per subscription per run. A storm raises a block of adjacent
  // cells at once, and without this a watcher standing in the middle of it
  // would get an alert for every cell around them — which is not nine times
  // the information, it is how somebody turns notifications off.
  const alerted = new Set<string>();

  for (const cell of raised) {
    if (result.sent + result.failed >= MAX_ALERTS_PER_RUN) {
      result.capped = true;
      console.warn(`Alert cap of ${MAX_ALERTS_PER_RUN} reached; stopping dispatch.`);
      break;
    }

    const watchers: WatcherItem[] = [];
    for (const near of neighbourhoodOf(cell.cell)) {
      for (const watcher of byCell.get(near) ?? []) {
        if (alerted.has(watcher.subscriptionId)) continue;
        alerted.add(watcher.subscriptionId);
        watchers.push(watcher);
      }
    }
    if (watchers.length === 0) continue;

    const payload = JSON.stringify(alertFor(cell));

    // Per cell rather than across the whole run, so one slow push service
    // cannot hold up every other cell's alerts behind it.
    const outcomes = await Promise.allSettled(
      watchers.map((watcher) =>
        webpush.sendNotification(
          {
            endpoint: watcher.endpoint,
            keys: { p256dh: watcher.p256dh, auth: watcher.auth },
          },
          payload,
          { TTL: 3600, urgency: "high" },
        ),
      ),
    );

    for (const [index, outcome] of outcomes.entries()) {
      const watcher = watchers[index]!;
      if (outcome.status === "fulfilled") {
        result.sent += 1;
        continue;
      }

      // web-push rejects two different ways, and they need different
      // responses. A WebPushError carries the push service's status code. A
      // plain Error means the failure happened locally -- a malformed key
      // fails during payload encryption, before any request is made -- and
      // reporting that as "status undefined" tells an operator nothing about
      // which of the two happened.
      const reason = outcome.reason as { statusCode?: number; message?: string };
      const status = reason.statusCode;
      if (status === 404 || status === 410) {
        // The push service is telling us this subscription is gone. Deleting
        // it is the documented response; retrying it every hour is not.
        result.pruned += 1;
        try {
          await documents.send(
            new DeleteCommand({
              TableName: table,
              Key: { cell: watcher.cell, subscriptionId: watcher.subscriptionId },
            }),
          );
        } catch (error) {
          console.error(`Could not prune subscription in ${watcher.cell}`, error);
        }
      } else {
        result.failed += 1;
        console.error(
          status === undefined
            ? `Push to ${watcher.cell} failed before it was sent: ${reason.message ?? "unknown"}`
            : `Push to ${watcher.cell} rejected by the push service with ${status}`,
        );
      }
    }
  }

  return result;
}
