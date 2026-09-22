import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { documents, requireTable } from "../lib/dynamo.ts";
import { json, problem } from "../lib/http.ts";
import { bounds } from "../lib/geohash.ts";
import { describeCoverage, parseBbox, prefixesForViewport } from "../lib/pilot.ts";
import {
  describeTerrain,
  explainTerrain,
  levelFromScore,
  terrainBand,
  type RiskBasis,
} from "../lib/risk.ts";
import { rainOutlook, type RainOutlook } from "../lib/scoring.ts";

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
  // The forecast the scoring job actually used for this cell. Null when the
  // feed was down on that run, which is not the same as zero rain.
  rainfall6h?: number | null;
  rainfall24h?: number | null;
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

  const { prefixes, truncated } = prefixesForViewport(box);
  if (prefixes.length === 0) {
    // Viewport lies entirely outside coverage. Not an error: the map says so,
    // rather than showing an empty overlay with no explanation. An empty
    // overlay and low risk everywhere look identical on screen, and only one
    // of them is true here.
    return json(200, {
      cells: [],
      outsideCoverage: true,
      // Retained so a browser running the previous bundle against this
      // deployment still understands the answer. Remove once the web build
      // that reads `outsideCoverage` has been live for a while.
      outsidePilotArea: true,
      message: `Outside the area Accra Flood Watch covers (${describeCoverage()}).`,
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
  // The wettest cell in view decides the outlook. A viewport is dry only when
  // all of it is: foregrounding terrain over a corner that has rain coming
  // would hide the one thing the user needed to see.
  let wettest6h = 0;
  let wettest24h = 0;
  let anyRainfallKnown = false;

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

      if (typeof item.rainfall6h === "number" && typeof item.rainfall24h === "number") {
        anyRainfallKnown = true;
        wettest6h = Math.max(wettest6h, item.rainfall6h);
        wettest24h = Math.max(wettest24h, item.rainfall24h);
      }

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
        // The terrain reading, carried alongside the live one rather than
        // instead of it. Both are always present, so the client can switch
        // between showing weather and showing ground without a second request
        // -- which matters on a connection where the second request is the one
        // that does not arrive.
        terrainBand: terrainBand(item.susceptibility),
        terrainExplanation: describeTerrain(
          item.susceptibility,
          item.hand,
          item.historicalFloodPoint,
        ),
      };
    });

  const outlook: RainOutlook | null = anyRainfallKnown
    ? rainOutlook({ next6hMm: wettest6h, next24hMm: wettest24h })
    : null;

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
      // Is rain coming at all? Null when the feed was down on the run that
      // produced these cells -- the client must not read "no forecast" as
      // "no rain" and quietly switch to the terrain view on that basis.
      rainOutlook: outlook,
      rainfall: anyRainfallKnown
        ? { next6hMm: round1(wettest6h), next24hMm: round1(wettest24h) }
        : null,
      // The viewport needed more partitions than one request returns, so
      // these cells are part of it rather than all of it. The client says so
      // instead of drawing a map that is blank where it ran out.
      truncated,
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
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function weakestBasis(cells: ReadonlyArray<{ basis: RiskBasis }>): RiskBasis {
  if (cells.length === 0) return "terrain-only";
  if (cells.some((cell) => cell.basis === "terrain-only")) return "terrain-only";
  if (cells.some((cell) => cell.basis === "terrain-and-reports")) return "terrain-and-reports";
  return "terrain-and-forecast";
}
