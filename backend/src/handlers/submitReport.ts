import { randomUUID } from "node:crypto";

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { documents, requireTable } from "../lib/dynamo.ts";
import { json, problem } from "../lib/http.ts";
import { cellFor, isInsidePilotArea, prefixFor } from "../lib/pilot.ts";
import {
  CONFIRMATION_REPORT_COUNT,
  CONFIRMATION_WINDOW_MINUTES,
  CONFIRMING_DEPTHS,
  DEPTH_LABELS,
  type DepthLevel,
  isDepthLevel,
} from "../lib/risk.ts";

const REPORT_TTL_HOURS = 24;

interface ExistingReport {
  reportId: string;
  cell: string;
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

  if (!isDepthLevel(depth)) {
    return problem(400, "depth must be ankle, knee, waist or impassable");
  }
  if (typeof latitude !== "number" || !Number.isFinite(latitude)) {
    return problem(400, "latitude must be a number");
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude)) {
    return problem(400, "longitude must be a number");
  }

  // Reports outside the pilot boundary are rejected at the handler. Accepting
  // them would put points on a map the terrain grid knows nothing about.
  if (!isInsidePilotArea(latitude, longitude)) {
    return problem(
      422,
      "That location is outside the Accra Flood Watch pilot area (Circle, Kaneshie and Avenor).",
    );
  }

  const cell = cellFor(latitude, longitude);
  const cellPrefix = prefixFor(latitude, longitude);
  const now = new Date();
  const submittedAt = now.toISOString();

  // Timestamp-prefixed so the sort key orders reports by age within an area,
  // and the random suffix keeps concurrent submissions distinct.
  const reportId = `${submittedAt}#${randomUUID()}`;
  const expiresAt = Math.floor(now.getTime() / 1000) + REPORT_TTL_HOURS * 3600;

  const reportsTable = requireTable("REPORTS_TABLE");

  await documents.send(
    new PutCommand({
      TableName: reportsTable,
      Item: {
        cellPrefix,
        reportId,
        cell,
        depth,
        // Coordinates, a severity and a timestamp. Nothing else. Nothing links
        // two reports from the same device.
        latitude: Math.round(latitude * 1e6) / 1e6,
        longitude: Math.round(longitude * 1e6) / 1e6,
        submittedAt,
        expiresAt,
      },
    }),
  );

  // Recompute the live component immediately so a confirmed flooding state
  // does not wait for the next hourly run.
  const confirmation = await evaluateConfirmation(reportsTable, cellPrefix, cell, now);

  return json(201, {
    accepted: true,
    cell,
    depth,
    depthLabel: DEPTH_LABELS[depth],
    submittedAt,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    ...confirmation,
    message:
      confirmation.level === "confirmed"
        ? "Thank you. Enough people have reported water here that the map now shows confirmed flooding."
        : "Thank you. Your report is on the map. It will disappear automatically in 24 hours.",
  });
};

/**
 * A single report marks a cell unconfirmed; confirmed flooding requires two or
 * more independent reports within three hours.
 *
 * Reality outranks the model: if residents say there is water, the map says
 * there is water, whatever the forecast believes.
 */
async function evaluateConfirmation(
  table: string,
  cellPrefix: string,
  cell: string,
  now: Date,
): Promise<{ level: "reported" | "confirmed"; recentReports: number }> {
  const windowStart = new Date(
    now.getTime() - CONFIRMATION_WINDOW_MINUTES * 60_000,
  ).toISOString();

  const result = await documents.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "cellPrefix = :prefix AND reportId >= :since",
      ExpressionAttributeValues: { ":prefix": cellPrefix, ":since": windowStart },
    }),
  );

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const qualifying = ((result.Items ?? []) as ExistingReport[]).filter(
    (item) =>
      item.cell === cell &&
      item.expiresAt > nowSeconds &&
      (CONFIRMING_DEPTHS as readonly string[]).includes(item.depth),
  );

  return {
    level:
      qualifying.length >= CONFIRMATION_REPORT_COUNT ? "confirmed" : "reported",
    recentReports: qualifying.length,
  };
}
