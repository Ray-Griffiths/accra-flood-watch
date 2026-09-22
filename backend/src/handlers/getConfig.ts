import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DescribeKeyCommand, LocationClient } from "@aws-sdk/client-location";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { json } from "../lib/http.ts";
import {
  CELL_PRECISION,
  COVERAGE_ENVELOPE,
  COVERED_AREAS,
  describeCoverage,
} from "../lib/pilot.ts";

const location = new LocationClient({});
const ssm = new SSMClient({});

// Resolved once per execution environment. DescribeKey is a control-plane call
// and the key does not change between invocations.
let cachedKey: string | undefined;
let cachedVapidKey: string | null | undefined;

/**
 * The public half of the VAPID pair, so the browser can subscribe to push.
 *
 * Public by definition: it is handed to every visitor and is useless without
 * the private half, which this function has no permission to read.
 *
 * Cached, unlike the scoring thresholds. A key that changes is a key rotation,
 * which invalidates every existing subscription anyway and is not something
 * done mid-demo; the argument for re-reading the tunables every run does not
 * apply here. `null` is cached too, so a stack without push configured does
 * not make an SSM call on every page load.
 */
async function resolveVapidKey(): Promise<string | null> {
  if (cachedVapidKey !== undefined) return cachedVapidKey;

  const name = process.env["VAPID_PUBLIC_PARAMETER"];
  if (!name) {
    cachedVapidKey = null;
    return null;
  }

  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name }));
    cachedVapidKey = result.Parameter?.Value ?? null;
  } catch {
    // Push not provisioned on this stack. The rest of the app is unaffected,
    // and the client hides the watch control rather than offering one that
    // cannot work.
    cachedVapidKey = null;
  }
  return cachedVapidKey;
}

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
  const [mapKey, vapidPublicKey] = await Promise.all([resolveMapKey(), resolveVapidKey()]);
  const style = process.env.MAP_STYLE ?? "Standard";

  return json(
    200,
    {
      // Null when push is not provisioned. The client uses this to decide
      // whether to offer a control at all, rather than offering one that
      // fails after the user has already granted a permission.
      pushPublicKey: vapidPublicKey,
      // The areas the terrain grid actually covers, each named so the client
      // can say where a point fell outside rather than only that it did.
      //
      // The envelope is for framing the map and nothing else: with disjoint
      // areas it spans the gaps between them, so treating it as the boundary
      // would accept coordinates over ground with no grid behind it. Boundary
      // decisions use `areas`.
      coverage: {
        description: describeCoverage(),
        areas: COVERED_AREAS.map((area) => ({
          id: area.id,
          name: area.name,
          bbox: [area.bounds.west, area.bounds.south, area.bounds.east, area.bounds.north],
        })),
        envelope: [
          COVERAGE_ENVELOPE.west,
          COVERAGE_ENVELOPE.south,
          COVERAGE_ENVELOPE.east,
          COVERAGE_ENVELOPE.north,
        ],
        centre: [
          (COVERAGE_ENVELOPE.west + COVERAGE_ENVELOPE.east) / 2,
          (COVERAGE_ENVELOPE.south + COVERAGE_ENVELOPE.north) / 2,
        ],
      },
      // Retained deliberately. The web bundle and this stack deploy
      // separately, so between `sam deploy` and the S3 sync there is a window
      // where a browser holding the previous bundle talks to this handler. It
      // reads `pilotArea` and nothing else; dropping the field would blank the
      // map for the length of that window.
      pilotArea: {
        name: describeCoverage(),
        bbox: [
          COVERAGE_ENVELOPE.west,
          COVERAGE_ENVELOPE.south,
          COVERAGE_ENVELOPE.east,
          COVERAGE_ENVELOPE.north,
        ],
        centre: [
          (COVERAGE_ENVELOPE.west + COVERAGE_ENVELOPE.east) / 2,
          (COVERAGE_ENVELOPE.south + COVERAGE_ENVELOPE.north) / 2,
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
