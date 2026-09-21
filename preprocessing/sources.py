"""Fetching the two external inputs: elevation and the drainage network.

Both are cached to disk on first fetch. Re-running the pipeline while tuning
the susceptibility model should not re-download a 30MB raster or hammer a free
community API, and a cached run is reproducible when Overpass is having a bad day.
"""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import rasterio
import requests
from rasterio.session import AWSSession
from rasterio.windows import from_bounds

import config


def _buffered_bbox() -> tuple[float, float, float, float]:
    """The pilot area plus a margin.

    Drainage just outside the pilot boundary still drains it. Cutting the DEM
    exactly to the boundary would compute a wrong HAND for every edge cell,
    because the nearest drain might sit one pixel outside the window.
    """
    west, south, east, north = config.PILOT_BBOX
    buffer = config.BUFFER_DEGREES
    return west - buffer, south - buffer, east + buffer, north + buffer


def load_elevation(refresh: bool = False) -> tuple[np.ndarray, Any]:
    """Read the Copernicus DEM window covering the buffered pilot area.

    Reads the window directly out of the Cloud Optimized GeoTIFF on the
    Registry of Open Data, so only the tiles actually needed cross the wire
    rather than the full 30MB raster.
    """
    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if config.DEM_CACHE.exists() and not refresh:
        # Both cached arrays are plain floats, so pickle support stays off.
        cached = np.load(config.DEM_CACHE, allow_pickle=False)
        transform = rasterio.Affine(*cached["transform"])
        print(f"  elevation: cached {cached['elevation'].shape}")
        return cached["elevation"], transform

    url = f"s3://{config.DEM_BUCKET}/{config.DEM_KEY}"
    print(f"  elevation: reading window from {url}")

    # The dataset is public, so requests must be unsigned. Any credentials
    # present in the environment would otherwise be sent and rejected.
    session = AWSSession(aws_unsigned=True, region_name=config.DEM_REGION)
    with rasterio.Env(session=session, AWS_NO_SIGN_REQUEST="YES"):
        with rasterio.open(url) as dataset:
            window = from_bounds(*_buffered_bbox(), transform=dataset.transform)
            elevation = dataset.read(1, window=window).astype("float32")
            transform = dataset.window_transform(window)
            nodata = dataset.nodata

    if nodata is not None:
        elevation[elevation == nodata] = np.nan

    np.savez_compressed(
        config.DEM_CACHE,
        elevation=elevation,
        transform=np.array(transform)[:6],
    )
    print(f"  elevation: {elevation.shape}, cached to {config.DEM_CACHE.name}")
    return elevation, transform


_OVERPASS_QUERY = """
[out:json][timeout:{timeout}];
(
  way["waterway"~"river|stream|drain|ditch|canal"]({south},{west},{north},{east});
  way["natural"="water"]({south},{west},{north},{east});
  way["landuse"="reservoir"]({south},{west},{north},{east});
);
out geom;
"""


def load_drainage(refresh: bool = False) -> list[dict[str, Any]]:
    """Fetch the drainage network from OpenStreetMap via the Overpass API.

    Returns GeoJSON-like geometries ready for rasterisation. The pilot bbox is
    small enough that Overpass is a better fit than parsing a country-wide
    .osm.pbf extract: no 30MB download, no pbf reader dependency.
    """
    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if config.DRAINAGE_CACHE.exists() and not refresh:
        geometries = json.loads(config.DRAINAGE_CACHE.read_text(encoding="utf-8"))
        print(f"  drainage: cached {len(geometries)} features")
        return geometries

    west, south, east, north = _buffered_bbox()
    query = _OVERPASS_QUERY.format(
        timeout=config.OVERPASS_TIMEOUT_SECONDS,
        west=west,
        south=south,
        east=east,
        north=north,
    )

    print("  drainage: querying Overpass...")
    response = requests.post(
        config.OVERPASS_ENDPOINT,
        data={"data": query},
        timeout=config.OVERPASS_TIMEOUT_SECONDS,
        headers={"User-Agent": "accra-flood-watch/0.1 (hackathon project)"},
    )
    response.raise_for_status()

    geometries: list[dict[str, Any]] = []
    for element in response.json().get("elements", []):
        points = element.get("geometry")
        if not points or len(points) < 2:
            continue
        coordinates = [[point["lon"], point["lat"]] for point in points]
        tags = element.get("tags", {})
        # Closed ways are water bodies; open ways are channels.
        is_area = coordinates[0] == coordinates[-1] and len(coordinates) > 3
        geometries.append(
            {
                "type": "Polygon" if is_area else "LineString",
                "coordinates": [coordinates] if is_area else coordinates,
                "kind": tags.get("waterway") or tags.get("natural") or "water",
            }
        )

    config.DRAINAGE_CACHE.write_text(json.dumps(geometries), encoding="utf-8")
    print(f"  drainage: {len(geometries)} features, cached")
    return geometries
