"""Tests for the geohash implementation.

The grid this produces is baked into every DynamoDB partition key, so a silent
error here would be expensive to discover later.
"""

import config
import geohashing as g
from config import GEOHASH_PRECISION

# The original Circle / Kaneshie / Avenor pilot box, pinned here as a fixture
# rather than read from config. The cell count below was measured for exactly
# this box and is what holds the Python encoder and the TypeScript one to the
# same grid. Pointing it at whatever coverage happens to be would turn a real
# cross-implementation check into a number that gets edited whenever it fails.
PILOT_BBOX = (-0.245, 5.550, -0.195, 5.590)


def test_encodes_the_canonical_reference_value():
    # The worked example from the original geohash specification.
    assert g.encode(57.64911, 10.40744, 11) == "u4pruydqqvj"


def test_encodes_a_known_accra_landmark():
    # Kwame Nkrumah Circle sits in the Odaw basin, inside the pilot area.
    # Greater Accra falls under the "ebzz" prefix.
    cell = g.encode(5.5709, -0.2074, 7)
    assert cell.startswith("ebzz")
    assert cell in g.cells_covering(PILOT_BBOX, GEOHASH_PRECISION)


def test_precision_controls_length():
    for precision in range(1, 12):
        assert len(g.encode(5.5709, -0.2074, precision)) == precision


def test_shorter_geohashes_are_prefixes_of_longer_ones():
    full = g.encode(5.5709, -0.2074, 9)
    for precision in range(1, 9):
        assert full.startswith(g.encode(5.5709, -0.2074, precision))


def test_bounds_contain_the_encoded_point():
    latitude, longitude = 5.5709, -0.2074
    west, south, east, north = g.bounds(g.encode(latitude, longitude, 7))
    assert west <= longitude <= east
    assert south <= latitude <= north


def test_cell_centre_round_trips_to_the_same_cell():
    cell = g.encode(5.5709, -0.2074, 7)
    west, south, east, north = g.bounds(cell)
    assert g.encode((south + north) / 2, (west + east) / 2, 7) == cell


def test_cell_size_is_about_150_metres_at_precision_7():
    width, height = g.cell_size(7)
    # Degrees to metres at Accra's latitude.
    width_metres = width * 111_320 * 0.99528
    height_metres = height * 110_574
    assert 140 < width_metres < 165
    assert 140 < height_metres < 165


def test_pilot_grid_has_a_workable_cell_count():
    cells = g.cells_covering(PILOT_BBOX, GEOHASH_PRECISION)
    # ~37 columns x ~30 rows. Far off in either direction means the lattice
    # walk is wrong, not that the pilot area changed.
    assert 900 < len(cells) < 1400
    assert len(cells) == len(set(cells))


def test_every_pilot_cell_intersects_the_pilot_bbox():
    pilot_west, pilot_south, pilot_east, pilot_north = PILOT_BBOX
    for cell in g.cells_covering(PILOT_BBOX, GEOHASH_PRECISION):
        west, south, east, north = g.bounds(cell)
        assert east > pilot_west and west < pilot_east
        assert north > pilot_south and south < pilot_north


def test_pilot_grid_covers_the_interior_including_corners():
    cells = set(g.cells_covering(PILOT_BBOX, GEOHASH_PRECISION))
    west, south, east, north = PILOT_BBOX
    nudge = 1e-4
    probes = [
        (south + nudge, west + nudge),
        (south + nudge, east - nudge),
        (north - nudge, west + nudge),
        (north - nudge, east - nudge),
        ((south + north) / 2, (west + east) / 2),
    ]
    for latitude, longitude in probes:
        assert g.encode(latitude, longitude, GEOHASH_PRECISION) in cells


def test_points_outside_the_pilot_area_fall_outside_the_grid():
    cells = set(g.cells_covering(PILOT_BBOX, GEOHASH_PRECISION))
    outside = [
        (5.6037, -0.1870),  # Achimota, north-east of the pilot area
        (5.5560, -0.1900),  # just east of the eastern boundary
        (5.6500, -0.2200),  # Lapaz, well north
        (5.5200, -0.2400),  # Korle Gonno, south-west
        (5.5700, -0.2500),  # just west of the western boundary
        (6.6885, -1.6244),  # Kumasi, another city entirely
    ]
    for latitude, longitude in outside:
        assert g.encode(latitude, longitude, GEOHASH_PRECISION) not in cells


