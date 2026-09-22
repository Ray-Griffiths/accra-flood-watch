/**
 * The safe-routing rules, as sentences and as classifications.
 *
 * These are read by somebody standing at a junction deciding whether to cross.
 * The wording is part of the feature, not decoration around it, so it is
 * asserted rather than left to drift.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Bounds } from "./geohash.ts";
import type { Hazard, HazardReason } from "./routing.ts";
import {
  DETOUR_NOTICE_METRES,
  DETOUR_NOTICE_SECONDS,
  MAX_AVOID_AREAS,
  avoidanceAreas,
  classifyHazards,
  describeDetour,
  explainNoSafeRoute,
  explainRoute,
  isHardBlock,
  isTravelMode,
} from "./routing.ts";

const BOX: Bounds = { west: -0.22, south: 5.57, east: -0.218, north: 5.572 };

function cell(name: string, level?: string) {
  return { cell: name, bounds: BOX, level };
}

describe("isTravelMode", () => {
  it("accepts the two supported modes", () => {
    assert.equal(isTravelMode("walking"), true);
    assert.equal(isTravelMode("driving"), true);
  });

  it("rejects anything else", () => {
    for (const value of ["transit", "Car", "", null, undefined, 3]) {
      assert.equal(isTravelMode(value), false, `accepted ${String(value)}`);
    }
  });
});

describe("isHardBlock", () => {
  /**
   * The split between evidence and inference. Confirmed and reported cells are
   * people saying there is water; `likely` is a model saying there might be.
   * Refusing to travel on the first is protective. Refusing on the second,
   * every time it rains, is how a tool stops being used.
   */
  it("blocks on observation and not on inference", () => {
    assert.equal(isHardBlock("confirmed"), true);
    assert.equal(isHardBlock("reported"), true);
    assert.equal(isHardBlock("likely"), false);
  });
});

describe("classifyHazards", () => {
  it("hard-blocks a confirmed cell", () => {
    const hazards = classifyHazards({ cells: [cell("ebzzdyp", "confirmed")], reports: [] });
    assert.deepEqual(hazards, [{ cell: "ebzzdyp", bounds: BOX, reason: "confirmed" }]);
  });

  /**
   * Confirmation needs two independent reports inside three hours. One person
   * reporting waist-deep water is already reason enough not to send somebody
   * else down that street, so the report alone blocks.
   */
  it("hard-blocks on a single knee-deep report without confirmation", () => {
    const hazards = classifyHazards({
      cells: [cell("ebzzdyp", "low")],
      reports: [{ cell: "ebzzdyp", depth: "knee" }],
    });
    assert.equal(hazards[0]?.reason, "reported");
  });

  it("hard-blocks on waist and impassable reports too", () => {
    for (const depth of ["waist", "impassable"] as const) {
      const hazards = classifyHazards({
        cells: [cell("ebzzdyp", "low")],
        reports: [{ cell: "ebzzdyp", depth }],
      });
      assert.equal(hazards[0]?.reason, "reported", `depth ${depth}`);
    }
  });

  /**
   * Ankle-deep water is passable on foot. Closing a road on it would make the
   * routing useless in ordinary Accra rain, and would teach people that the
   * blocks do not mean anything.
   */
  it("does not block on an ankle-deep report", () => {
    const hazards = classifyHazards({
      cells: [cell("ebzzdyp", "low")],
      reports: [{ cell: "ebzzdyp", depth: "ankle" }],
    });
    assert.deepEqual(hazards, []);
  });

  it("softly avoids a high cell", () => {
    const hazards = classifyHazards({ cells: [cell("ebzzdyp", "high")], reports: [] });
    assert.equal(hazards[0]?.reason, "likely");
    assert.equal(isHardBlock(hazards[0]!.reason), false);
  });

  it("ignores low and watch cells entirely", () => {
    const hazards = classifyHazards({
      cells: [cell("a", "low"), cell("b", "watch"), cell("c", undefined)],
      reports: [],
    });
    assert.deepEqual(hazards, []);
  });

  it("prefers the strongest reason when a cell qualifies more than once", () => {
    const hazards = classifyHazards({
      cells: [cell("ebzzdyp", "confirmed")],
      reports: [{ cell: "ebzzdyp", depth: "impassable" }],
    });
    assert.equal(hazards.length, 1);
    assert.equal(hazards[0]?.reason, "confirmed");
  });

  it("does not block a cell because a different cell was reported", () => {
    const hazards = classifyHazards({
      cells: [cell("ebzzdyp", "low")],
      reports: [{ cell: "ebzzdyq", depth: "impassable" }],
    });
    assert.deepEqual(hazards, []);
  });
});

