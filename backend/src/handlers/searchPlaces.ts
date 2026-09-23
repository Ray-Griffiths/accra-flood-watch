import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { GeoPlacesClient, SearchTextCommand } from "@aws-sdk/client-geo-places";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { documents, queryAll, requireTable } from "../lib/dynamo.ts";
import { summarise } from "../lib/history.ts";
import { json, problem } from "../lib/http.ts";
import {
  COVERAGE_ENVELOPE,
  areaContaining,
  cellFor,
  describeCoverage,
  prefixOfCell,
} from "../lib/pilot.ts";
import { describeTerrain, explainTerrain, levelFromScore, terrainBand } from "../lib/risk.ts";

/**
 * Find a place by name, and say whether it is flooded.
 *
 * The question this answers is the one people actually arrive with: "is
 * Kaneshie Market passable right now". Panning a map to find a junction you
 * already know the name of is work, and it is work done one-handed in rain.
 *
 * Two things shape this handler, and both are about not being confidently
 * wrong:
 *
 * 1. **A match is a candidate, never a verdict.** Geocoding Accra is uneven:
 *    tested against the live service, "Ring Road Central" returns a bank
 *    branch, and "Kwame Nkrumah Circle" returns two positions two kilometres
 *    apart. So every result carries the name the service matched and its
 *    coordinates, for the user to confirm on the map before believing the
 *    risk attached to it. Answering "Odorkor is not flooded" off a mismatched
 *    pin would be worse than returning nothing.
 *
 * 2. **Outside coverage is its own answer.** A place the terrain grid has
 *    never seen is reported as uncovered, never as safe. Results outside the
 *    covered areas are kept rather than dropped -- a user who searched for
 *    somewhere real deserves to be told it is off the edge of the map, not
 *    shown an empty list that reads as "no such place".
 *
 * GeoPlaces is called with IAM credentials from here and never from the
 * browser: it is billed per request, and a key in page source is a key anyone
 * can spend.
 */

const geoPlaces = new GeoPlacesClient({});

/** Enough to choose from, few enough to read on a phone without scrolling. */
const MAX_RESULTS = 5;

/**
 * Longest query worth sending.
 *
 * Not a validation rule so much as a cost guard: this endpoint is
 * unauthenticated and every call is billed, so an unbounded string is an
 * unbounded bill.
 */
const MAX_QUERY_CHARS = 120;

interface RiskCellItem {
  cell: string;
  susceptibility: number;
  hand: number;
  historicalFloodPoint?: string;
  score?: number;
  level?: string;
  basis?: string;
  explanation?: string;
  updatedAt?: string;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const query = (event.queryStringParameters?.["q"] ?? "").trim();

  if (query.length === 0) {
    return problem(400, "Type a place name to search for.");
  }
  if (query.length > MAX_QUERY_CHARS) {
    return problem(400, "That search is too long. Try a street or landmark name.");
  }

  let matches: Awaited<ReturnType<typeof search>>;
  try {
    matches = await search(query);
  } catch (error) {
    // A search failure is not a flood answer. Saying so beats a 500, which the
    // client can only report as the whole service being unreachable.
    console.error(`Place search failed for ${JSON.stringify(query)}`, error);
    return json(200, {
      query,
      results: [],
      failed: true,
      message: "Search is not responding just now. You can still pan the map to find a place.",
    });
  }

  const results = await Promise.all(matches.map(resolveRisk));

  return json(
    200,
    {
      query,
      results,
      resultCount: results.length,
      coverage: describeCoverage(),
      message:
        results.length === 0
          ? `Nothing found for "${query}" in ${describeCoverage()}.`
          : undefined,
    },
    // Place names do not move. The risk attached to them does, so this is
    // short enough that a cached hit cannot outlive a scoring run.
    60,
  );
};

interface PlaceMatch {
  title: string;
  longitude: number;
  latitude: number;
}

