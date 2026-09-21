import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  RAIN_REFERENCE_24H_MM,
  RAIN_REFERENCE_6H_MM,
  REPORT_HALF_LIFE_MINUTES,
  explain,
  levelFor,
  rainfallComponent,
  reportsComponent,
  scoreCell,
  type ScoringReport,
} from "./scoring.ts";

const NOW = new Date("2026-09-21T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function report(over: Partial<ScoringReport> = {}): ScoringReport {
  return {
    cell: "ebzzdyp",
    depth: "knee",
    submittedAt: minutesAgo(10),
    sameCell: true,
    ...over,
  };
}

const NO_REPORTS = reportsComponent([], NOW);

describe("rainfall component", () => {
  it("is zero for no rain", () => {
    assert.equal(rainfallComponent({ next6hMm: 0, next24hMm: 0 }), 0);
  });

  it("reaches 100 at the reference total", () => {
    const score = rainfallComponent({
      next6hMm: RAIN_REFERENCE_6H_MM,
      next24hMm: 0,
    });
    assert.equal(Math.round(score), 100);
  });

  it("saturates rather than exceeding 100", () => {
    const score = rainfallComponent({
      next6hMm: RAIN_REFERENCE_6H_MM * 4,
      next24hMm: RAIN_REFERENCE_24H_MM * 4,
    });
    assert.equal(score, 100);
  });

  // The requirement from section 10.2, stated as a test: 60mm in six hours is
  // "far more than twice as dangerous" as 30mm.
  it("scales non-linearly, so doubling the rain more than doubles the score", () => {
    const half = rainfallComponent({ next6hMm: 30, next24hMm: 0 });
    const full = rainfallComponent({ next6hMm: 60, next24hMm: 0 });
    assert.ok(full > half * 2, `expected ${full} > ${half * 2}`);
  });

  it("takes the worse of the acute and sustained readings", () => {
    // A dry six hours but a soaking day must not be diluted to nothing.
    const sustained = rainfallComponent({ next6hMm: 0, next24hMm: 120 });
    assert.equal(Math.round(sustained), 100);
  });
});

describe("reports component", () => {
  it("is zero with no reports", () => {
    assert.equal(NO_REPORTS.score, 0);
    assert.equal(NO_REPORTS.strongestDepth, null);
  });

  it("ignores reports older than the window", () => {
    const assessment = reportsComponent([report({ submittedAt: minutesAgo(400) })], NOW);
    assert.equal(assessment.score, 0);
    assert.equal(assessment.contributingCount, 0);
  });

  it("decays with age", () => {
    const fresh = reportsComponent([report({ submittedAt: minutesAgo(0) })], NOW);
    const old = reportsComponent(
      [report({ submittedAt: minutesAgo(REPORT_HALF_LIFE_MINUTES) })],
      NOW,
    );
    assert.ok(old.score < fresh.score);
    // One half-life should be within rounding of half the severity.
    assert.ok(Math.abs(old.score - fresh.score / 2) < 1);
  });

  it("discounts reports from neighbouring cells", () => {
    const here = reportsComponent([report({ sameCell: true })], NOW);
    const nextDoor = reportsComponent([report({ sameCell: false })], NOW);
    assert.ok(nextDoor.score < here.score);
  });

  it("does not let many shallow reports outrank one deep one", () => {
    const shallow = reportsComponent(
      [report({ depth: "ankle" }), report({ depth: "ankle" }), report({ depth: "ankle" })],
      NOW,
    );
    const deep = reportsComponent([report({ depth: "impassable" })], NOW);
    assert.ok(deep.score > shallow.score, `${deep.score} should exceed ${shallow.score}`);
  });

  it("counts confirming reports only in the cell itself", () => {
    const assessment = reportsComponent(
      [report({ depth: "knee", sameCell: true }), report({ depth: "waist", sameCell: false })],
      NOW,
    );
    assert.equal(assessment.confirmingCount, 1);
  });

  it("does not count ankle-deep reports toward confirmation", () => {
    const assessment = reportsComponent(
      [report({ depth: "ankle" }), report({ depth: "ankle" })],
      NOW,
    );
    assert.equal(assessment.confirmingCount, 0);
  });

  it("does not confirm on reports older than the confirmation window", () => {
    const assessment = reportsComponent(
      [report({ submittedAt: minutesAgo(200) }), report({ submittedAt: minutesAgo(220) })],
      NOW,
    );
    assert.equal(assessment.confirmingCount, 0);
  });
});

