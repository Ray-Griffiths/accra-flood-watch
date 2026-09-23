import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { decideCadence } from "../lib/cadence.ts";
import { dispatchAlerts } from "../lib/dispatch.ts";
import { documents, queryAll, requireTable } from "../lib/dynamo.ts";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { fetchForecasts, nearestForecast, type ForecastPoint } from "../lib/forecast.ts";
import { bounds, neighbours } from "../lib/geohash.ts";
import { emitMetrics } from "../lib/metrics.ts";
import { isNewlyDangerous, type RaisedCell } from "../lib/notify.ts";
import { coveragePrefixes, prefixOfCell } from "../lib/pilot.ts";
import { isClearedByReports, type DepthLevel, type ReportCondition } from "../lib/risk.ts";
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  explain,
  rainOutlook,
  reportsComponent,
  scoreCell,
  type RainOutlook,
  type ScoringReport,
  type ScoringThresholds,
  type ScoringWeights,
} from "../lib/scoring.ts";
import { loadVapidKeys } from "../lib/vapid.ts";

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
  basis?: string;
  explanation?: string;
  rainfall6h?: number | null;
  rainfall24h?: number | null;
  reportScore?: number;
  scoreLater?: number | null;
  levelLater?: string | null;
}

/** Shared empty assessment: the later view is forecast-only, by design. */
const EMPTY_REPORTS = {
  score: 0,
  confirmingCount: 0,
  contributingCount: 0,
  strongestDepth: null,
} as const;

/**
 * The fields that constitute this cell's answer.
 *
 * Everything a reader of the map sees, and nothing else. `updatedAt` is not
 * here on purpose -- see the call site.
 */
const ANSWER_FIELDS = [
  "score",
  "level",
  "basis",
  "explanation",
  "rainfall6h",
  "rainfall24h",
  "reportScore",
  "scoreLater",
  "levelLater",
] as const;

function hasChanged(
  next: Record<string, unknown>,
  before: RiskCellItem | undefined,
): boolean {
  // A cell the job has never scored must always be written.
  if (!before) return true;

  const was = before as unknown as Record<string, unknown>;
  return ANSWER_FIELDS.some((field) => (next[field] ?? null) !== (was[field] ?? null));
}

interface ReportItem {
  cell: string;
  condition?: ReportCondition;
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

interface ScoringMeta {
  ranAt?: string;
  rainOutlook?: RainOutlook | null;
}

/**
 * What the previous run saw, so this one can decide whether to bother.
 *
 * Any failure reads as "no previous run", which makes the cadence decision
 * fall through to rescoring. Being unable to read the meta row must never be
 * the reason the city stops being scored.
 */
async function loadLastRun(table: string): Promise<ScoringMeta | null> {
  try {
    const result = await documents.send(
      new GetCommand({ TableName: table, Key: { cellPrefix: "#meta", cell: "lastScoringRun" } }),
    );
    return (result.Item as ScoringMeta | undefined) ?? null;
  } catch (error) {
    console.error("Could not read the last scoring run; assuming none", error);
    return null;
  }
}

async function loadAllCells(table: string, prefixes: string[]): Promise<RiskCellItem[]> {
  const results = await Promise.all(
    prefixes.map((prefix) =>
      queryAll<RiskCellItem>(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "cellPrefix = :prefix",
          ExpressionAttributeValues: { ":prefix": prefix },
        }),
      ),
    ),
  );
  return results.flat();
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
      queryAll<ReportItem>(
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

  for (const item of results.flat()) {
    if (typeof item.expiresAt === "number" && item.expiresAt <= nowSeconds) continue;
    const existing = byCell.get(item.cell);
    if (existing) existing.push(item);
    else byCell.set(item.cell, [item]);
  }

  return byCell;
}

/**
 * Reports in a cell and its eight neighbours, tagged with which is which.
 *
 * Clearing is resolved per cell before anything is collected. A cell whose
 * residents have withdrawn their reports of water contributes nothing -- not
 * to itself and not to its neighbours -- so the terrain and the forecast
 * decide it alone. Nothing here can push a cell BELOW that floor, because
 * clearing only ever removes evidence; it never adds a claim of safety.
 */
