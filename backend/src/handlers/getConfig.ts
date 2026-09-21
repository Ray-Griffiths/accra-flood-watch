import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DescribeKeyCommand, LocationClient } from "@aws-sdk/client-location";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { json } from "../lib/http.ts";
import { PILOT_BBOX, CELL_PRECISION } from "../lib/pilot.ts";

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
