"""Diagnostic: how the susceptibility score is distributed and why.

A risk map only works if it discriminates. If most of the pilot area sits in
the top band, the overlay carries no information and users stop reading it.
"""

import json

import numpy as np

import config

artefact = json.loads(config.SUSCEPTIBILITY_OUTPUT.read_text(encoding="utf-8"))
cells = artefact["cells"]

hand = np.array([c["hand"] for c in cells])
slope = np.array([c["slope"] for c in cells])
score = np.array([c["susceptibility"] for c in cells])

print(f"cells: {len(cells)}\n")


def summarise(name: str, values: np.ndarray, unit: str = "") -> None:
    percentiles = [0, 10, 25, 50, 75, 90, 100]
    line = "  ".join(
        f"p{p:<3d}={np.percentile(values, p):7.2f}" for p in percentiles
    )
    print(f"{name:12s} {line} {unit}")


summarise("HAND (cell)", hand, "m")
summarise("slope", slope, "deg")
summarise("score", score)
print()

# How much of the score comes from each term, before the historical floors.
hand_term = 100.0 * np.exp(-hand / config.HAND_DECAY_METRES)
slope_term = 100.0 * (1.0 - np.minimum(slope / config.SLOPE_FREE_DRAINING_DEGREES, 1.0))
print("Contribution to the raw score:")
print(f"  HAND term  weighted median: {np.median(config.WEIGHT_HAND * hand_term):5.1f}")
print(f"  slope term weighted median: {np.median(config.WEIGHT_SLOPE * slope_term):5.1f}")
print()

# Slope saturation: pixels flatter than the free-draining threshold get the
# maximum slope score, so if nearly everything is flat the term stops
# discriminating and just adds a constant.
flat = (slope < 1.0).sum()
print(f"cells with slope < 1.0 deg : {flat} ({100 * flat / len(cells):.0f}%)")
print(f"cells at slope score >= 90 : {(slope_term >= 90).sum()}")
print()

floored = sum(1 for c in cells if c["historicalFloodPoint"])
print(f"cells raised by a historical point: {floored}")
print()

print("What the current thresholds would paint on the map:")
for label, low, high in [
    ("low", 0, 40),
    ("watch", 40, 60),
    ("high", 60, 80),
    ("very high", 80, 101),
]:
    count = int(((score >= low) & (score < high)).sum())
    print(f"  {label:10s} {count:5d}  {100 * count / len(cells):5.1f}%")