async function search(query: string): Promise<PlaceMatch[]> {
  const response = await geoPlaces.send(
    new SearchTextCommand({
      QueryText: query,
      MaxResults: MAX_RESULTS,
      // Bias towards the middle of what this map covers, so a bare street name
      // resolves locally rather than to a same-named road in another country.
      BiasPosition: [
        (COVERAGE_ENVELOPE.west + COVERAGE_ENVELOPE.east) / 2,
        (COVERAGE_ENVELOPE.south + COVERAGE_ENVELOPE.north) / 2,
      ],
      Language: "en",
    }),
  );

  const matches: PlaceMatch[] = [];
  for (const item of response.ResultItems ?? []) {
    const position = item.Position;
    if (!position || position.length < 2) continue;

    const [longitude, latitude] = position as [number, number];
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;

    matches.push({
      title: item.Title ?? query,
      longitude,
      latitude,
    });
  }

  return matches;
}

/**
 * Attach the flood picture to a matched place.
 *
 * A place outside coverage gets `covered: false` and no risk at all. Returning
 * `low` for ground the grid has never scored would be inventing an all-clear.
 */
async function resolveRisk(match: PlaceMatch): Promise<Record<string, unknown>> {
  const area = areaContaining(match.latitude, match.longitude);

  const base = {
    title: match.title,
    longitude: match.longitude,
    latitude: match.latitude,
  };

  if (!area) {
    return {
      ...base,
      covered: false,
      message: `This is outside the area Accra Flood Watch covers (${describeCoverage()}).`,
    };
  }

  const cell = cellFor(match.latitude, match.longitude);

  let item: RiskCellItem | undefined;
  try {
    const result = await documents.send(
      new GetCommand({
        TableName: requireTable("RISK_CELLS_TABLE"),
        Key: { cellPrefix: prefixOfCell(cell), cell },
      }),
    );
    item = result.Item as RiskCellItem | undefined;
  } catch (error) {
    console.error(`Could not read risk for ${cell}`, error);
  }

  if (!item) {
    // Inside a covered area but with no cell behind it. Possible at the very
    // edge of an area, where the envelope includes ground the grid stops
    // short of. Not an error, and not an all-clear either.
    return {
      ...base,
      covered: true,
      areaId: area.id,
      cell,
      message: "No flood reading for this exact spot. Check the streets around it on the map.",
    };
  }

  const score = typeof item.score === "number" ? item.score : item.susceptibility;
  const history = await floodHistory(cell);

  return {
    ...base,
    covered: true,
    areaId: area.id,
    cell,
    score: Math.round(score * 10) / 10,
    level: item.level ?? levelFromScore(score),
    // The terrain figures travel with the result because the client opens the
    // detail sheet on it, and that sheet states height above the nearest drain
    // as a fact. Sending the level without them would leave the client to
    // invent a number -- which it did, and which printed "0.0 m" over real
    // ground until this was caught in a screenshot.
    susceptibility: item.susceptibility,
    hand: item.hand,
    basis: item.basis ?? "terrain-only",
    ...(item.historicalFloodPoint ? { historicalFloodPoint: item.historicalFloodPoint } : {}),
    // The same sentence the map and the detail sheet show, so searching for a
    // place and tapping it cannot produce two different accounts of one cell.
    explanation:
      item.explanation ?? explainTerrain(item.susceptibility, item.hand, item.historicalFloodPoint),
    terrainBand: terrainBand(item.susceptibility),
    terrainExplanation: describeTerrain(
      item.susceptibility,
      item.hand,
      item.historicalFloodPoint,
    ),
    updatedAt: item.updatedAt,
    // Null when nothing has been reported here. Deliberately not "0 days":
    // an absence of reports is evidence nobody with a phone walked past, not
    // evidence the place does not flood.
    ...(history ? { history } : {}),
  };
}

/**
 * How many separate days flooding has been reported in this cell.
 *
 * A failure yields null rather than throwing: the flood history is context,
 * and losing it must not cost the user the risk reading they searched for.
 */
async function floodHistory(cell: string): Promise<string | null> {
  const table = process.env["FLOOD_HISTORY_TABLE"];
  if (!table) return null;

  try {
    const markers = await queryAll<{ day: string }>(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "cell = :cell",
        ExpressionAttributeValues: { ":cell": cell },
      }),
    );
    return summarise(markers.map((marker) => marker.day)).sentence;
  } catch (error) {
    console.error(`Could not read flood history for ${cell}`, error);
    return null;
  }
}
