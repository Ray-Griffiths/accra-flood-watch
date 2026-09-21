import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DescribeKeyCommand, LocationClient } from "@aws-sdk/client-location";

import { json } from "../lib/http.ts";
import { PILOT_BBOX, CELL_PRECISION } from "../lib/pilot.ts";

const location = new LocationClient({});

// Resolved once per execution environment. DescribeKey is a control-plane call
// and the key does not change between invocations.
let cachedKey: string | undefined;

async function resolveMapKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const keyName = process.env.MAP_API_KEY_NAME;
  if (!keyName) throw new Error("Missing environment variable MAP_API_KEY_NAME");

  const result = await location.send(new DescribeKeyCommand({ KeyName: keyName }));
  if (!result.Key) throw new Error("DescribeKey returned no key value");

  cachedKey = result.Key;
  return cachedKey;
}

/**
 * Runtime configuration for the browser.
 *
 * The map key is served rather than baked into the bundle, so rotating it does
 * not require rebuilding and redeploying the PWA.
 *
 * This key is scoped to GeoMaps tile and style operations only. Places and
 * Routes cost materially more per request and are never called from the
 * browser -- they go through Lambda with IAM credentials, so usage cannot be
 * driven up by anyone who reads the page source.
 */
export const handler: APIGatewayProxyHandlerV2 = async () => {
  const mapKey = await resolveMapKey();
  const style = process.env.MAP_STYLE ?? "Standard";

  return json(
    200,
    {
      pilotArea: {
        name: "Circle, Kaneshie and Avenor",
        bbox: [PILOT_BBOX.west, PILOT_BBOX.south, PILOT_BBOX.east, PILOT_BBOX.north],
        centre: [
          (PILOT_BBOX.west + PILOT_BBOX.east) / 2,
          (PILOT_BBOX.south + PILOT_BBOX.north) / 2,
        ],
      },
      cellPrecision: CELL_PRECISION,
      map: {
        // Served from this distribution rather than direct from Amazon
        // Location, so tiles are cached at the edge. Tiles are the dominant
        // cost once usage grows; the base map of a fixed city changes
        // essentially never.
        styleUrl: `/v2/styles/${style}/descriptor?key=${encodeURIComponent(mapKey)}`,
        key: mapKey,
        style,
      },
    },
    300,
  );
};
