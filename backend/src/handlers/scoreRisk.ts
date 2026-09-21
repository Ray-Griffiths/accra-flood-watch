import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { dispatchAlerts, type VapidKeys } from "../lib/dispatch.ts";
import { documents, requireTable } from "../lib/dynamo.ts";
import { fetchForecasts, nearestForecast, type ForecastPoint } from "../lib/forecast.ts";
import { bounds, cellsCovering, neighbours } from "../lib/geohash.ts";
import { isNewlyDangerous, type RaisedCell } from "../lib/notify.ts";
import { PILOT_BBOX, PREFIX_PRECISION, prefixOfCell } from "../lib/pilot.ts";
import type { DepthLevel } from "../lib/risk.ts";
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  explain,
  reportsComponent,
  scoreCell,
  type ScoringReport,
  type ScoringThresholds,
  type ScoringWeights,
} from "../lib/scoring.ts";

/**
 * Hourly risk recomputation. The job that makes this system live rather than a
 * static terrain map.
 *
 * Reads every cell, combines terrain with the rainfall forecast and the
 * reports standing in and around it, and writes back a score, a level and the
 * sentence that justifies them. User requests only ever read what this
 * produced; no scoring happens on the request path.
 *
 * It is written to finish in a degraded state rather than fail. If the
 * forecast feed is down, cells are rescored from terrain and reports alone and
 * labelled as such. A run that throws leaves the previous hour's numbers on
 * the map presented as current, which is worse than a visibly partial one.
 */

const ssm = new SSMClient({});

interface RiskCellItem {
  cellPrefix: string;
  cell: string;
  susceptibility: number;
  hand: number;
  slope?: number;
  elevation?: number;
  historicalFloodPoint?: string;
  score?: number;
  level?: string;
}

interface ReportItem {
  cell: string;
  depth: DepthLevel;
  submittedAt: string;
  expiresAt: number;
}

interface TuningParameters {
  thresholds: ScoringThresholds;
  weights: ScoringWeights;
}

/**
 * Thresholds live in Parameter Store so they can be tuned during a live demo
 * without a redeployment.
 *
 * Deliberately NOT cached at module scope. Caching it for the life of the
 * execution environment looks like an obvious saving and quietly destroys the
 * only reason the value is in Parameter Store at all: a warm container keeps
 * serving the old thresholds, so a tuning change appears to do nothing until
 * the environment happens to recycle. That was a real bug here, caught by
 * changing the parameter and watching the level distribution not move.
 *
 * One GetParameter per hourly run is a few milliseconds against a run that
 * takes seconds, and it is what makes the tuning real.
 *
 * Any failure falls back to the defaults compiled in: a missing or malformed
 * parameter must not stop the city being scored, and must not be able to
 * invert the model either.
 */
async function loadTuning(): Promise<TuningParameters> {
  const fallback: TuningParameters = {
    thresholds: DEFAULT_THRESHOLDS,
    weights: DEFAULT_WEIGHTS,
  };

  const name = process.env["TUNING_PARAMETER"];
  if (!name) return fallback;

  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name }));
    const raw = result.Parameter?.Value;
    if (!raw) throw new Error("empty parameter");

    const parsed = JSON.parse(raw) as Partial<TuningParameters>;
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(parsed.thresholds ?? {}) };
    const weights = { ...DEFAULT_WEIGHTS, ...(parsed.weights ?? {}) };

    if (
      !Number.isFinite(thresholds.watch) ||
      !Number.isFinite(thresholds.high) ||
      thresholds.watch >= thresholds.high
    ) {
      throw new Error("nonsensical thresholds: " + JSON.stringify(thresholds));
    }

    return { thresholds, weights };
  } catch (error) {
    console.error("Falling back to built-in tuning", error);
    return fallback;
  }
}

/**
 * VAPID keys for signing push messages.
 *
 * The private half is a SecureString, which CloudFormation cannot create, so
 * both parameters are provisioned out of band and the template only grants
 * access to them by name. A stack that has never had them provisioned scores
 * normally and sends nothing, which is the right failure: the map staying
 * current matters more than the alerts, and a scoring run that threw because
 * a notification key was missing would leave last hour's numbers on screen
 * looking current.
 */