describe("level thresholds", () => {
  // Boundary cases at each threshold, exactly as the working agreements require.
  it("treats the watch threshold as inclusive", () => {
    assert.equal(levelFor(DEFAULT_THRESHOLDS.watch, DEFAULT_THRESHOLDS), "watch");
    assert.equal(levelFor(DEFAULT_THRESHOLDS.watch - 0.1, DEFAULT_THRESHOLDS), "low");
  });

  it("treats the high threshold as inclusive", () => {
    assert.equal(levelFor(DEFAULT_THRESHOLDS.high, DEFAULT_THRESHOLDS), "high");
    assert.equal(levelFor(DEFAULT_THRESHOLDS.high - 0.1, DEFAULT_THRESHOLDS), "watch");
  });

  it("covers the extremes", () => {
    assert.equal(levelFor(0, DEFAULT_THRESHOLDS), "low");
    assert.equal(levelFor(100, DEFAULT_THRESHOLDS), "high");
  });

  it("honours tuned thresholds from configuration", () => {
    const tuned = { watch: 30, high: 50 };
    assert.equal(levelFor(35, tuned), "watch");
    assert.equal(levelFor(35, DEFAULT_THRESHOLDS), "low");
  });
});

describe("scoreCell", () => {
  it("weights the three components as the plan specifies", () => {
    const scored = scoreCell({
      susceptibility: 100,
      forecast: { next6hMm: RAIN_REFERENCE_6H_MM, next24hMm: 0 },
      reports: reportsComponent([report({ depth: "impassable", submittedAt: minutesAgo(0) })], NOW),
    });
    // All three components at 100 must produce 100, not something else.
    assert.equal(scored.score, 100);
    assert.equal(scored.components.rainfall, 100);
  });

  it("produces the weighted average of the components that have data", () => {
    const scored = scoreCell({
      susceptibility: 50,
      forecast: { next6hMm: 0, next24hMm: 0 },
      reports: NO_REPORTS,
    });
    // No reports, so their weight is redistributed:
    // (0.4*50 + 0.4*0) / 0.8 = 25
    assert.equal(scored.score, 25);
  });

  it("redistributes the forecast weight rather than counting it as zero rain", () => {
    const withoutForecast = scoreCell({
      susceptibility: 90,
      forecast: null,
      reports: NO_REPORTS,
    });
    const asIfDry = scoreCell({
      susceptibility: 90,
      forecast: { next6hMm: 0, next24hMm: 0 },
      reports: NO_REPORTS,
    });

    // A broken feed must not quietly mark a dangerous cell safe.
    assert.ok(withoutForecast.score > asIfDry.score);
    // Nothing but terrain is known, so the score IS the terrain susceptibility.
    assert.equal(withoutForecast.score, 90);
    assert.equal(withoutForecast.basis, "terrain-only");
  });

  it("does not penalise a cell simply because nobody has reported there", () => {
    // Silence is not evidence of safety. A cell with bad terrain and heavy
    // rain must reach `high` on those two alone.
    const quiet = scoreCell({
      susceptibility: 85,
      forecast: { next6hMm: 55, next24hMm: 70 },
      reports: NO_REPORTS,
    });
    assert.equal(quiet.level, "high");
    assert.ok(quiet.score >= DEFAULT_THRESHOLDS.high, `${quiet.score} should reach high`);
  });

  it("reports terrain-and-reports when reports exist but the forecast does not", () => {
    const scored = scoreCell({
      susceptibility: 50,
      forecast: null,
      reports: reportsComponent([report()], NOW),
    });
    assert.equal(scored.basis, "terrain-and-reports");
  });

  it("never exceeds 100 or falls below 0", () => {
    const high = scoreCell({
      susceptibility: 100,
      forecast: { next6hMm: 500, next24hMm: 500 },
      reports: reportsComponent(
        [report({ depth: "impassable" }), report({ depth: "impassable" })],
        NOW,
      ),
    });
    assert.ok(high.score <= 100);

    const low = scoreCell({ susceptibility: 0, forecast: null, reports: NO_REPORTS });
    assert.equal(low.score, 0);
  });

  it("confirms flooding on two reports regardless of a low score", () => {
    const scored = scoreCell({
      // Terrain says this is the safest cell in the city and no rain is coming.
      susceptibility: 0,
      forecast: { next6hMm: 0, next24hMm: 0 },
      reports: reportsComponent(
        [report({ depth: "knee" }), report({ depth: "waist" })],
        NOW,
      ),
    });
    assert.equal(scored.confirmed, true);
    assert.equal(scored.level, "confirmed");
  });

  it("does not confirm on a single report", () => {
    const scored = scoreCell({
      susceptibility: 90,
      forecast: { next6hMm: 60, next24hMm: 60 },
      reports: reportsComponent([report({ depth: "impassable" })], NOW),
    });
    assert.equal(scored.confirmed, false);
    assert.notEqual(scored.level, "confirmed");
  });

  it("uses the configured weights", () => {
    const scored = scoreCell({
      susceptibility: 100,
      forecast: { next6hMm: 0, next24hMm: 0 },
      reports: NO_REPORTS,
      weights: { ...DEFAULT_WEIGHTS, susceptibility: 1, rainfall: 0, reports: 0 },
    });
    assert.equal(scored.score, 100);
  });
});

