import { randomUUID } from "node:crypto";

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { documents, queryAll, requireTable } from "../lib/dynamo.ts";
import { markerFor } from "../lib/history.ts";
import { resolveObservedAt } from "../lib/observed.ts";
import { json, problem } from "../lib/http.ts";
import { cellFor, describeCoverage, isInsideCoverage, prefixFor } from "../lib/pilot.ts";
import {
  CONFIRMATION_REPORT_COUNT,
  CONFIRMATION_WINDOW_MINUTES,
  CONFIRMING_DEPTHS,
  DEPTH_LABELS,
  type DepthLevel,
  type ReportCondition,
  isClearedByReports,
  isDepthLevel,
  isReportCondition,
  strongestDepth,
} from "../lib/risk.ts";

const REPORT_TTL_HOURS = 24;

const lambda = new LambdaClient({});

interface ExistingReport {
  reportId: string;
  cell: string;
  condition?: ReportCondition;
  depth: DepthLevel;
  submittedAt: string;
  expiresAt: number;
}

/**
 * Accept a one-tap water depth report.
 *
 * Unauthenticated by design. The person making this report is standing in
 * water, in the rain, holding a phone they do not want to drop: anything
 * beyond one tap will not happen. That makes this the abuse surface, so
 * validation here and throttling at the API are what keep it honest.
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  let payload: unknown;
  try {
    payload = JSON.parse(event.body ?? "");
  } catch {
    return problem(400, "Body must be JSON");
  }

  if (typeof payload !== "object" || payload === null) {
    return problem(400, "Body must be a JSON object");
  }

  const { depth, latitude, longitude } = payload as Record<string, unknown>;

  // Absent means a water report, which is every row written before clearing
  // existed and every report from a browser running an older bundle.
  const rawCondition = (payload as Record<string, unknown>)["condition"] ?? "flooded";
  if (!isReportCondition(rawCondition)) {
    return problem(400, "condition must be flooded or cleared");
  }
  const condition = rawCondition;

  // A depth is what a flooding report IS. A clearing report has no depth to
  // give -- the whole claim is that there is nothing to measure.
  if (condition === "flooded" && !isDepthLevel(depth)) {
    return problem(400, "depth must be ankle, knee, waist or impassable");
  }
  if (typeof latitude !== "number" || !Number.isFinite(latitude)) {
    return problem(400, "latitude must be a number");
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude)) {
    return problem(400, "longitude must be a number");
  }

  // Reports outside coverage are rejected at the handler. Accepting
  // them would put points on a map the terrain grid knows nothing about.
  if (!isInsideCoverage(latitude, longitude)) {
    return problem(
      422,
      `That location is outside the area Accra Flood Watch covers (${describeCoverage()}).`,
    );
  }

  const now = new Date();

  // A report that was held on the device while it had no signal carries the
  // moment it was OBSERVED, not the moment it arrived. Without that, a report
  // queued offline and delivered twenty minutes later is written as current,
  // and water that has since drained keeps a street marked impassable -- or
  // worse, confirms a cell on the strength of two observations that are no
  // longer true.
  const observed = resolveObservedAt((payload as Record<string, unknown>)["observedAt"], now);
  if (typeof observed === "string") return problem(422, observed);

  const cell = cellFor(latitude, longitude);
  const cellPrefix = prefixFor(latitude, longitude);
  const submittedAt = observed.toISOString();

  // Timestamp-prefixed so the sort key orders reports by age within an area,
  // and the random suffix keeps concurrent submissions distinct.
  const reportId = `${submittedAt}#${randomUUID()}`;
  // Expiry runs from the observation too, so a queued report still vanishes
  // 24 hours after the water was seen rather than 24 hours after it uploaded.
  const expiresAt = Math.floor(observed.getTime() / 1000) + REPORT_TTL_HOURS * 3600;

  const reportsTable = requireTable("REPORTS_TABLE");

  await documents.send(
    new PutCommand({
      TableName: reportsTable,
      Item: {
        cellPrefix,
        reportId,
        cell,
        condition,
        // Only meaningful for a flooding report. Omitted entirely on a clear
        // rather than stored as a placeholder depth nobody observed.
        ...(condition === "flooded" ? { depth: depth as DepthLevel } : {}),
        // Coordinates, a severity and a timestamp. Nothing else. Nothing links
        // two reports from the same device.
        latitude: Math.round(latitude * 1e6) / 1e6,
        longitude: Math.round(longitude * 1e6) / 1e6,
        submittedAt,
        expiresAt,
      },
    }),
  );

  // An anonymous "this cell flooded on this date" marker. Only for reports OF
  // water: a clearing report is the absence of an observation and must not
  // add to a record of how often a place floods.
  if (condition === "flooded") {
    await recordHistory(cell, observed);
  }

  // Recompute the live component immediately so a confirmed flooding state
  // does not wait for the next hourly run.
  const confirmation = await evaluateConfirmation(reportsTable, cellPrefix, cell, now);

  // This report is what tipped the cell over. Anyone watching this place needs
  // to know now, not at the top of the hour.
  if (confirmation.level === "confirmed") {
    await requestAlert(cell, cellPrefix, confirmation);
  }

  return json(201, {
    accepted: true,
    cell,
    condition,
    ...(condition === "flooded"
      ? { depth: depth as DepthLevel, depthLabel: DEPTH_LABELS[depth as DepthLevel] }
      : {}),
    submittedAt,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    ...confirmation,
    message: messageFor(condition, confirmation.level),
  });
};

/**
 * A single report marks a cell unconfirmed; confirmed flooding requires two or
 * more independent reports within three hours.
 *
 * Reality outranks the model: if residents say there is water, the map says
 * there is water, whatever the forecast believes.
 */
