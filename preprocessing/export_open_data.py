"""Publish the terrain grid as open data.

The one thing this project knows that nobody else publishes is which specific
streets in the Odaw basin go under first. That is civic information, and it is
more useful to NADMO, to city planners and to researchers as a file they can
open in QGIS than as pixels inside somebody's phone.

Two artefacts, because two audiences:

  * ``terrain.json``     the grid as it is stored, keyed by geohash. Compact,
                         and the natural shape for anyone rebuilding this
                         model or joining it to their own cell data.
  * ``terrain.geojson``  one polygon per cell, which QGIS, ArcGIS, R and
                         GeoPandas all open with no code at all.

Both carry the same provenance block, because a number with no method behind
it is not open data -- it is a rumour with decimal places.

Run after ``build_susceptibility.py``::

    python export_open_data.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from geohashing import bounds

HERE = Path(__file__).parent
SOURCE = HERE / "output" / "susceptibility.json"
DESTINATION = HERE.parent / "web" / "public" / "open-data"

LICENCE = "CC-BY-4.0"
ATTRIBUTION = "Accra Flood Watch (Raymond Galley), terrain analysis from Copernicus DEM"

# What the numbers mean, shipped alongside them. Written for somebody who has
# never seen this repository and never will.
FIELD_NOTES = {
    "cell": "Geohash, precision 7. Roughly 152m x 152m.",
    "susceptibility": (
        "0-100. How readily this ground floods, from terrain alone. Combines "
        "height above nearest drainage, slope, and proximity to documented "
        "historical flood points. This is a STATIC property of the ground: it "
        "is not a forecast and does not change with the weather."
    ),
    "hand": (
        "Height Above Nearest Drainage, in metres. The dominant term. Ground "
        "at 0m is level with the nearest channel and floods first."
    ),
    "slope": "Degrees. Flat ground sheds water slowly.",
    "elevation": "Metres above sea level, from the Copernicus 30m DEM.",
    "historicalFloodPoint": (
        "Name of a documented flood location this cell contains, or null. "
        "These are places flooding has been RECORDED, not everywhere it has "
        "occurred -- absence is not evidence of safety."
    ),
}

CAVEATS = [
    "Susceptibility describes the ground, not today. It says which streets go "
    "under first when it rains, not whether they are under water now.",
    "Coverage is the Odaw basin only: Korle Lagoon north to Achimota. Cells "
    "outside it are absent, not safe.",
    "Derived from a 30m digital elevation model, so features narrower than "
    "that -- a single covered drain, a raised kerb -- are invisible to it.",
    "No community reports are included here. Those are personal-adjacent, "
    "self-delete after 24 hours, and are deliberately not published.",
]


def load_source() -> dict:
    if not SOURCE.exists():
        raise SystemExit(
            f"{SOURCE} not found. Run build_susceptibility.py first."
        )
    with SOURCE.open(encoding="utf-8") as handle:
        return json.load(handle)


def provenance(source: dict) -> dict:
    return {
        "title": "Accra Flood Watch — terrain flood susceptibility, Odaw basin",
        "exportedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generatedAt": source.get("generatedAt"),
        "licence": LICENCE,
        "attribution": ATTRIBUTION,
        "geohashPrecision": source.get("geohashPrecision"),
        "coveredAreas": source.get("coveredAreas"),
        "cellCount": source.get("cellCount"),
        "model": source.get("model"),
        "fields": FIELD_NOTES,
        "caveats": CAVEATS,
    }


def write_json(source: dict, cells: list[dict]) -> Path:
    payload = {**provenance(source), "cells": cells}
    path = DESTINATION / "terrain.json"
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    return path


def write_geojson(source: dict, cells: list[dict]) -> Path:
    features = []
    for cell in cells:
        west, south, east, north = bounds(cell["cell"])
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    # GeoJSON winds the exterior ring counter-clockwise and
                    # repeats the first point to close it.
                    "coordinates": [
                        [
                            [west, south],
                            [east, south],
                            [east, north],
                            [west, north],
                            [west, south],
                        ]
                    ],
                },
                "properties": {
                    "cell": cell["cell"],
                    "susceptibility": cell["susceptibility"],
                    "hand": cell["hand"],
                    "slope": cell["slope"],
                    "elevation": cell["elevation"],
                    "historicalFloodPoint": cell.get("historicalFloodPoint"),
                },
            }
        )

    payload = {
        "type": "FeatureCollection",
        # Non-standard but widely read, and the only place a GeoJSON file can
        # carry its own method description.
        "metadata": provenance(source),
        "features": features,
    }

    path = DESTINATION / "terrain.geojson"
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    return path


def write_readme(source: dict) -> Path:
    note = provenance(source)
    lines = [
        "# Accra Flood Watch — open data",
        "",
        f"Terrain flood susceptibility for the Odaw basin, Accra. **{note['cellCount']} cells** "
        f"at geohash precision {note['geohashPrecision']} (~152m).",
        "",
        f"Licence **{LICENCE}**. Attribute as: _{ATTRIBUTION}_.",
        "",
        "## Files",
        "",
        "| file | use |",
        "| --- | --- |",
        "| `terrain.geojson` | Open directly in QGIS, ArcGIS, R or GeoPandas. One polygon per cell. |",
        "| `terrain.json` | The grid keyed by geohash. Smaller, and the natural shape for joining to other cell data. |",
        "",
        "## What the fields mean",
        "",
    ]
    for field, meaning in FIELD_NOTES.items():
        lines.append(f"- **`{field}`** — {meaning}")

    lines += [
        "",
        "## Read this before using it",
        "",
    ]
    for caveat in CAVEATS:
        lines.append(f"- {caveat}")

    lines += [
        "",
        "## Method",
        "",
        "Susceptibility combines height above nearest drainage, slope and proximity",
        "to documented historical flood points, computed offline from the Copernicus",
        "30m DEM over the whole Odaw catchment. The catchment is modelled as one",
        "block rather than per-neighbourhood: HAND is measured against the nearest",
        "drainage, so cutting a catchment into pieces computes a wrong height for",
        "every cell near a cut.",
        "",
        "There is deliberately **no machine learning** anywhere in this model. No",
        "labelled dataset of Accra flooding at cell resolution exists to train or",
        "validate against, and a model that cannot be validated has no business",
        "telling somebody a road is passable.",
        "",
        "Live risk — the thing the app shows — combines this with rainfall forecasts",
        "and community reports. Only the static terrain layer is published here.",
        "",
    ]

    path = DESTINATION / "README.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def main() -> None:
    source = load_source()
    cells = source["cells"]
    DESTINATION.mkdir(parents=True, exist_ok=True)

    written = [
        write_json(source, cells),
        write_geojson(source, cells),
        write_readme(source),
    ]

    for path in written:
        size_kb = path.stat().st_size / 1024
        print(f"  {path.relative_to(HERE.parent)}  {size_kb:,.0f} KB")

    print(f"\n{len(cells):,} cells exported under {LICENCE}.")


if __name__ == "__main__":
    main()
