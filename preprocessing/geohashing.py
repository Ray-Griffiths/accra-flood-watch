"""Geohash encoding, implemented here rather than pulled in as a dependency.

The algorithm is thirty lines and completely stable, and the backend needs a
byte-identical implementation in TypeScript. Keeping both versions visible and
small is worth more than sharing a library neither side can inspect.

A geohash prefix describes a contiguous rectangle, which is the whole reason
it is the DynamoDB partition key: one query returns every item in an area, so
no geospatial index and no scan is ever needed.
"""

from __future__ import annotations

_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def encode(latitude: float, longitude: float, precision: int) -> str:
    """Encode a coordinate as a geohash of the given character length."""
    lat_range = [-90.0, 90.0]
    lon_range = [-180.0, 180.0]
    geohash: list[str] = []
    bits = 0
    bit_count = 0
    use_longitude = True

    while len(geohash) < precision:
        if use_longitude:
            mid = (lon_range[0] + lon_range[1]) / 2
            if longitude > mid:
                bits = (bits << 1) | 1
                lon_range[0] = mid
            else:
                bits <<= 1
                lon_range[1] = mid
        else:
            mid = (lat_range[0] + lat_range[1]) / 2
            if latitude > mid:
                bits = (bits << 1) | 1
                lat_range[0] = mid
            else:
                bits <<= 1
                lat_range[1] = mid

        use_longitude = not use_longitude
        bit_count += 1

        if bit_count == 5:
            geohash.append(_BASE32[bits])
            bits = 0
            bit_count = 0

    return "".join(geohash)


def bounds(geohash: str) -> tuple[float, float, float, float]:
    """Return (west, south, east, north) for a geohash cell."""
    lat_range = [-90.0, 90.0]
    lon_range = [-180.0, 180.0]
    use_longitude = True

    for character in geohash:
        index = _BASE32.index(character)
        for shift in range(4, -1, -1):
            bit = (index >> shift) & 1
            if use_longitude:
                mid = (lon_range[0] + lon_range[1]) / 2
                lon_range[0 if bit else 1] = mid
            else:
                mid = (lat_range[0] + lat_range[1]) / 2
                lat_range[0 if bit else 1] = mid
            use_longitude = not use_longitude

    return lon_range[0], lat_range[0], lon_range[1], lat_range[1]


def cell_size(precision: int) -> tuple[float, float]:
    """Return (width, height) of a cell in degrees at the given precision."""
    longitude_bits = (precision * 5 + 1) // 2
    latitude_bits = (precision * 5) // 2
    return 360.0 / (2**longitude_bits), 180.0 / (2**latitude_bits)


def cells_covering(
    bbox: tuple[float, float, float, float], precision: int
) -> list[str]:
    """Every geohash cell at `precision` that intersects `bbox`.

    Walks a lattice stepped by the cell size rather than deduplicating a dense
    sample, so the result is exact and the cost is proportional to the output.
    """
    west, south, east, north = bbox
    width, height = cell_size(precision)

    # Snap to the cell lattice so the walk lands mid-cell and cannot skip one.
    start_lon = (west // width) * width + width / 2
    start_lat = (south // height) * height + height / 2

    cells: list[str] = []
    seen: set[str] = set()

    latitude = start_lat
    while latitude <= north + height:
        longitude = start_lon
        while longitude <= east + width:
            cell = encode(latitude, longitude, precision)
            cell_west, cell_south, cell_east, cell_north = bounds(cell)
            # Keep only genuine intersections; the padded walk overshoots.
            if (
                cell_east > west
                and cell_west < east
                and cell_north > south
                and cell_south < north
                and cell not in seen
            ):
                seen.add(cell)
                cells.append(cell)
            longitude += width
        latitude += height

    return sorted(cells)


def neighbours(geohash: str) -> list[str]:
    """The eight geohash cells surrounding this one, at the same precision."""
    west, south, east, north = bounds(geohash)
    centre_lon = (west + east) / 2
    centre_lat = (south + north) / 2
    width = east - west
    height = north - south

    result: list[str] = []
    for delta_lat in (-1, 0, 1):
        for delta_lon in (-1, 0, 1):
            if delta_lat == 0 and delta_lon == 0:
                continue
            result.append(
                encode(
                    centre_lat + delta_lat * height,
                    centre_lon + delta_lon * width,
                    len(geohash),
                )
            )
    return result
