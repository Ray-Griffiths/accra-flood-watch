"""Documented recurring flood locations in the pilot area.

>>> THESE COORDINATES NEED VERIFICATION BEFORE THE PILOT GOES LIVE. <<<

They were encoded from general knowledge of Accra's flood geography, not read
off a NADMO report or a published dataset. The locations are real and
well-attested as flood-prone; the coordinates are approximate and some may be
off by a block.

Every entry carries `verified: False`. Check each against NADMO incident
reports, published research on the Odaw basin, and news coverage of past
events, then flip the flag. `build_susceptibility.py` prints a warning for
every unverified point it uses, so this cannot be forgotten silently.

This matters more than it looks: a historical point raises its cell's
susceptibility to at least 75, overriding the terrain model. A wrong
coordinate therefore paints a false warning onto a street that does not
flood, which costs user trust exactly where the application needs it most.
"""

from __future__ import annotations

from typing import TypedDict


class FloodPoint(TypedDict):
    name: str
    latitude: float
    longitude: float
    note: str
    verified: bool


# Ordered roughly north to south along the Odaw corridor.
HISTORICAL_FLOOD_POINTS: list[FloodPoint] = [
    {
        "name": "Avenor junction",
        "latitude": 5.5765,
        "longitude": -0.2185,
        "note": "Low-lying ground beside the Odaw; recurrent road flooding.",
        "verified": False,
    },
    {
        "name": "Alajo bridge approach",
        "latitude": 5.5820,
        "longitude": -0.2115,
        "note": "Odaw channel constriction upstream of Circle.",
        "verified": False,
    },
    {
        "name": "Kwame Nkrumah Circle underpass",
        "latitude": 5.5709,
        "longitude": -0.2074,
        "note": "Site of the 3 June 2015 flood and fire disaster.",
        "verified": False,
    },
    {
        "name": "Odaw channel at Circle",
        "latitude": 5.5690,
        "longitude": -0.2100,
        "note": "Main drain; overtops when silted during heavy rain.",
        "verified": False,
    },
    {
        "name": "Obetsebi Lamptey Circle",
        "latitude": 5.5612,
        "longitude": -0.2272,
        "note": "Known ponding at the interchange during storms.",
        "verified": False,
    },
    {
        "name": "Kaneshie First Light",
        "latitude": 5.5640,
        "longitude": -0.2318,
        "note": "Road flooding on the Winneba road approach.",
        "verified": False,
    },
    {
        "name": "Kaneshie market frontage",
        "latitude": 5.5622,
        "longitude": -0.2334,
        "note": "Market ground floods; traders lose stock.",
        "verified": False,
    },
    {
        "name": "Lartebiokorshie drain",
        "latitude": 5.5565,
        "longitude": -0.2360,
        "note": "Drain backs up into adjacent residential streets.",
        "verified": False,
    },
]


def points_in_bbox(
    bbox: tuple[float, float, float, float],
) -> list[FloodPoint]:
    """Historical points falling inside the given bounding box."""
    west, south, east, north = bbox
    return [
        point
        for point in HISTORICAL_FLOOD_POINTS
        if west <= point["longitude"] <= east and south <= point["latitude"] <= north
    ]


def unverified(points: list[FloodPoint]) -> list[FloodPoint]:
    """Points still awaiting verification against an authoritative source."""
    return [point for point in points if not point["verified"]]