function reportsAround(cell: string, byCell: Map<string, ReportItem[]>, now: Date): ScoringReport[] {
  const collected: ScoringReport[] = [];

  const own = byCell.get(cell) ?? [];
  if (!isClearedByReports(own, now)) {
    for (const item of own) {
      if ((item.condition ?? "flooded") !== "flooded") continue;
      collected.push({ cell, depth: item.depth, submittedAt: item.submittedAt, sameCell: true });
    }
  }

  for (const neighbour of neighbours(cell)) {
    const nearby = byCell.get(neighbour) ?? [];
    if (isClearedByReports(nearby, now)) continue;

    for (const item of nearby) {
      if ((item.condition ?? "flooded") !== "flooded") continue;
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

export const handler = async (): Promise<{
  scored: number;
  forecastAvailable: boolean;
  alertsSent: number;
  /** True when this tick decided there was nothing worth recomputing. */
  skipped?: boolean;
}> => {
  const startedAt = Date.now();
  const now = new Date();

  const riskTable = requireTable("RISK_CELLS_TABLE");
  const reportsTable = requireTable("REPORTS_TABLE");
  const prefixes = coveragePrefixes();

  // The schedule ticks every fifteen minutes; most of those ticks should do
  // nothing. Deciding here rather than in the schedule is what lets the
  // cadence follow the weather instead of the clock.
  const lastRun = await loadLastRun(riskTable);
  const cadence = decideCadence({
    now,
    lastRanAt: lastRun?.ranAt ?? null,
    lastOutlook: lastRun?.rainOutlook ?? null,
  });

  if (!cadence.rescore) {
    // Deliberately does NOT emit ScoringRuns: that metric is what the stalled
    // alarm watches, and a skipped tick is not a run. A full run happens at
    // least hourly, so the alarm still sees one every hour.
    emitMetrics({ ScoringSkipped: 1 });
    console.log(`Skipped rescore: ${cadence.reason}.`);
    return { scored: 0, forecastAvailable: false, alertsSent: 0, skipped: true };
  }

  console.log(`Rescoring: ${cadence.reason}.`);

  const [tuning, forecasts, cells, reportsByCell] = await Promise.all([
    loadTuning(),
    fetchForecasts(now),
    loadAllCells(riskTable, prefixes),
    loadReportsByCell(reportsTable, prefixes, now),
  ]);

  const forecastPoints: ForecastPoint[] = forecasts ?? [];
  const forecastAvailable = forecastPoints.length > 0;
  const updatedAt = now.toISOString();

  // What each cell said before this run, for the changed-only write below.
  const previous = new Map<string, RiskCellItem>(cells.map((cell) => [cell.cell, cell]));

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

    const reports = reportsComponent(reportsAround(cell.cell, reportsByCell, now), now);

    const scored = scoreCell({
      susceptibility: cell.susceptibility,
      forecast,
      reports,
      thresholds: tuning.thresholds,
      weights: tuning.weights,
    });

    // The same cell, scored against the rest of the day instead of the next
    // six hours. This answers a question the live view cannot: "should I go
    // now, or wait?" -- which during a storm is the decision people are
    // actually making. The 24h total is carried into BOTH slots because the
    // acute reading is what the `now` view already covers; using it again
    // here would just reproduce that answer.
    //
    // Reports are deliberately excluded. Somebody standing in water tells you
    // about now, not about this evening, and letting a current observation
    // colour a forecast view would blur the one distinction that makes the
    // two views worth having.
    const laterForecast = forecast
      ? { next6hMm: forecast.next24hMm, next24hMm: forecast.next24hMm }
      : null;
    const later = scoreCell({
      susceptibility: cell.susceptibility,
      forecast: laterForecast,
      reports: EMPTY_REPORTS,
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
      // Null when the feed was down, so the client can say "no forecast"
      // rather than showing an empty later-today map that reads as calm.
      scoreLater: forecast ? later.score : null,
      levelLater: forecast ? later.level : null,
      updatedAt,
    } as Record<string, unknown>;
  });

  // Only the cells whose answer actually moved.
  //
  // The job rescores all ~5,100 cells every hour, but on a dry day almost none
  // of them change: the terrain is constant, the forecast rounds to the same
  // numbers, and nobody has reported anything. Writing them all back was
  // roughly 3.5 million writes a month against a pilot budget of $10-20, to
  // store values identical to the ones already there.
  //
  // `updatedAt` is deliberately excluded from the comparison. Including it
  // would make every item differ from its predecessor by construction and
  // defeat the whole check -- and a cell whose risk has not changed has not
  // been updated in any sense a reader cares about. `lastScoringRun` in the
  // meta row is what proves the job ran.
  const changed = items.filter((item) => hasChanged(item, previous.get(String(item["cell"]))));
  const written = await writeInBatches(riskTable, changed);
  const unchanged = items.length - changed.length;

  // The wettest point anywhere in coverage decides the cadence. An area is
  // only calm when all of it is: slowing down over a catchment with a storm
  // in one corner is how the corner gets missed.
  const wettestOutlook: RainOutlook | null = forecastAvailable
    ? rainOutlook({
        next6hMm: Math.max(...forecastPoints.map((p) => p.forecast.next6hMm), 0),
        next24hMm: Math.max(...forecastPoints.map((p) => p.forecast.next24hMm), 0),
      })
    : null;

  // The health endpoint reads this. A "#meta" partition can never collide with
  // a geohash prefix, so it stays invisible to every viewport query.
  await writeInBatches(riskTable, [
    {
      cellPrefix: "#meta",
      cell: "lastScoringRun",
      ranAt: updatedAt,
      cellsScored: written,
      forecastAvailable,
      // Read by the next tick to decide whether to rescore. Null when the
      // feed was down, which the cadence rule treats as wet rather than dry.
      rainOutlook: wettestOutlook,
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
    // Proof the run happened, independent of whether it had anything to write.
    // The stalled alarm watches THIS: now that unchanged cells are skipped, a
    // quiet dry day legitimately writes zero cells, and an alarm on the write
    // count would page somebody because nothing was wrong.
    ScoringRuns: 1,
    CellsScored: written,
    CellsUnchanged: unchanged,
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
    "Scored " + cells.length + " cells in " + (Date.now() - startedAt) + "ms, " +
      "wrote " + written + " changed, skipped " + unchanged + " unchanged. " +
      "Forecast " + (forecastAvailable ? "available" : "UNAVAILABLE") + ". " +
      "Levels: " + JSON.stringify(levelCounts) + ". Raised to high: " + raised.length + ". " +
      "Alerts sent " + dispatched.sent + ", failed " + dispatched.failed +
      ", pruned " + dispatched.pruned + (dispatched.capped ? " (CAPPED)" : "") + ".",
  );

  return { scored: written, forecastAvailable, alertsSent: dispatched.sent };
};