describe("explainRoute", () => {
  it("says plainly when nothing is in the way", () => {
    const sentence = explainRoute({
      mode: "walking",
      blocked: 0,
      likely: 0,
      extraSeconds: null,
      extraMetres: null,
    });
    assert.equal(sentence, "No flooding is being reported along this route right now.");
  });

  it("counts what it went around", () => {
    const sentence = explainRoute({
      mode: "walking",
      blocked: 3,
      likely: 0,
      extraSeconds: 0,
      extraMetres: 0,
    });
    assert.match(sentence, /goes around 3 places where people are reporting water/);
  });

  it("uses the singular for one place", () => {
    const sentence = explainRoute({
      mode: "walking",
      blocked: 1,
      likely: 0,
      extraSeconds: 0,
      extraMetres: 0,
    });
    assert.match(sentence, /1 place where people are reporting water/);
    assert.doesNotMatch(sentence, /1 places/);
  });

  it("separates reported water from predicted flooding", () => {
    const sentence = explainRoute({
      mode: "walking",
      blocked: 2,
      likely: 4,
      extraSeconds: 0,
      extraMetres: 0,
    });
    assert.match(sentence, /2 places where people are reporting water/);
    assert.match(sentence, /4 where flooding is likely/);
  });

  it("describes a predicted-only detour without claiming reports", () => {
    const sentence = explainRoute({
      mode: "walking",
      blocked: 0,
      likely: 2,
      extraSeconds: 0,
      extraMetres: 0,
    });
    assert.match(sentence, /2 places where flooding is likely/);
    assert.doesNotMatch(sentence, /reporting/);
  });

  /**
   * Section 11 of the plan and the safety rules both require this: a route
   * that quietly takes somebody nine minutes out of their way is a route they
   * abandon halfway and finish through the water.
   */
  it("states the cost of the detour when it is material", () => {
    const sentence = explainRoute({
      mode: "walking",
      blocked: 1,
      likely: 0,
      extraSeconds: 540,
      extraMetres: 700,
    });
    assert.match(sentence, /about 9 minutes more walking/);
  });

  it("says so when avoidance cost nothing", () => {
    const sentence = explainRoute({
      mode: "driving",
      blocked: 1,
      likely: 0,
      extraSeconds: 5,
      extraMetres: 20,
    });
    assert.match(sentence, /no longer than the direct way/);
  });
});

describe("describeDetour", () => {
  it("returns nothing when there was no comparison", () => {
    assert.equal(describeDetour(null, null, "walking"), null);
  });

  it("suppresses a detour too small to be worth a sentence", () => {
    const text = describeDetour(DETOUR_NOTICE_SECONDS - 1, DETOUR_NOTICE_METRES - 1, "walking");
    assert.equal(text, "It is no longer than the direct way.");
  });

  it("reports the boundary detour", () => {
    const text = describeDetour(DETOUR_NOTICE_SECONDS, 0, "walking");
    assert.match(text ?? "", /about 1 minute more walking/);
  });

  it("falls back to distance when the time barely moved", () => {
    const text = describeDetour(10, 450, "walking");
    assert.match(text ?? "", /about 450m further/);
  });

  it("uses the right verb per mode", () => {
    assert.match(describeDetour(300, 0, "walking") ?? "", /more walking/);
    assert.match(describeDetour(300, 0, "driving") ?? "", /more driving/);
  });

  it("reads long detours in hours", () => {
    assert.match(describeDetour(3600, 0, "driving") ?? "", /about 1 hour more/);
    assert.match(describeDetour(5400, 0, "driving") ?? "", /about 1 hour 30 minutes/);
  });

  it("reads a long distance in kilometres", () => {
    assert.match(describeDetour(10, 2400, "walking") ?? "", /about 2\.4km further/);
  });
});

