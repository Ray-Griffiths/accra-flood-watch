import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

import { documents } from "../lib/dynamo.ts";
import { json } from "../lib/http.ts";

/**
 * Liveness probe. Targeted by an external uptime check for the duration of the
 * judging window, so it stays fast and cheap: one GetItem by primary key.
 *
 * `lastScoringRun` is the point of it. A stale timestamp here is the earliest
 * visible sign that the hourly job or the forecast feed has stopped working,
 * and it is visible without opening the console. The endpoint still answers
 * 200 when scoring is stale: the service IS up, and conflating "degraded" with
 * "down" would page somebody for the wrong thing.
 */

interface ScoringMeta {
  ranAt?: string;
  cellsScored?: number;
  forecastAvailable?: boolean;
}

/** Scoring runs hourly; beyond this it has missed at least two turns. */
const STALE_AFTER_MINUTES = 150;

export const handler: APIGatewayProxyHandlerV2 = async () => {
  let scoring: ScoringMeta | null = null;

  const table = process.env["RISK_CELLS_TABLE"];
  if (table) {
    try {
      const result = await documents.send(
        new GetCommand({
          TableName: table,
          Key: { cellPrefix: "#meta", cell: "lastScoringRun" },
        }),
      );
      scoring = (result.Item as ScoringMeta | undefined) ?? null;
    } catch (error) {
      // The probe must answer even when DynamoDB does not. Reporting the
      // scoring state as unknown is more useful than a 500 on the one endpoint
      // that exists to tell you whether the service is alive.
      console.error("Could not read scoring metadata", error);
    }
  }

  const ranAt = scoring?.ranAt ?? null;
  const ageMinutes =
    ranAt === null ? null : Math.round((Date.now() - Date.parse(ranAt)) / 60_000);

  return json(200, {
    status: "ok",
    service: "accra-flood-watch",
    environment: process.env["ENVIRONMENT"] ?? "unknown",
    region: process.env["AWS_REGION"] ?? "unknown",
    lastScoringRun: ranAt,
    scoring:
      ranAt === null
        ? { state: "never-run" }
        : {
            state:
              ageMinutes !== null && ageMinutes > STALE_AFTER_MINUTES ? "stale" : "current",
            ageMinutes,
            cellsScored: scoring?.cellsScored ?? null,
            forecastAvailable: scoring?.forecastAvailable ?? null,
          },
    time: new Date().toISOString(),
  });
};