async function loadVapidKeys(): Promise<VapidKeys | null> {
  const publicName = process.env["VAPID_PUBLIC_PARAMETER"];
  const privateName = process.env["VAPID_PRIVATE_PARAMETER"];
  if (!publicName || !privateName) return null;

  try {
    const [publicResult, privateResult] = await Promise.all([
      ssm.send(new GetParameterCommand({ Name: publicName })),
      ssm.send(new GetParameterCommand({ Name: privateName, WithDecryption: true })),
    ]);

    const publicKey = publicResult.Parameter?.Value;
    const privateKey = privateResult.Parameter?.Value;
    if (!publicKey || !privateKey) return null;

    return {
      publicKey,
      privateKey,
      subject: process.env["VAPID_SUBJECT"] ?? "mailto:accrafloodwatch@example.com",
    };
  } catch (error) {
    console.error("Could not load VAPID keys; alerts will not be sent", error);
    return null;
  }
}

/** Every partition key in the pilot area. Bounded and known, so never a scan. */
function pilotPrefixes(): string[] {
  return cellsCovering(PILOT_BBOX, PREFIX_PRECISION);
}

async function loadAllCells(table: string, prefixes: string[]): Promise<RiskCellItem[]> {
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
  return results.flatMap((result) => (result.Items ?? []) as RiskCellItem[]);
}

/**
 * Active reports indexed by the cell they were made in.
 *
 * Expired reports are filtered out explicitly: DynamoDB deletes on TTL within
 * 48 hours of expiry rather than at the instant of it, so a lapsed report can
 * still be sitting in the table and must not influence a score.
 */
async function loadReportsByCell(
  table: string,
  prefixes: string[],
  now: Date,
): Promise<Map<string, ReportItem[]>> {
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

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const byCell = new Map<string, ReportItem[]>();

  for (const item of results.flatMap((r) => (r.Items ?? []) as ReportItem[])) {
    if (typeof item.expiresAt === "number" && item.expiresAt <= nowSeconds) continue;
    const existing = byCell.get(item.cell);
    if (existing) existing.push(item);
    else byCell.set(item.cell, [item]);
  }

  return byCell;
}

/** Reports in a cell and its eight neighbours, tagged with which is which. */
function reportsAround(cell: string, byCell: Map<string, ReportItem[]>): ScoringReport[] {
  const collected: ScoringReport[] = [];

  for (const item of byCell.get(cell) ?? []) {
    collected.push({ cell, depth: item.depth, submittedAt: item.submittedAt, sameCell: true });
  }

  for (const neighbour of neighbours(cell)) {
    for (const item of byCell.get(neighbour) ?? []) {
      collected.push({
        cell: neighbour,
        depth: item.depth,
        submittedAt: item.submittedAt,
        sameCell: false,
      });
    }
  }

  return collected;
}

async function writeInBatches(table: string, items: Record<string, unknown>[]): Promise<number> {
  let written = 0;

  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let pending = chunk.map((Item) => ({ PutRequest: { Item } }));

    // BatchWriteItem can decline part of a batch under throttling. Retrying
    // only what came back is the documented contract, not an optimisation.
    for (let attempt = 0; attempt < 4 && pending.length > 0; attempt += 1) {
      const result = await documents.send(
        new BatchWriteCommand({ RequestItems: { [table]: pending } }),
      );

      const returned = (result.UnprocessedItems?.[table] ?? []) as typeof pending;
      written += pending.length - returned.length;
      pending = returned;

      if (pending.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }

    if (pending.length > 0) {
      console.error("Gave up on " + pending.length + " cells after retries");
    }
  }

  return written;
}

/**
 * Metrics in embedded format, so a silent failure of the forecast feed is
 * visible in CloudWatch rather than invisible.
 *
 * ForecastAvailable is the one that matters: the system keeps working without
 * a forecast, which is precisely why its absence has to be loud.
 */
function emitMetrics(metrics: Record<string, number>): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "AccraFloodWatch",
            Dimensions: [["Environment"]],
            Metrics: Object.keys(metrics).map((Name) => ({ Name })),
          },
        ],
      },
      Environment: process.env["ENVIRONMENT"] ?? "unknown",
      ...metrics,
    }),
  );
}