describe("explanation", () => {
  it("leads with the reports when flooding is confirmed", () => {
    const reports = reportsComponent(
      [report({ depth: "waist" }), report({ depth: "knee" })],
      NOW,
    );
    const scored = scoreCell({ susceptibility: 10, forecast: null, reports });
    const sentence = explain({ scored, hand: 5, forecast: null, reports });

    assert.match(sentence, /reporting water waist deep right now/);
    assert.match(sentence, /Avoid this area/);
    // The terrain reading must not soften a confirmed report.
    assert.doesNotMatch(sentence, /above the nearest drain/);
  });

  it("says plainly when there is no forecast", () => {
    const scored = scoreCell({ susceptibility: 80, forecast: null, reports: NO_REPORTS });
    const sentence = explain({ scored, hand: 0.4, forecast: null, reports: NO_REPORTS });

    assert.match(sentence, /barely above the nearest drain/);
    assert.match(sentence, /No rainfall forecast available/);
  });

  it("states the rain with a consequence, not a bare number", () => {
    const forecast = { next6hMm: 55, next24hMm: 70 };
    const scored = scoreCell({ susceptibility: 85, forecast, reports: NO_REPORTS });
    const sentence = explain({ scored, hand: 0.2, forecast, reports: NO_REPORTS });

    assert.match(sentence, /55mm of rain is forecast in the next six hours/);
    assert.match(sentence, /enough to flood this spot/);
  });

  it("reassures when little rain is expected", () => {
    const forecast = { next6hMm: 0, next24hMm: 0 };
    const scored = scoreCell({ susceptibility: 20, forecast, reports: NO_REPORTS });
    const sentence = explain({ scored, hand: 8, forecast, reports: NO_REPORTS });

    assert.match(sentence, /flooding is unlikely today/);
  });

  it("mentions a nearby report without confirming", () => {
    const reports = reportsComponent([report({ depth: "knee", sameCell: false })], NOW);
    const forecast = { next6hMm: 5, next24hMm: 10 };
    const scored = scoreCell({ susceptibility: 60, forecast, reports });
    const sentence = explain({ scored, hand: 1.5, forecast, reports });

    assert.match(sentence, /One person has reported water knee deep nearby/);
  });

  it("names a historical flood point when one applies", () => {
    const scored = scoreCell({ susceptibility: 80, forecast: null, reports: NO_REPORTS });
    const sentence = explain({
      scored,
      hand: 0.5,
      forecast: null,
      reports: NO_REPORTS,
      historicalFloodPoint: "Kwame Nkrumah Circle",
    });
    assert.match(sentence, /flooding has been recorded at Kwame Nkrumah Circle/);
  });

  it("always produces a sentence, whatever the inputs", () => {
    const scored = scoreCell({ susceptibility: 0, forecast: null, reports: NO_REPORTS });
    const sentence = explain({ scored, hand: 0, forecast: null, reports: NO_REPORTS });
    assert.ok(sentence.length > 20);
    assert.match(sentence, /\.$/);
  });
});