describe("explainNoSafeRoute", () => {
  /**
   * The message the whole safety rule exists for. It must not hedge, must not
   * offer the route anyway, and must name something the person can do next.
   */
  it("tells the user not to travel, in their mode", () => {
    assert.match(explainNoSafeRoute("walking"), /Do not walk this route/);
    assert.match(explainNoSafeRoute("driving"), /Do not drive this route/);
  });

  it("gives somewhere to go next rather than only a refusal", () => {
    const message = explainNoSafeRoute("walking");
    assert.match(message, /Wait for the water to drop|shelter/);
  });

  it("never softens into a conditional route", () => {
    for (const mode of ["walking", "driving"] as const) {
      const message = explainNoSafeRoute(mode);
      assert.doesNotMatch(message, /with caution|if you must|at your own risk/i);
    }
  });
});

/**
 * The avoidance request.
 *
 * `Avoid.Areas` accepts at most 250 items, and a corridor in a storm holds
 * far more hazard cells than that. Exceeding it is a ValidationException and
 * no route at all -- the failure lands precisely when somebody is trying to
 * get home through a flood, so the budget is tested at the boundary.
 */
describe("avoidanceAreas", () => {
  /** `count` adjacent cells on one row, all with the same reason. */
  function run(reason: HazardReason, count: number, south = 5.57): Hazard[] {
    const hazards: Hazard[] = [];
    for (let i = 0; i < count; i += 1) {
      hazards.push({
        cell: `${reason}-${i}`,
        reason,
        bounds: {
          west: -0.22 + i * 0.002,
          east: -0.22 + (i + 1) * 0.002,
          south,
          north: south + 0.002,
        },
      });
    }
    return hazards;
  }

  /** Cells deliberately spaced apart so none of them can merge. */
  function scattered(reason: HazardReason, count: number): Hazard[] {
    const hazards: Hazard[] = [];
    for (let i = 0; i < count; i += 1) {
      const west = -0.25 + i * 0.004;
      hazards.push({
        cell: `${reason}-${i}`,
        reason,
        bounds: { west, east: west + 0.002, south: 5.57, north: 5.572 },
      });
    }
    return hazards;
  }

  it("asks for nothing when there is nothing to avoid", () => {
    assert.deepEqual(avoidanceAreas([]), []);
  });

  it("collapses a flooded stretch of road into one rectangle", () => {
    const areas = avoidanceAreas(run("confirmed", 40));
    assert.equal(areas.length, 1);
  });

  it("stays within the limit the API accepts", () => {
    const areas = avoidanceAreas(scattered("likely", MAX_AVOID_AREAS * 2));
    assert.equal(areas.length, MAX_AVOID_AREAS);
  });

  it("spends the budget on evidence before inference", () => {
    // More `likely` cells than the whole budget, plus a handful of confirmed
    // ones. The confirmed cells are the ones that must survive.
    const confirmed = scattered("confirmed", 3);
    const likely = run("likely", MAX_AVOID_AREAS + 50, 5.6);

    const areas = avoidanceAreas([...likely, ...confirmed], 4);

    for (const hazard of confirmed) {
      assert.ok(
        areas.some(
          (box) =>
            box.west <= hazard.bounds.west + 1e-9 && box.east >= hazard.bounds.east - 1e-9,
        ),
        `confirmed cell ${hazard.cell} was dropped from the request`,
      );
    }
  });

  it("never merges a confirmed cell into a likely rectangle", () => {
    // Adjacent cells that differ only in reason. Merging across the two would
    // let the confirmed one be discarded with the likely one it joined.
    const hazards: Hazard[] = [
      {
        cell: "a",
        reason: "likely",
        bounds: { west: -0.22, east: -0.218, south: 5.57, north: 5.572 },
      },
      {
        cell: "b",
        reason: "confirmed",
        bounds: { west: -0.218, east: -0.216, south: 5.57, north: 5.572 },
      },
    ];

    const areas = avoidanceAreas(hazards);
    assert.equal(areas.length, 2);
    // Confirmed is emitted first, so the budget reaches it however tight.
    assert.deepEqual(areas[0], hazards[1]!.bounds);
  });
});
