import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { CalculateRoutesCommand, GeoRoutesClient } from "@aws-sdk/client-geo-routes";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { documents, requireTable } from "../lib/dynamo.ts";
import { boundingBox, boxesOnPath, type Position } from "../lib/geometry.ts";
import { bounds, cellsCovering, type Bounds } from "../lib/geohash.ts";
import { json, problem } from "../lib/http.ts";
import {
  MAX_PREFIXES_PER_REQUEST,
  PREFIX_PRECISION,
  isInsidePilotArea,
} from "../lib/pilot.ts";
import type { DepthLevel } from "../lib/risk.ts";
import {
  classifyHazards,
  explainNoSafeRoute,
  explainRoute,
  isHardBlock,
  isTravelMode,
  type Hazard,
  type TravelMode,
} from "../lib/routing.ts";

/**
 * A walking or driving route that goes around water people are reporting.
 *
 * Three promises govern this handler, and each one costs something to keep:
 *
 * 1. **A returned route never passes through a hard-blocked cell.**
 *    `Avoid.Areas` is documented as best effort -- the router "may still
 *    include restricted areas if no feasible alternative route exists". So the
 *    geometry that comes back is checked against the blocked cells here, and a
 *    route that violates one is discarded rather than displayed. The service's
 *    own violation notice is read too, but the geometric check is the
 *    guarantee: it does not depend on being told.
 *
 * 2. **A detour is stated.** When there is anything to avoid, the direct route
 *    is calculated as well, purely so the answer can say what the avoidance
 *    cost. That is a second billed request, and it is the only honest way to
 *    say "this adds nine minutes".
 *
 * 3. **No route is better than a wrong route.** When everything through is
 *    flooded, the answer is `found: false` with a sentence telling the person
 *    not to travel. Never a route through water with a warning attached.
 *
 * GeoRoutes is called with IAM credentials from here and never from the
 * browser: it costs materially more per request than tiles, and a key in page
 * source is a key anyone can spend.
 */

const geoRoutes = new GeoRoutesClient({});

/** Hazards are gathered from a corridor this much wider than the trip. */
const CORRIDOR_PAD_DEGREES = 0.004; // ~450m

interface RiskCellItem {
  cell: string;
  level?: string;
}

interface ReportItem {
  cell: string;
  depth: DepthLevel;
  expiresAt?: number;
}

interface RouteRequest {
  origin: Position;
  destination: Position;
  mode: TravelMode;
}

function parseRequest(body: string | undefined): RouteRequest | string {
  if (!body) return "A request body is required.";

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "The request body must be JSON.";
  }

  const raw = parsed as { origin?: unknown; destination?: unknown; mode?: unknown };

  const origin = parsePosition(raw.origin);
  if (!origin) return "origin must be [longitude, latitude].";

  const destination = parsePosition(raw.destination);
  if (!destination) return "destination must be [longitude, latitude].";

  const mode = raw.mode ?? "walking";
  if (!isTravelMode(mode)) return "mode must be walking or driving.";

  // Flooding is only known inside the pilot grid, so a route leaving it cannot
  // be vouched for. Saying that is better than returning a route whose second
  // half was checked against nothing.
  if (!isInsidePilotArea(origin[1], origin[0])) {
    return "The starting point is outside the Circle, Kaneshie and Avenor pilot area.";
  }
  if (!isInsidePilotArea(destination[1], destination[0])) {
    return "The destination is outside the Circle, Kaneshie and Avenor pilot area.";
  }

  return { origin, destination, mode };
}

function parsePosition(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lon, lat] = value as [unknown, unknown];
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return [lon, lat];
}

/** Every cell and report in the corridor between the two points. */
async function loadCorridor(corridor: Bounds): Promise<Hazard[]> {
  const prefixes = cellsCovering(corridor, PREFIX_PRECISION).slice(
    0,
    MAX_PREFIXES_PER_REQUEST,
  );
  if (prefixes.length === 0) return [];

  const riskTable = requireTable("RISK_CELLS_TABLE");
  const reportsTable = requireTable("REPORTS_TABLE");

  const query = (table: string, prefix: string) =>
    documents.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "cellPrefix = :prefix",
        ExpressionAttributeValues: { ":prefix": prefix },
      }),
    );

  const [cellResults, reportResults] = await Promise.all([
    Promise.all(prefixes.map((prefix) => query(riskTable, prefix))),
    Promise.all(prefixes.map((prefix) => query(reportsTable, prefix))),
  ]);

  const nowSeconds = Math.floor(Date.now() / 1000);

  // TTL deletes within 48 hours of expiry rather than at the instant of it, so
  // a lapsed report can still be sitting in the table. It must not close a road.
  const reports = reportResults
    .flatMap((result) => (result.Items ?? []) as ReportItem[])
    .filter((item) => !(typeof item.expiresAt === "number" && item.expiresAt <= nowSeconds));

  const cells = cellResults
    .flatMap((result) => (result.Items ?? []) as RiskCellItem[])
    .filter((item) => typeof item.cell === "string" && item.cell.length > 0)
    .map((item) => ({ cell: item.cell, bounds: bounds(item.cell), level: item.level }));

  return classifyHazards({ cells, reports });
}

interface CalculatedRoute {
  coordinates: Position[];
  distanceMetres: number;
  durationSeconds: number;
  violatedAvoidance: boolean;
}

