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
import {
  DETOUR_NOTICE_METRES,
  DETOUR_NOTICE_SECONDS,
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
