/**
 * "The water has gone."
 *
 * The most dangerous feature in this application. A false alarm sends someone
 * the long way round; a false all-clear sends them into water. Every test
 * here exists to pin down that asymmetry, and the ones that matter most are
 * the ones asserting a cell stays flooded.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLEARING_REPORT_COUNT,
  CLEARING_WINDOW_MINUTES,
  CONFIRMATION_REPORT_COUNT,
  isClearedByReports,
  type ConditionedReport,
} from "./risk.ts";

const NOW = new Date("2026-09-23T12:00:00.000Z");

function at(minutesAgo: number, condition: "flooded" | "cleared"): ConditionedReport {
  return {
    condition,
    submittedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  };
}

function clears(count: number, startingMinutesAgo = 30): ConditionedReport[] {
  return Array.from({ length: count }, (_, i) => at(startingMinutesAgo - i, "cleared"));
}

describe("clearing is harder than confirming", () => {
  it("needs strictly more agreement than confirming does", () => {
    // Not an implementation detail: if these ever equalise, a pair of
    // pranksters could lift a confirmed cell as easily as they set one.
    assert.ok(
      CLEARING_REPORT_COUNT > CONFIRMATION_REPORT_COUNT,
      "clearing must require more reports than confirming",
    );
  });

  it("refuses one short of the threshold", () => {
    assert.equal(isClearedByReports(clears(CLEARING_REPORT_COUNT - 1), NOW), false);
  });

  it("clears at the threshold", () => {
    assert.equal(isClearedByReports(clears(CLEARING_REPORT_COUNT), NOW), true);
  });
});

describe("water coming back overrides a clear", () => {
  it("stays flooded when somebody reports water after the clears began", () => {
    // THE test. Three people said it had drained, then somebody saw water
    // again. The cell must flood again immediately, not wait for anything to
    // expire.
    const reports = [...clears(CLEARING_REPORT_COUNT, 30), at(5, "flooded")];
    assert.equal(isClearedByReports(reports, NOW), false);
  });

  it("still clears when the water report predates the clears", () => {
    // The ordinary case: it flooded, then it drained, then people said so.
    const reports = [at(90, "flooded"), ...clears(CLEARING_REPORT_COUNT, 30)];
    assert.equal(isClearedByReports(reports, NOW), true);
  });

  it("is decided by order, not by count", () => {
    // Many old flood reports must not outvote a genuine later clearing.
    const reports = [
      at(200, "flooded"),
      at(180, "flooded"),
      at(150, "flooded"),
      at(120, "flooded"),
      ...clears(CLEARING_REPORT_COUNT, 20),
    ];
    assert.equal(isClearedByReports(reports, NOW), true);
  });
});

describe("clears decay fast", () => {
  it("ignores clears older than the window", () => {
    const stale = clears(CLEARING_REPORT_COUNT, CLEARING_WINDOW_MINUTES + 30);
    assert.equal(isClearedByReports(stale, NOW), false);
  });

  it("counts a clear exactly on the window edge", () => {
    const edge = [
      at(CLEARING_WINDOW_MINUTES, "cleared"),
      at(CLEARING_WINDOW_MINUTES - 1, "cleared"),
      at(CLEARING_WINDOW_MINUTES - 2, "cleared"),
    ];
    assert.equal(isClearedByReports(edge, NOW), true);
  });

  it("ignores a clear dated in the future", () => {
    const future = [
      { condition: "cleared" as const, submittedAt: new Date(NOW.getTime() + 60_000).toISOString() },
      ...clears(CLEARING_REPORT_COUNT - 1, 10),
    ];
    assert.equal(isClearedByReports(future, NOW), false);
  });
});

describe("degenerate input", () => {
  it("does not clear an empty cell", () => {
    assert.equal(isClearedByReports([], NOW), false);
  });

  it("treats a report with no condition as a flooding report", () => {
    // Every row written before clearing existed is an observation of water.
    // Reading those as clears would retroactively empty the map.
    const legacy: ConditionedReport[] = [
      { submittedAt: at(10, "flooded").submittedAt },
      { submittedAt: at(9, "flooded").submittedAt },
      { submittedAt: at(8, "flooded").submittedAt },
    ];
    assert.equal(isClearedByReports(legacy, NOW), false);
  });

  it("ignores unparseable timestamps rather than counting them", () => {
    const broken: ConditionedReport[] = [
      { condition: "cleared", submittedAt: "not a date" },
      { condition: "cleared", submittedAt: "also not a date" },
      { condition: "cleared", submittedAt: "nope" },
    ];
    assert.equal(isClearedByReports(broken, NOW), false);
  });
});