async function calculate(
  request: RouteRequest,
  avoidAreas: readonly Hazard[],
): Promise<CalculatedRoute | null> {
  const response = await geoRoutes.send(
    new CalculateRoutesCommand({
      Origin: [...request.origin],
      Destination: [...request.destination],
      TravelMode: request.mode === "walking" ? "Pedestrian" : "Car",
      // Simple returns coordinates directly. The alternative is an encoded
      // polyline that would have to be decoded before it could be checked, and
      // the check is the thing that makes this feature safe.
      LegGeometryFormat: "Simple",
      DepartNow: true,
      ...(avoidAreas.length > 0
        ? {
            Avoid: {
              Areas: avoidAreas.map((hazard) => ({
                Geometry: {
                  BoundingBox: [
                    hazard.bounds.west,
                    hazard.bounds.south,
                    hazard.bounds.east,
                    hazard.bounds.north,
                  ],
                },
              })),
            },
          }
        : {}),
    }),
  );

  const route = response.Routes?.[0];
  if (!route) return null;

  const coordinates: Position[] = [];
  let violatedAvoidance = false;
  // Summed from the legs rather than read off `route.Summary`, which comes
  // back empty in eu-west-1 for both travel modes -- verified against the live
  // service, where trusting it produced a route reported as "0 m, 0 minutes".
  // The per-leg overview is populated, and summing it is correct anyway for a
  // route with more than one leg.
  let distanceMetres = 0;
  let durationSeconds = 0;

  for (const leg of route.Legs ?? []) {
    for (const point of leg.Geometry?.LineString ?? []) {
      const [lon, lat] = point as [number, number];
      if (typeof lon === "number" && typeof lat === "number") coordinates.push([lon, lat]);
    }

    const overview =
      leg.PedestrianLegDetails?.Summary?.Overview ?? leg.VehicleLegDetails?.Summary?.Overview;
    distanceMetres += overview?.Distance ?? 0;
    durationSeconds += overview?.Duration ?? 0;

    const notices = [
      ...(leg.PedestrianLegDetails?.Notices ?? []),
      ...(leg.VehicleLegDetails?.Notices ?? []),
    ];
    if (notices.some((notice) => notice.Code === "ViolatedAvoidAreas")) {
      violatedAvoidance = true;
    }
  }

  if (coordinates.length === 0) return null;

  return {
    coordinates,
    distanceMetres: distanceMetres || (route.Summary?.Distance ?? 0),
    durationSeconds: durationSeconds || (route.Summary?.Duration ?? 0),
    violatedAvoidance,
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const parsed = parseRequest(event.body);
  if (typeof parsed === "string") return problem(400, parsed);

  const corridor = boundingBox([parsed.origin, parsed.destination], CORRIDOR_PAD_DEGREES);
  const hazards = await loadCorridor(corridor);
  const blocked = hazards.filter((hazard) => isHardBlock(hazard.reason));

  // The direct route is calculated only when there is something to avoid, so
  // the ordinary dry-day request stays a single billed call.
  const [safe, direct] = await Promise.all([
    calculate(parsed, hazards),
    hazards.length > 0 ? calculate(parsed, []) : Promise.resolve(null),
  ]);

  if (!safe) {
    return json(200, {
      found: false,
      mode: parsed.mode,
      reason: "no-route",
      explanation:
        "No route could be found between these two points. Check both are on a road you can use.",
    });
  }

  // The guarantee. `Avoid.Areas` is best effort; this is not.
  const breached = boxesOnPath(safe.coordinates, blocked);
  if (breached.length > 0 || (safe.violatedAvoidance && blocked.length > 0)) {
    console.warn(
      `Discarded a route crossing ${breached.length} blocked cells ` +
        `(service notice: ${safe.violatedAvoidance}).`,
    );
    return json(200, {
      found: false,
      mode: parsed.mode,
      reason: "flooded",
      blockedCells: breached.length > 0 ? breached.length : blocked.length,
      explanation: explainNoSafeRoute(parsed.mode),
    });
  }

  // Count what the avoidance actually achieved: hazards the direct route would
  // have crossed and this one does not. Counting every hazard in the corridor
  // instead would claim credit for water that was never on the way.
  const onDirect = direct ? boxesOnPath(direct.coordinates, hazards) : [];
  const avoidedBlocked = onDirect.filter((hazard) => isHardBlock(hazard.reason)).length;
  const avoidedLikely = onDirect.length - avoidedBlocked;

  const extraSeconds = direct ? Math.round(safe.durationSeconds - direct.durationSeconds) : null;
  const extraMetres = direct ? Math.round(safe.distanceMetres - direct.distanceMetres) : null;

  return json(200, {
    found: true,
    mode: parsed.mode,
    geometry: { type: "LineString", coordinates: safe.coordinates },
    distanceMetres: Math.round(safe.distanceMetres),
    durationSeconds: Math.round(safe.durationSeconds),
    avoided: {
      blocked: avoidedBlocked,
      likely: avoidedLikely,
      // Everything known in the corridor, so the client can say the map was
      // consulted even when nothing was in the way.
      hazardsInArea: hazards.length,
    },
    detour:
      extraSeconds === null
        ? null
        : { extraSeconds: Math.max(0, extraSeconds), extraMetres: Math.max(0, extraMetres ?? 0) },
    explanation: explainRoute({
      mode: parsed.mode,
      blocked: avoidedBlocked,
      likely: avoidedLikely,
      extraSeconds,
      extraMetres,
    }),
  });
};
