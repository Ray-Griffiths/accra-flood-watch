import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { documents, requireTable } from "../lib/dynamo.ts";
import { json, problem } from "../lib/http.ts";
import { parseBbox, prefixesForViewport } from "../lib/pilot.ts";
import { DEPTH_LABELS, type DepthLevel } from "../lib/risk.ts";

interface ReportItem {
  cellPrefix: string;
  reportId: string;
  cell: string;
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
      documents.send(
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
    .flatMap((result) => (result.Items ?? []) as ReportItem[])
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
      return {
        cell: item.cell,
        depth: item.depth,
        depthLabel: DEPTH_LABELS[item.depth] ?? item.depth,
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
    truncated,
    generatedAt: new Date().toISOString(),
  });
};

function describeAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  return `${hours} hours ago`;
}