export const handler = async (): Promise<{
  scored: number;
  forecastAvailable: boolean;
  alertsSent: number;
}> => {
  const startedAt = Date.now();
  const now = new Date();

  const riskTable = requireTable("RISK_CELLS_TABLE");
  const reportsTable = requireTable("REPORTS_TABLE");
  const prefixes = pilotPrefixes();

  const [tuning, forecasts, cells, reportsByCell] = await Promise.all([
    loadTuning(),
    fetchForecasts(now),
    loadAllCells(riskTable, prefixes),
    loadReportsByCell(reportsTable, prefixes, now),
  ]);

  const forecastPoints: ForecastPoint[] = forecasts ?? [];
  const forecastAvailable = forecastPoints.length > 0;
  const updatedAt = now.toISOString();

  let confirmedCells = 0;
  const raised: RaisedCell[] = [];
  const levelCounts: Record<string, number> = { low: 0, watch: 0, high: 0, confirmed: 0 };

  const items = cells.map((cell) => {
    const box = bounds(cell.cell);
    const centreLat = (box.south + box.north) / 2;
    const centreLon = (box.west + box.east) / 2;

    const forecast = forecastAvailable
      ? nearestForecast(forecastPoints, centreLat, centreLon)
      : null;

    const reports = reportsComponent(reportsAround(cell.cell, reportsByCell), now);

    const scored = scoreCell({
      susceptibility: cell.susceptibility,
      forecast,
      reports,
      thresholds: tuning.thresholds,
      weights: tuning.weights,
    });

    const explanation = explain({
      scored,
      hand: cell.hand,
      forecast,
      reports,
      historicalFloodPoint: cell.historicalFloodPoint,
    });

    levelCounts[scored.level] = (levelCounts[scored.level] ?? 0) + 1;
    if (scored.confirmed) confirmedCells += 1;

    // A cell that has newly crossed into danger is what a watcher needs to be
    // told about. Collected here and dispatched after the writes: the map
    // being correct comes before anybody being notified about it.
    if (isNewlyDangerous(cell.level, scored.level)) {
      raised.push({ cell: cell.cell, level: scored.level, explanation });
    }

    return {
      ...cell,
      cellPrefix: cell.cellPrefix ?? prefixOfCell(cell.cell),
      score: scored.score,
      level: scored.level,
      basis: scored.basis,
      explanation,
      rainfall6h: forecast?.next6hMm ?? null,
      rainfall24h: forecast?.next24hMm ?? null,
      reportScore: reports.score,
      updatedAt,
    } as Record<string, unknown>;
  });

  const written = await writeInBatches(riskTable, items);

  // The health endpoint reads this. A "#meta" partition can never collide with
  // a geohash prefix, so it stays invisible to every viewport query.
  await writeInBatches(riskTable, [
    {
      cellPrefix: "#meta",
      cell: "lastScoringRun",
      ranAt: updatedAt,
      cellsScored: written,
      forecastAvailable,
      durationMs: Date.now() - startedAt,
    },
  ]);

  const activeReports = [...reportsByCell.values()].reduce((n, list) => n + list.length, 0);

  // Alerts go out only after the map is correct. If dispatch is slow or the
  // push services are down, the numbers people are looking at are already
  // written; nothing here can throw, by construction.
  const watchersTable = process.env["WATCHERS_TABLE"];
  const dispatched = watchersTable
    ? await dispatchAlerts(raised, watchersTable, await loadVapidKeys())
    : { sent: 0, pruned: 0, failed: 0, capped: false };

  emitMetrics({
    CellsScored: written,
    ForecastAvailable: forecastAvailable ? 1 : 0,
    ForecastPoints: forecastPoints.length,
    CellsHigh: levelCounts["high"] ?? 0,
    CellsConfirmed: confirmedCells,
    CellsRaisedToHigh: raised.length,
    AlertsSent: dispatched.sent,
    AlertsFailed: dispatched.failed,
    SubscriptionsPruned: dispatched.pruned,
    ActiveReports: activeReports,
    DurationMs: Date.now() - startedAt,
  });

  console.log(
    "Scored " + written + "/" + cells.length + " cells in " + (Date.now() - startedAt) + "ms. " +
      "Forecast " + (forecastAvailable ? "available" : "UNAVAILABLE") + ". " +
      "Levels: " + JSON.stringify(levelCounts) + ". Raised to high: " + raised.length + ". " +
      "Alerts sent " + dispatched.sent + ", failed " + dispatched.failed +
      ", pruned " + dispatched.pruned + (dispatched.capped ? " (CAPPED)" : "") + ".",
  );

  return { scored: written, forecastAvailable, alertsSent: dispatched.sent };
};
