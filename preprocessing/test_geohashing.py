"""Tests for the geohash implementation.

The grid this produces is baked into every DynamoDB partition key, so a silent
error here would be expensive to discover later.
"""

import geohashing as g
from config import GEOHASH_PRECISION, PILOT_BBOX


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
