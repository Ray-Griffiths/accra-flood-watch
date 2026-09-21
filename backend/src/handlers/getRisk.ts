import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { documents, requireTable } from "../lib/dynamo.ts";
import { json, problem } from "../lib/http.ts";
import { bounds } from "../lib/geohash.ts";
import { parseBbox, prefixesForViewport } from "../lib/pilot.ts";
import { explainTerrain, levelFromScore, type RiskBasis } from "../lib/risk.ts";

interface RiskCellItem {
  cellPrefix: string;
  cell: string;
  susceptibility: number;
  hand: number;
  slope: number;
  elevation: number;
  historicalFloodPoint?: string;
  // Written by the hourly scoring job; absent until it first runs.
  score?: number;
  level?: string;
  basis?: string;
  explanation?: string;
  updatedAt?: string;
}

/**
 * Risk cells for a map viewport. The dominant read in the application.
 *
 * Bounds become a small set of geohash-6 prefixes, each resolved with a single
 * Query. No scan, no geospatial index, no filter.
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const box = parseBbox(event.queryStringParameters?.bbox);
  if (!box) {
    return problem(400, "bbox must be west,south,east,north in degrees");
  }

  const prefixes = prefixesForViewport(box);
  if (prefixes.length === 0) {
    // Viewport lies entirely outside the pilot area. Not an error: the map
    // says so, rather than showing an empty overlay with no explanation.
    return json(200, {
      cells: [],
      outsidePilotArea: true,
      message: "Outside the Accra Flood Watch pilot area.",
    });
  }

  const table = requireTable("RISK_CELLS_TABLE");

  const results = await Promise.all(
    prefixes.map((prefix) =>
      documents.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "cellPrefix = :prefix",
          ExpressionAttributeValues: { ":prefix": prefix },
        }),
      ),
    ),
  );

  let staleScores = false;
  const cells = results
    .flatMap((result) => (result.Items ?? []) as RiskCellItem[])
    .filter((item) => {
      // A prefix straddles the viewport edge, so drop cells that fall outside.
      const cellBounds = bounds(item.cell);
      return (
        cellBounds.east > box.west &&
        cellBounds.west < box.east &&
        cellBounds.north > box.south &&
        cellBounds.south < box.north
      );
    })
    .map((item) => {
      const hasLiveScore = typeof item.score === "number";
      if (!hasLiveScore) staleScores = true;

      const score = hasLiveScore ? item.score! : item.susceptibility;
      // The scoring job records what it actually had to work with. Trust that
      // over any inference made here: only it knows whether the forecast feed
      // answered on the run that produced this number.
      const basis: RiskBasis =
        (item.basis as RiskBasis | undefined) ??
        (hasLiveScore ? "terrain-and-forecast" : "terrain-only");

      return {
        cell: item.cell,
        bounds: bounds(item.cell),
        score: Math.round(score * 10) / 10,
        level: item.level ?? levelFromScore(score),
        basis,
        explanation:
          item.explanation ??
          explainTerrain(item.susceptibility, item.hand, item.historicalFloodPoint),
        susceptibility: item.susceptibility,
        hand: item.hand,
        historicalFloodPoint: item.historicalFloodPoint,
        updatedAt: item.updatedAt,
      };
    });

  return json(
    200,
    {
      cells,
      cellCount: cells.length,
      // Fail readable: the map must always say what it is showing, rather than
      // presenting terrain susceptibility as though it were a live warning.
      // Reported at the weakest basis of any cell in view -- claiming a
      // forecast the whole viewport does not have would be the overstatement
      // this field exists to prevent.
      basis: weakestBasis(cells),
      forecastAvailable:
        !staleScores && cells.every((cell) => cell.basis === "terrain-and-forecast"),
      generatedAt: new Date().toISOString(),
    },
    // Brief edge caching. Risk changes hourly at most, and a storm-time
    // traffic spike must not turn into a DynamoDB spike.
    60,
  );
};

/**
 * The least informed basis among the cells on screen.
 *
 * A viewport is only as current as its worst cell: if one corner was scored
 * without a forecast, the map must not tell the user it has one.
 */
function weakestBasis(cells: ReadonlyArray<{ basis: RiskBasis }>): RiskBasis {
  if (cells.length === 0) return "terrain-only";
  if (cells.some((cell) => cell.basis === "terrain-only")) return "terrain-only";
  if (cells.some((cell) => cell.basis === "terrain-and-reports")) return "terrain-and-reports";
  return "terrain-and-forecast";
}
