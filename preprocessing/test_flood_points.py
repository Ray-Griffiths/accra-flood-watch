"""Tests for the historical flood point contract.

These points override the terrain model, so the rules about which ones count
are worth more than the usual amount of enforcement. The file itself explains
the standard; this checks the file keeps to it.
"""

import config
import flood_points as fp
import geohashing as g


def _inside_coverage(point) -> bool:
    for _, _, (west, south, east, north) in config.COVERED_AREAS:
        if west <= point["longitude"] <= east and south <= point["latitude"] <= north:
            return True
    return False


def test_every_verified_point_records_its_sources():
    # "Verified" without a record of what verified it cannot be re-checked by
    # anybody else, which makes it a claim rather than a verification.
    for point in fp.verified(fp.HISTORICAL_FLOOD_POINTS):
        assert point["sources"], f"{point['name']} is verified with no sources"


def test_unverified_points_claim_no_sources():
    for point in fp.unverified(fp.HISTORICAL_FLOOD_POINTS):
        assert point["sources"] == [], f"{point['name']} is unverified but cites sources"


def test_verified_and_unverified_partition_the_list():
    total = len(fp.HISTORICAL_FLOOD_POINTS)
    assert len(fp.verified(fp.HISTORICAL_FLOOD_POINTS)) + len(
        fp.unverified(fp.HISTORICAL_FLOOD_POINTS)
    ) == total


def test_every_verified_point_is_inside_coverage():
    # A point outside coverage raises susceptibility on a cell that does not
    # exist, so it silently does nothing at all.
    for point in fp.verified(fp.HISTORICAL_FLOOD_POINTS):
        assert _inside_coverage(point), f"{point['name']} is outside coverage"


def test_every_verified_point_lands_in_a_distinct_cell():
    # Two points in one cell is double-counting: the floor applies once, but
    # the neighbour floor applies twice and spreads further than intended.
    cells = [
        g.encode(p["latitude"], p["longitude"], config.GEOHASH_PRECISION)
        for p in fp.verified(fp.HISTORICAL_FLOOD_POINTS)
    ]
    assert len(cells) == len(set(cells))


def test_coordinates_are_plausible_for_accra():
    for point in fp.HISTORICAL_FLOOD_POINTS:
        assert 5.4 < point["latitude"] < 5.8, point["name"]
        assert -0.4 < point["longitude"] < 0.1, point["name"]


def test_names_and_notes_are_present():
    for point in fp.HISTORICAL_FLOOD_POINTS:
        assert point["name"].strip()
        assert point["note"].strip()


def test_at_least_one_point_survives_verification():
    # If this ever empties, the terrain model is running with no observed
    # reality behind it at all, and that should be a loud failure.
    assert fp.verified(fp.HISTORICAL_FLOOD_POINTS)


def test_points_in_areas_deduplicates_overlapping_areas():
    areas = [
        ("a", "A", (-0.25, 5.535, -0.17, 5.65)),
        ("b", "B", (-0.25, 5.535, -0.17, 5.65)),
    ]
    found = fp.points_in_areas(areas)
    keys = [(p["latitude"], p["longitude"]) for p in found]
    assert len(keys) == len(set(keys))
