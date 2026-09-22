import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEPTH_LEVELS, strongestDepth, type DepthLevel } from "./risk.ts";

/**
 * The depth that reaches the alert. Getting this wrong understates how bad a
 * flood is in the one message someone reads before deciding whether to walk
 * into it, so every ordering pair is pinned rather than spot-checked.
 */
describe("strongestDepth", () => {
  it("is undefined when nothing was reported", () => {
    assert.equal(strongestDepth([]), undefined);
  });

  it("returns the only depth when there is one", () => {
    assert.equal(strongestDepth(["knee"]), "knee");
  });

  it("picks the deepest regardless of the order they arrived in", () => {
    assert.equal(strongestDepth(["ankle", "impassable", "knee"]), "impassable");
    assert.equal(strongestDepth(["impassable", "ankle"]), "impassable");
    assert.equal(strongestDepth(["ankle", "waist"]), "waist");
  });

  it("is unmoved by repeats of a shallower depth", () => {
    // Ten people reporting ankle-deep water and one reporting waist-deep does
    // not make the flood ankle deep.
    const depths: DepthLevel[] = [...Array<DepthLevel>(10).fill("ankle"), "waist"];
    assert.equal(strongestDepth(depths), "waist");
  });

  it("ranks every adjacent pair in the documented order", () => {
    for (let i = 0; i < DEPTH_LEVELS.length - 1; i += 1) {
      const shallower = DEPTH_LEVELS[i]!;
      const deeper = DEPTH_LEVELS[i + 1]!;
      assert.equal(
        strongestDepth([shallower, deeper]),
        deeper,
        `${deeper} should outrank ${shallower}`,
      );
    }
  });

  it("agrees with DEPTH_LEVELS about which is worst overall", () => {
    // Guards the ordering against someone reordering DEPTH_LEVELS without
    // realising the alert wording depends on it.
    assert.equal(strongestDepth([...DEPTH_LEVELS]), DEPTH_LEVELS.at(-1));
  });
});
