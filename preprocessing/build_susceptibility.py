"""Build the static flood susceptibility grid for the pilot area.

Runs once, offline. Its output is a static artefact that a seeding script loads
into the RiskCells table. This is deliberately not a Lambda function: raster
processing is the wrong shape of work for a request handler.

    python build_susceptibility.py [--refresh]

Pipeline:
    1. Read the Copernicus elevation window from the Registry of Open Data.
    2. Fetch waterways and drains from OpenStreetMap and rasterise them.
    3. Compute Height Above Nearest Drainage for every pixel.
    4. Compute local slope.
    5. Aggregate pixels into geohash cells, taking a conservative low
       percentile of HAND so a low-lying pocket is not disguised.
    6. Raise cells containing documented historical flood points.
    7. Normalise to 0-100 and write JSON.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import numpy as np

import config
import flood_points
import geohashing
import sources
import terrain


def _susceptibility_from_hand(hand: float) -> float:
    """Map HAND in metres to a 0-100 score.

    Exponential decay rather than linear: the difference between 0.5m and 2m
    above the nearest drain matters enormously, while the difference between
    15m and 30m does not matter at all.
    """
    return 100.0 * float(np.exp(-hand / config.HAND_DECAY_METRES))


def _susceptibility_from_slope(slope: float) -> float:
    """Map slope in degrees to a 0-100 score. Flat ground drains slowly."""
    ratio = min(slope / config.SLOPE_FREE_DRAINING_DEGREES, 1.0)
    return 100.0 * (1.0 - ratio)


def build(refresh: bool = False) -> dict:
    print("Accra Flood Watch - terrain preprocessing")
    for area_id, name, bbox in config.COVERED_AREAS:
        print(f"  area            : {area_id} ({name})")
        print(f"                    {bbox}")
    print(f"  envelope        : {config.PILOT_BBOX}")
    print(f"  geohash precision: {config.GEOHASH_PRECISION}")
    print()

    print("Loading sources...")
    elevation, transform = sources.load_elevation(refresh=refresh)
    drainage = sources.load_drainage(refresh=refresh)
    print()

    centre_latitude = (config.PILOT_BBOX[1] + config.PILOT_BBOX[3]) / 2

    print("Computing terrain...")
    drainage_mask = terrain.rasterise_drainage(drainage, elevation.shape, transform)
    coverage = 100.0 * drainage_mask.sum() / drainage_mask.size
    print(f"  drainage pixels : {drainage_mask.sum()} ({coverage:.1f}% of grid)")

    hand = terrain.height_above_nearest_drainage(
        elevation, drainage_mask, transform, centre_latitude
    )
    slope = terrain.slope_degrees(elevation, transform, centre_latitude)
    print(f"  HAND range      : {hand.min():.1f} to {hand.max():.1f} m")
    print(f"  HAND median     : {np.median(hand):.1f} m")
    print(f"  slope median    : {np.median(slope):.2f} deg")
    print()

    # Pixel centre coordinates, used to assign each pixel to a geohash cell.
    rows, columns = elevation.shape
    row_indices, column_indices = np.indices((rows, columns))
    longitudes, latitudes = transform * (column_indices + 0.5, row_indices + 0.5)

    print("Aggregating into geohash cells...")
    # One pass per area, deduplicated. Covering the envelope instead would
    # manufacture cells in the gaps between disjoint areas -- ground with a
    # DEM reading but no reason to claim it is being watched.
    seen_cells: set[str] = set()
    cells: list[str] = []
    for _, _, bbox in config.COVERED_AREAS:
        for cell in geohashing.cells_covering(bbox, config.GEOHASH_PRECISION):
            if cell in seen_cells:
                continue
            seen_cells.add(cell)
            cells.append(cell)
    cells.sort()
    print(f"  grid cells      : {len(cells)}")

    # Bucket pixels by cell in one pass rather than masking per cell, which
    # would be O(cells x pixels) and needlessly slow.
    buckets: dict[str, list[int]] = {}
    flat_latitudes = latitudes.ravel()
    flat_longitudes = longitudes.ravel()
    for index in range(flat_latitudes.size):
        cell = geohashing.encode(
            float(flat_latitudes[index]),
            float(flat_longitudes[index]),
            config.GEOHASH_PRECISION,
        )
        buckets.setdefault(cell, []).append(index)

    flat_hand = hand.ravel()
    flat_slope = slope.ravel()
    flat_elevation = elevation.ravel()
    flat_is_drainage = drainage_mask.ravel()

    records: dict[str, dict] = {}
    empty_cells = 0
    drainage_only_cells = 0
    for cell in cells:
        indices = buckets.get(cell)
        if not indices:
            # A 152m cell can sit between 30m pixel centres and catch none of
            # them. Fall back to the value sampled at the cell centre.
            west, south, east, north = geohashing.bounds(cell)
            column_f, row_f = ~transform * ((west + east) / 2, (south + north) / 2)
            row_index = int(np.clip(int(row_f), 0, rows - 1))
            column_index = int(np.clip(int(column_f), 0, columns - 1))
            cell_hand = float(hand[row_index, column_index])
            cell_slope = float(slope[row_index, column_index])
            cell_elevation = float(elevation[row_index, column_index])
            empty_cells += 1
        else:
            selected = np.array(indices)

            # HAND is measured on the land, not on the water. Including
            # drainage pixels would force the low percentile to zero for every
            # cell a drain crosses. See MIN_LAND_PIXELS_PER_CELL in config.
            land = selected[~flat_is_drainage[selected]]
            if land.size < config.MIN_LAND_PIXELS_PER_CELL:
                # Cell is almost entirely channel or water body. There is no
                # land here to score, so fall back to all pixels and let the
                # result stand as the genuinely low-lying ground it is.
                land = selected
                drainage_only_cells += 1

            # A conservative low percentile: a cell containing a low-lying
            # pocket must not be disguised by surrounding high ground.
            cell_hand = float(np.percentile(flat_hand[land], config.HAND_PERCENTILE))
            cell_slope = float(np.median(flat_slope[land]))
            cell_elevation = float(np.median(flat_elevation[land]))

        score = (
            config.WEIGHT_HAND * _susceptibility_from_hand(cell_hand)
            + config.WEIGHT_SLOPE * _susceptibility_from_slope(cell_slope)
        )

        records[cell] = {
            "cell": cell,
            "susceptibility": round(score, 1),
            "hand": round(cell_hand, 2),
            "slope": round(cell_slope, 2),
            "elevation": round(cell_elevation, 1),
            "historicalFloodPoint": None,
        }

    if empty_cells:
        print(f"  cells via centre: {empty_cells} (no pixel centre inside)")
    if drainage_only_cells:
        print(f"  channel cells   : {drainage_only_cells} (too little land to score)")
    print()

    print("Applying historical flood points...")
    points = flood_points.points_in_areas(config.COVERED_AREAS)
    outside = len(flood_points.HISTORICAL_FLOOD_POINTS) - len(points)
    print(f"  points in area  : {len(points)} ({outside} outside coverage)")

    # Only corroborated points override the terrain model. This used to apply
    # every point and print a warning about the unverified ones, which meant a
    # coordinate somebody had guessed raised a cell to 75 exactly as hard as
    # one that had been checked -- and five of the original eight turned out to
    # be in the wrong cell entirely. A warning nobody acts on is not a control.
    applicable = flood_points.verified(points)
    skipped = flood_points.unverified(points)
    print(f"  verified        : {len(applicable)}")

    applied = 0
    for point in applicable:
        cell = geohashing.encode(
            point["latitude"], point["longitude"], config.GEOHASH_PRECISION
        )
        record = records.get(cell)
        if record is None:
            print(f"  ! {point['name']}: cell {cell} not in grid, skipped")
            continue
        record["susceptibility"] = max(
            record["susceptibility"], config.HISTORICAL_POINT_FLOOR
        )
        record["historicalFloodPoint"] = point["name"]
        applied += 1

        # Flooding spreads. Neighbours of a known flood point get a softer floor.
        for neighbour in geohashing.neighbours(cell):
            neighbour_record = records.get(neighbour)
            if neighbour_record is not None:
                neighbour_record["susceptibility"] = max(
                    neighbour_record["susceptibility"],
                    config.HISTORICAL_NEIGHBOUR_FLOOR,
                )

    print(f"  points applied  : {applied}")

    if skipped:
        print()
        print(f"  {len(skipped)} of {len(points)} points are NOT APPLIED, pending")
        print("  verification. They are real places with documented flooding whose")
        print("  coordinates could not be corroborated by two independent sources.")
        print("  Each needs a local check. See flood_points.py for what is missing.")
        for point in skipped:
            print(f"    - {point['name']}")
    print()

    scores = np.array([record["susceptibility"] for record in records.values()])
    artefact = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "coveredAreas": [
            {"id": area_id, "name": name, "bbox": list(bbox)}
            for area_id, name, bbox in config.COVERED_AREAS
        ],
        # Retained under its original name so seed_risk_cells.py and any saved
        # artefact stay readable. It is the envelope, not a boundary.
        "pilotBbox": list(config.PILOT_BBOX),
        "geohashPrecision": config.GEOHASH_PRECISION,
        "model": {
            "weightHand": config.WEIGHT_HAND,
            "weightSlope": config.WEIGHT_SLOPE,
            "handDecayMetres": config.HAND_DECAY_METRES,
            "slopeFreeDrainingDegrees": config.SLOPE_FREE_DRAINING_DEGREES,
            "handPercentile": config.HAND_PERCENTILE,
        },
        "historicalPointsApplied": applied,
        "historicalPointsUnverified": len(skipped),
        "cellCount": len(records),
        "cells": list(records.values()),
    }

    config.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    config.SUSCEPTIBILITY_OUTPUT.write_text(
        json.dumps(artefact, indent=2), encoding="utf-8"
    )

    size_kb = config.SUSCEPTIBILITY_OUTPUT.stat().st_size / 1024
    print("Susceptibility distribution:")
    for low, high in [(0, 20), (20, 40), (40, 60), (60, 80), (80, 101)]:
        count = int(((scores >= low) & (scores < high)).sum())
        bar = "#" * int(48 * count / max(len(scores), 1))
        print(f"  {low:3d}-{high - 1:3d}  {count:5d}  {bar}")
    print()
    print(f"  min {scores.min():.1f}  median {np.median(scores):.1f}  max {scores.max():.1f}")
    print()
    print(f"Wrote {config.SUSCEPTIBILITY_OUTPUT} ({size_kb:.0f} KB)")
    return artefact


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Re-fetch elevation and drainage instead of using the cache.",
    )
    build(refresh=parser.parse_args().refresh)
