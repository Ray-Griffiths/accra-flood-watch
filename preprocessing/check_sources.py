"""Smoke check: confirm both external inputs are reachable and sane."""

import numpy as np

import sources

print("Fetching inputs for the pilot area...")
elevation, transform = sources.load_elevation()
drainage = sources.load_drainage()

valid = elevation[~np.isnan(elevation)]
print()
print(f"elevation shape : {elevation.shape}")
print(f"pixel size deg  : {transform.a:.6f} x {abs(transform.e):.6f}")
print(f"pixel size m    : {transform.a * 111320 * 0.99528:.1f}")
print(f"elevation range : {valid.min():.1f} to {valid.max():.1f} m")
print(f"elevation median: {np.median(valid):.1f} m")
print(f"nan pixels      : {np.isnan(elevation).sum()}")
print()
kinds: dict[str, int] = {}
for feature in drainage:
    kinds[feature["kind"]] = kinds.get(feature["kind"], 0) + 1
print(f"drainage features: {len(drainage)}")
for kind, count in sorted(kinds.items(), key=lambda item: -item[1]):
    print(f"  {kind:12s} {count}")
