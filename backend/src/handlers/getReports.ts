import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { queryAll, requireTable } from "../lib/dynamo.ts";
import { json, problem } from "../lib/http.ts";
import { parseBbox, prefixesForViewport } from "../lib/pilot.ts";
import {
  CONFIRMATION_REPORT_COUNT,
  CONFIRMATION_WINDOW_MINUTES,
  CONFIRMING_DEPTHS,
  DEPTH_LABELS,
  type DepthLevel,
  type ReportCondition,
  isClearedByReports,
} from "../lib/risk.ts";

interface ReportItem {
  cellPrefix: string;
  reportId: string;
  cell: string;
  condition?: ReportCondition;
  depth: DepthLevel;
  latitude: number;
  longitude: number;
  submittedAt: string;
  expiresAt: number;
}

/**
 * Active reports for a map viewport.
 *
 * Returns severity and age, never an identifier and never anything that could
 * link two reports from the same device.
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const box = parseBbox(event.queryStringParameters?.bbox);
  if (!box) {
    return problem(400, "bbox must be west,south,east,north in degrees");
  }

  const { prefixes, truncated } = prefixesForViewport(box);
  if (prefixes.length === 0) {
    return json(200, { reports: [], outsideCoverage: true, outsidePilotArea: true });
  }

  const table = requireTable("REPORTS_TABLE");
  const nowSeconds = Math.floor(Date.now() / 1000);

  const results = await Promise.all(
    prefixes.map((prefix) =>
      queryAll<ReportItem>(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "cellPrefix = :prefix",
          ExpressionAttributeValues: { ":prefix": prefix },
          // Newest first: reportId is timestamp-prefixed.
          ScanIndexForward: false,
        }),
      ),
    ),
  );

  const reports = results
    .flat()
    // TTL deletion is eventual, so an expired item can still be returned by a
    // query for a short window. Filter on read rather than showing a report
    // the application has promised would be gone.
    .filter((item) => item.expiresAt > nowSeconds)
    .filter(
      (item) =>
        item.longitude >= box.west &&
        item.longitude <= box.east &&
        item.latitude >= box.south &&
        item.latitude <= box.north,
    )
    .map((item) => {
      const ageMinutes = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(item.submittedAt)) / 60_000),
      );
      const condition = item.condition ?? "flooded";
      return {
        cell: item.cell,
        condition,
        depth: item.depth,
        depthLabel:
          condition === "cleared"
            ? "water has gone"
            : (DEPTH_LABELS[item.depth] ?? item.depth),
        latitude: item.latitude,
        longitude: item.longitude,
        // Every report carries its age so users can weigh it themselves.
        ageMinutes,
        ageLabel: describeAge(ageMinutes),
        submittedAt: item.submittedAt,
      };
    })
    .sort((a, b) => a.ageMinutes - b.ageMinutes);

  return json(200, {
    reports,
    reportCount: reports.length,
    // Cells residents have confirmed since the last scoring run.
    //
    // The hourly job is what normally sets `confirmed`, which means a cell can
    // sit for up to an hour showing `watch` while the push alert already told
    // somebody there is water in it. The map and the notification disagreeing
    // about one fact is worse than either being slightly stale.
    //
    // Computed here rather than in the browser on purpose: the rule -- two
    // independent reports at a confirming depth inside three hours -- is the
    // project's own definition of confirmed flooding, and it must have exactly
    // one implementation. Duplicating the constants client-side would let the
    // two drift silently, and the drift would show up as a map that disagrees
    // with itself.
    confirmedCells: confirmedCells(reports, Date.now()),
    truncated,
    generatedAt: new Date().toISOString(),
  });
};

/** Cells with enough recent corroboration to count as confirmed flooding. */
function confirmedCells(
  reports: ReadonlyArray<{
    cell: string;
    depth: DepthLevel;
    condition?: ReportCondition;
    submittedAt: string;
  }>,
  now: number,
): string[] {
  const byCell = new Map<string, (typeof reports)[number][]>();
  for (const report of reports) {
    const existing = byCell.get(report.cell);
    if (existing) existing.push(report);
    else byCell.set(report.cell, [report]);
  }

  const at = new Date(now);
  const confirmed: string[] = [];

  for (const [cell, cellReports] of byCell) {
    // Residents have withdrawn the evidence. Never confirm over a clear.
    if (isClearedByReports(cellReports, at)) continue;

    const qualifying = cellReports.filter((report) => {
      if ((report.condition ?? "flooded") !== "flooded") return false;
      if (!(CONFIRMING_DEPTHS as readonly string[]).includes(report.depth)) return false;

      const age = (now - Date.parse(report.submittedAt)) / 60_000;
      return Number.isFinite(age) && age >= 0 && age <= CONFIRMATION_WINDOW_MINUTES;
    });

    if (qualifying.length >= CONFIRMATION_REPORT_COUNT) confirmed.push(cell);
  }

  return confirmed.sort();
}

function describeAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  return `${hours} hours ago`;
}