interface Confirmation {
  level: "reported" | "confirmed" | "cleared";
  recentReports: number;
  /** Deepest water among the qualifying reports; absent when there are none. */
  strongestDepth?: DepthLevel;
}

async function evaluateConfirmation(
  table: string,
  cellPrefix: string,
  cell: string,
  now: Date,
): Promise<Confirmation> {
  const windowStart = new Date(
    now.getTime() - CONFIRMATION_WINDOW_MINUTES * 60_000,
  ).toISOString();

  const recent = await queryAll<ExistingReport>(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "cellPrefix = :prefix AND reportId >= :since",
      ExpressionAttributeValues: { ":prefix": cellPrefix, ":since": windowStart },
    }),
  );

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const live = recent.filter((item) => item.cell === cell && item.expiresAt > nowSeconds);

  // Residents have withdrawn the evidence of water. That is not a claim the
  // cell is safe -- it only means reports stop counting, and the terrain and
  // forecast decide on their own again.
  if (isClearedByReports(live, now)) {
    return { level: "cleared", recentReports: 0 };
  }

  const qualifying = live.filter(
    (item) =>
      (item.condition ?? "flooded") === "flooded" &&
      (CONFIRMING_DEPTHS as readonly string[]).includes(item.depth),
  );

  const deepest = strongestDepth(qualifying.map((item) => item.depth));

  return {
    level:
      qualifying.length >= CONFIRMATION_REPORT_COUNT ? "confirmed" : "reported",
    recentReports: qualifying.length,
    ...(deepest ? { strongestDepth: deepest } : {}),
  };
}

/**
 * Note that this cell flooded today, and carry on regardless of the outcome.
 *
 * Never allowed to fail the submission. The report itself is the thing the
 * user came to file; the tally is a by-product, and losing a day marker is
 * not worth telling somebody standing in water that their report failed.
 *
 * Writing the same cell and date twice simply overwrites, which is what keeps
 * this a record of days rather than a count of how vocal a street is.
 */
async function recordHistory(cell: string, when: Date): Promise<void> {
  const table = process.env["FLOOD_HISTORY_TABLE"];
  if (!table) return;

  try {
    await documents.send(new PutCommand({ TableName: table, Item: markerFor(cell, when) }));
  } catch (error) {
    console.error(`Could not record flood history for ${cell}`, error);
  }
}

/**
 * What to say back.
 *
 * A clearing report that has not yet reached consensus must not imply the
 * road has been reopened on the map -- it says the report was recorded and
 * what still has to happen. Overstating it here is how somebody walks back
 * into water on the strength of their own single observation.
 */
function messageFor(condition: ReportCondition, level: Confirmation["level"]): string {
  if (condition === "cleared") {
    return level === "cleared"
      ? "Thank you. Enough people agree the water has gone, so the map no longer shows flooding here."
      : "Thank you. Your report is recorded. A few people need to agree before the map stops showing flooding here.";
  }

  return level === "confirmed"
    ? "Thank you. Enough people have reported water here that the map now shows confirmed flooding."
    : "Thank you. Your report is on the map. It will disappear automatically in 24 hours.";
}

/**
 * Hand the alert off to `notifyCell` and return regardless of what happens.
 *
 * Asynchronous invocation, for two reasons. The person who tapped the button
 * is standing in rain waiting for a confirmation screen, and should not wait
 * on a push service to get it. And a report that was successfully recorded
 * must be reported as successfully recorded — failing their submission because
 * a notification could not be sent would be the wrong answer to the wrong
 * question.
 *
 * So every failure here is logged and swallowed. Lambda retries a failed async
 * invocation twice on its own, and if the alert is lost after that, the hourly
 * scoring run still finds the reports standing in the cell and confirms it.
 * The slow path remains the backstop for the fast one.
 */
async function requestAlert(
  cell: string,
  cellPrefix: string,
  confirmation: Confirmation,
): Promise<void> {
  const functionName = process.env["NOTIFY_FUNCTION_NAME"];
  if (!functionName) return;

  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            cell,
            cellPrefix,
            confirmingCount: confirmation.recentReports,
            strongestDepth: confirmation.strongestDepth,
          }),
        ),
      }),
    );
  } catch (error) {
    console.error(`Could not request an alert for ${cell}`, error);
  }
}