def _covered_cells() -> set[str]:
    """Every grid cell in every covered area, as the build script builds it."""
    cells: set[str] = set()
    for _, _, bbox in config.COVERED_AREAS:
        cells |= set(g.cells_covering(bbox, GEOHASH_PRECISION))
    return cells


def test_coverage_now_includes_the_upstream_odaw_ground():
    # The point of extending to the catchment. Achimota and Lapaz are where
    # the water that floods Circle comes from, and the pilot box stopped short
    # of both -- they are asserted as outside the pilot fixture just above.
    cells = _covered_cells()
    for latitude, longitude in [
        (5.6037, -0.1870),  # Achimota
        (5.6500, -0.2200),  # Lapaz
        (5.5820, -0.2115),  # Alajo bridge approach
        (5.5450, -0.2220),  # Agbogbloshie / Korle Lagoon
    ]:
        assert g.encode(latitude, longitude, GEOHASH_PRECISION) in cells


def test_coverage_still_excludes_other_parts_of_accra():
    cells = _covered_cells()
    for latitude, longitude in [
        (5.5500, -0.3100),  # Weija, west
        (5.6300, 0.0100),  # Tema, east
        (5.7000, -0.2100),  # north of the headwaters
        (6.6885, -1.6244),  # Kumasi
    ]:
        assert g.encode(latitude, longitude, GEOHASH_PRECISION) not in cells


def test_covered_grid_matches_the_expected_cell_count():
    # ~5,100 cells over the Odaw catchment at precision 7. A large move here
    # means the area changed or the walk is wrong, and either way the hourly
    # scoring cost moved with it.
    cells = _covered_cells()
    assert 4500 < len(cells) < 5700


def test_neighbours_returns_eight_distinct_surrounding_cells():
    cell = g.encode(5.5709, -0.2074, 7)
    result = g.neighbours(cell)
    assert len(result) == 8
    assert len(set(result)) == 8
    assert cell not in result
    for neighbour in result:
        assert len(neighbour) == len(cell)


def test_neighbour_relation_is_symmetric():
    cell = g.encode(5.5709, -0.2074, 7)
    for neighbour in g.neighbours(cell):
        assert cell in g.neighbours(neighbour)


def test_covered_areas_mirror_the_backend_definition():
    """config.COVERED_AREAS and backend/src/lib/pilot.ts must not drift.

    Both files say so in a comment, which has never once stopped two constants
    from diverging. The grid is baked into every DynamoDB partition key: if the
    preprocessing seeds cells the handlers consider out of bounds, reports get
    rejected over ground the map is drawing.
    """
    import pathlib
    import re

    source = (
        pathlib.Path(__file__).resolve().parent.parent
        / "backend"
        / "src"
        / "lib"
        / "pilot.ts"
    ).read_text(encoding="utf-8")

    block = re.search(
        r"COVERED_AREAS:\s*readonly\s+CoveredArea\[\]\s*=\s*\[(.*?)\n\];",
        source,
        re.DOTALL,
    )
    assert block, "COVERED_AREAS not found in backend/src/lib/pilot.ts"

    entries = re.findall(
        r'id:\s*"([^"]+)".*?'
        r'name:\s*"([^"]+)".*?'
        r"bounds:\s*\{\s*west:\s*(-?[\d.]+),\s*south:\s*(-?[\d.]+),"
        r"\s*east:\s*(-?[\d.]+),\s*north:\s*(-?[\d.]+)",
        block.group(1),
        re.DOTALL,
    )
    assert entries, "no areas parsed from backend/src/lib/pilot.ts"

    backend = [
        (area_id, name, (float(w), float(s), float(e), float(n)))
        for area_id, name, w, s, e, n in entries
    ]
    assert backend == [
        (area_id, name, tuple(float(v) for v in bbox))
        for area_id, name, bbox in config.COVERED_AREAS
    ]
