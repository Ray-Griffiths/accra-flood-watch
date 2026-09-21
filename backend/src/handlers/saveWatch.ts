import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { documents, requireTable } from "../lib/dynamo.ts";
import { json, problem } from "../lib/http.ts";
import { cellFor, isInsidePilotArea } from "../lib/pilot.ts";
import { parseSubscription, subscriptionId, type PushSubscription } from "../lib/subscription.ts";

/**
 * Watch a place, or stop watching it.
 *
 * Registers the browser's push subscription against the grid cell the
 * coordinates fall in. Keyed by cell rather than by user, so that when the
 * scoring job raises a cell to `high` it can find everyone who needs telling
 * with a single query. Keying by user would force a scan at precisely the
 * moment the system is busiest.
 *
 * Nothing here identifies a person. A row is a cell, an opaque hash of the
 * push endpoint, the endpoint itself so that something can be sent, and the
 * two keys the push protocol requires. No name, no account, no device id, and
 * nothing linking two watched places to the same browser.
 *
 * Rows carry a TTL: a subscription nobody has refreshed in ninety days is a
 * browser that is not coming back, and it deletes itself rather than being
 * pushed to forever.
 */

/** Ninety days. Re-registered on every visit, so an active user never lapses. */
const WATCH_TTL_SECONDS = 90 * 24 * 60 * 60;

interface WatchRequest {
  action: "watch" | "unwatch";
  latitude: number;
  longitude: number;
  subscription: PushSubscription;
}

function parseRequest(body: string | undefined): WatchRequest | string {
  if (!body) return "A request body is required.";

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "The request body must be JSON.";
  }

  const raw = parsed as {
    action?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    subscription?: unknown;
  };

  const action = raw.action ?? "watch";
  if (action !== "watch" && action !== "unwatch") {
    return "action must be watch or unwatch.";
  }

  if (typeof raw.latitude !== "number" || typeof raw.longitude !== "number") {
    return "latitude and longitude are required.";
  }
  if (!Number.isFinite(raw.latitude) || !Number.isFinite(raw.longitude)) {
    return "latitude and longitude must be numbers.";
  }
  if (!isInsidePilotArea(raw.latitude, raw.longitude)) {
    return "That place is outside the Circle, Kaneshie and Avenor pilot area.";
  }

  const subscription = parseSubscription(raw.subscription);
  if (typeof subscription === "string") return subscription;

  return { action, latitude: raw.latitude, longitude: raw.longitude, subscription };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const parsed = parseRequest(event.body);
  if (typeof parsed === "string") return problem(400, parsed);

  const table = requireTable("WATCHERS_TABLE");
  const cell = cellFor(parsed.latitude, parsed.longitude);
  const id = subscriptionId(parsed.subscription.endpoint);

  if (parsed.action === "unwatch") {
    await documents.send(
      new DeleteCommand({ TableName: table, Key: { cell, subscriptionId: id } }),
    );
    return json(200, {
      watching: false,
      cell,
      message: "You will no longer be alerted about this place.",
    });
  }

  await documents.send(
    new PutCommand({
      TableName: table,
      Item: {
        cell,
        subscriptionId: id,
        endpoint: parsed.subscription.endpoint,
        p256dh: parsed.subscription.keys.p256dh,
        auth: parsed.subscription.keys.auth,
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + WATCH_TTL_SECONDS,
      },
    }),
  );

  return json(200, {
    watching: true,
    cell,
    message:
      "You will get one alert when flooding becomes likely here, and one if people start reporting water.",
  });
};
