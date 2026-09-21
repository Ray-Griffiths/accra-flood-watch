import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { json } from "../lib/http.ts";

/**
 * Liveness probe. Targeted by an external uptime check for the duration of the
 * judging window, so it must stay dependency-free and fast.
 *
 * `lastScoringRun` is null until the hourly scoring job exists. Once it does,
 * a stale value here is the earliest visible sign that the forecast feed has
 * silently stopped working.
 */
export const handler: APIGatewayProxyHandlerV2 = async () => {
  return json(200, {
    status: "ok",
    service: "accra-flood-watch",
    environment: process.env.ENVIRONMENT ?? "unknown",
    region: process.env.AWS_REGION ?? "unknown",
    lastScoringRun: null,
    time: new Date().toISOString(),
  });
};
