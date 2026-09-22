import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { dispatchAlerts } from "../lib/dispatch.ts";
import { documents, requireTable } from "../lib/dynamo.ts";
import { emitMetrics } from "../lib/metrics.ts";
import type { RaisedCell } from "../lib/notify.ts";
import { isDepthLevel, type DepthLevel } from "../lib/risk.ts";
import { explainConfirmed } from "../lib/scoring.ts";
import { loadVapidKeys } from "../lib/vapid.ts";

/**
 * Alert the watchers of a cell that residents have just confirmed flooding in.
 *
 * WHY THIS EXISTS AS A SEPARATE FUNCTION
 *
 * Confirmed flooding is the strongest signal this system has — it is reality
 * outranking the model — and until now it was also the slowest to leave the
 * building. `submitReport` recorded it, and nothing told anybody until the
 * hourly scoring run came round, which on a bad draw is 59 minutes after
 * somebody stood in the water and said so.
 *
 * The obvious fix is to dispatch from `submitReport`. It was rejected: that
 * handler is the public, unauthenticated write path, and giving it the ability
 * to read the Watchers table would mean the most exposed function in the stack
 * could enumerate who is watching where. Dispatch stays behind a separate
 * function with its own role, and `submitReport` holds nothing but
 * `lambda:InvokeFunction` on this one ARN.
 *
 * Invoked asynchronously, so the person who tapped the button gets their
 * acknowledgement without waiting for a push service, and so a failure here
 * can never fail their report.
 */

interface NotifyEvent {
  cell: string;
  cellPrefix: string;
  confirmingCount: number;
  strongestDepth?: DepthLevel;
}

function isNotifyEvent(value: unknown): value is NotifyEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event["cell"] === "string" &&
    typeof event["cellPrefix"] === "string" &&
    typeof event["confirmingCount"] === "number" &&
    (event["strongestDepth"] === undefined || isDepthLevel(event["strongestDepth"]))
  );
}

export const handler = async (event: unknown): Promise<void> => {
  if (!isNotifyEvent(event)) {
    // Nothing reaches this function except our own invoke, so a malformed
    // event is a bug rather than user input. Throwing surfaces it in the
    // async invoke's error metric instead of failing silently.
    throw new Error(`notifyCell received a malformed event: ${JSON.stringify(event)}`);
  }

  const riskCellsTable = requireTable("RISK_CELLS_TABLE");
  const explanation = explainConfirmed(event.confirmingCount, event.strongestDepth);

  // Claim the transition BEFORE sending anything.
  //
  // Several people reporting the same junction within seconds produce several
  // concurrent invocations of this function, and each one would otherwise read
  // "not yet confirmed", and each would alert. The conditional update is what
  // makes exactly one of them win: the losers fail the condition and return
  // without sending. Alerting first and writing afterwards would leave that
  // race wide open, and the failure mode is a watcher's phone buzzing four
  // times for one flood.
  //
  // It also matches what the hourly run does. Once the level is `confirmed`,
  // `isNewlyDangerous` sees no transition and will not re-announce it.
  try {
    await documents.send(
      new UpdateCommand({
        TableName: riskCellsTable,
        Key: { cellPrefix: event.cellPrefix, cell: event.cell },
        UpdateExpression:
          "SET #level = :confirmed, #explanation = :explanation, #basis = :basis, #updatedAt = :now",
        // The cell must already exist — this function creates nothing. A
        // report outside the seeded grid is a bug upstream, not a new cell.
        ConditionExpression: "attribute_exists(cell) AND #level <> :confirmed",
        ExpressionAttributeNames: {
          "#level": "level",
          "#explanation": "explanation",
          "#basis": "basis",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":confirmed": "confirmed",
          ":explanation": explanation,
          ":basis": "reports",
          ":now": new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      // Already confirmed, by the hourly run or by a concurrent report. The
      // alert has been sent or is being sent by whoever won. Not an error.
      console.log(`Cell ${event.cell} was already confirmed; no alert sent.`);
      emitMetrics({ InstantAlertSuppressed: 1 });
      return;
    }
    throw error;
  }

  const watchersTable = process.env["WATCHERS_TABLE"];
  if (!watchersTable) {
    console.warn("No watchers table configured; cell confirmed but no alert sent.");
    return;
  }

  const raised: RaisedCell[] = [
    { cell: event.cell, level: "confirmed", explanation },
  ];

  const dispatched = await dispatchAlerts(raised, watchersTable, await loadVapidKeys());

  emitMetrics({
    InstantAlertsSent: dispatched.sent,
    InstantAlertsFailed: dispatched.failed,
    InstantSubscriptionsPruned: dispatched.pruned,
  });

  console.log(
    `Cell ${event.cell} confirmed by report. Alerts sent ${dispatched.sent}, ` +
      `failed ${dispatched.failed}, pruned ${dispatched.pruned}.`,
  );
};
