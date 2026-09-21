"""Height Above Nearest Drainage and slope, computed on the DEM grid.

HAND is the vertical distance from a point to the nearest point on the drainage
network. A low value means water arriving nearby has very little downhill to
travel before it reaches you.

It is used here rather than a hydrodynamic flood model because it is computable
from freely available data, needs no historical flood records to calibrate, and
explains itself to a non-technical user in one sentence. Those properties are
what make it the right choice for a two-week build.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from rasterio.features import rasterize
from scipy import ndimage


def _pixel_size_metres(transform: Any, latitude: float) -> tuple[float, float]:
    """Approximate pixel width and height in metres at a given latitude."""
    width = abs(transform.a) * 111_320 * np.cos(np.radians(latitude))
    height = abs(transform.e) * 110_574
    return float(width), float(height)


def rasterise_drainage(
    drainage: list[dict[str, Any]], shape: tuple[int, int], transform: Any
) -> np.ndarray:
    """Burn the drainage network onto the DEM grid as a boolean mask."""
    if not drainage:
        return np.zeros(shape, dtype=bool)

    shapes = [
        ({"type": feature["type"], "coordinates": feature["coordinates"]}, 1)
        for feature in drainage
    ]
    burned = rasterize(
        shapes,
        out_shape=shape,
        transform=transform,
        fill=0,
        default_value=1,
        all_touched=True,  # a 3m ditch still occupies its 30m pixel
        dtype="uint8",
    )
    return burned.astype(bool)


def height_above_nearest_drainage(
    elevation: np.ndarray, drainage_mask: np.ndarray, transform: Any, latitude: float
) -> np.ndarray:
    """Vertical drop from every pixel to the nearest drainage pixel.

    Uses a Euclidean nearest-neighbour search rather than full flow routing.
    That is faithful to the definition the project works from -- "the vertical
    distance between that pixel and the nearest point on the drainage
    network" -- and it avoids a flow-accumulation dependency for a gain that
    would not survive the 30m resolution of the underlying DEM anyway.
    """
    if not drainage_mask.any():
        raise ValueError(
            "No drainage pixels. Check the Overpass query and the DEM window."
        )

    width_metres, height_metres = _pixel_size_metres(transform, latitude)

    # Distance transform of the *background*: for every pixel, the indices of
    # the nearest pixel that IS drainage.
    _, indices = ndimage.distance_transform_edt(
        ~drainage_mask,
        sampling=(height_metres, width_metres),
        return_indices=True,
    )

    filled = np.nan_to_num(elevation, nan=float(np.nanmedian(elevation)))
    nearest_drain_elevation = filled[indices[0], indices[1]]

    hand = filled - nearest_drain_elevation
    # Ground below its nearest drain is already at or under water level.
    return np.maximum(hand, 0.0)


def slope_degrees(
    elevation: np.ndarray, transform: Any, latitude: float
) -> np.ndarray:
    """Local slope in degrees.

    Flat ground drains slowly even when it is not especially low-lying, which
    is why slope earns a weight of its own alongside HAND.
    """
    width_metres, height_metres = _pixel_size_metres(transform, latitude)
    filled = np.nan_to_num(elevation, nan=float(np.nanmedian(elevation)))

    # np.gradient returns (d/drow, d/dcol); rows run north-south.
    d_row, d_column = np.gradient(filled, height_metres, width_metres)
    return np.degrees(np.arctan(np.hypot(d_row, d_column)))
