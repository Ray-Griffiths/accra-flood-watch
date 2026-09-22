"""Documented recurring flood locations in the covered area.

Each verified point raises its cell's susceptibility to at least 75 and its
neighbours to at least 55, overriding the terrain model. A wrong coordinate
therefore paints a false warning onto a street that does not flood, which
costs user trust exactly where the application needs it most.

Because of that, only points with ``verified: True`` are applied.
``build_susceptibility.py`` lists the unverified ones and passes them over.
That is the whole purpose of the flag: it used to print a warning and then
apply the point anyway, which meant a coordinate somebody had guessed carried
exactly the same weight as one that had been checked.

The verification standard
-------------------------
A point is marked verified only when both hold:

1. **The place is documented as flooding** by a source that is not this
   project -- national press, a municipal drainage programme, or published
   research.
2. **The coordinate is corroborated by two independent geographic sources**
   (OpenStreetMap via Nominatim, and Amazon Location GeoPlaces) that agree
   with each other, and the stored value sits within roughly one grid cell
   (152m) of that agreement.

Criterion 2 is the one that failed. Of the eight points originally encoded
from general knowledge, five had coordinates far enough out to land in a
different geohash cell from the real place -- Kwame Nkrumah Circle by about
870m, Alajo by about 1.4km. The places were right; the map pins were not.

Verified 2026-09-22 against the sources recorded on each entry. Coordinates
are stored to four decimals (~11m), which is finer than the agreement between
sources justifies; the honest precision is the grid cell.
"""

from __future__ import annotations

from typing import TypedDict


class FloodPoint(TypedDict):
    name: str
    latitude: float
    longitude: float
    note: str
    verified: bool
    # What established this entry. Empty for unverified points. "Verified"
    # with no record of what verified it is only marginally better than
    # unverified, because nobody else can re-check it.
    sources: list[str]


# Ordered roughly north to south along the Odaw corridor.
HISTORICAL_FLOOD_POINTS: list[FloodPoint] = [
    {
        "name": "Alajo",
        "latitude": 5.5937,
        "longitude": -0.2169,
        "note": (
            "Odaw channel constriction upstream of Circle. Listed among the "
            "highest flood-risk areas in Accra; perennial flooding."
        ),
        "verified": True,
        "sources": [
            # Coordinate: OSM admin centroid 5.59370,-0.21690; Amazon Location
            # GeoPlaces "Alajo Road" 5.59771,-0.21137. The previous value
            # (5.5820,-0.2115) was ~1.4km south of both. The corrected point
            # is 15m from mapped drainage and 134m from the Odaw, against
            # 271m and 731m before -- which is what an Odaw constriction
            # should look like.
            "OpenStreetMap/Nominatim + Amazon Location GeoPlaces (coordinate)",
            "https://www.sciencedirect.com/science/article/pii/S2665972723000636",
            "https://ghanaiantimes.com.gh/another-june-another-flood-what-the-maps-have-been-telling-us-all-along/",
        ],
    },
    {
        "name": "Avenor",
        "latitude": 5.5777,
        "longitude": -0.2186,
        "note": (
            "Low-lying ground beside the Odaw; recurrent road flooding. "
            "Documented as plagued by perennial flooding."
        ),
        "verified": True,
        "sources": [
            # Coordinate: OSM admin centroid 5.57769,-0.21863, 134m from the
            # original value -- inside one cell, so a refinement rather than a
            # correction. Named "Avenor junction" before; the neighbourhood is
            # what the sources corroborate, so that is what it now claims.
            "OpenStreetMap/Nominatim + Amazon Location GeoPlaces (coordinate)",
            "https://www.sciencedirect.com/science/article/pii/S2665972723000636",
        ],
    },
    {
        "name": "Kwame Nkrumah Circle",
        "latitude": 5.5696,
        "longitude": -0.2153,
        "note": (
            "Site of the 3 June 2015 flood and fire disaster, 154 dead. The "
            "Odaw runs past it; listed among the highest flood-risk areas in "
            "Accra."
        ),
        "verified": True,
        "sources": [
            # Coordinate: four OSM highway segments named "Kwame Nkrumah
            # Circle" cluster at 5.5692-5.5699, -0.2151 to -0.2158; Amazon
            # Location GeoPlaces "Nkrumah Circle" 5.56958,-0.21516 agrees.
            #
            # The previous value (5.5709,-0.2074) was ~870m east-north-east.
            # Two independent checks caught it: the gazetteers agreed with
            # each other and not with it, and the cached drainage puts the old
            # point 1,176m from the nearest mapped river where the corrected
            # one is 302m -- and this is a place defined by sitting beside the
            # Odaw.
            #
            # Amazon Location also returns a second, unrelated "Kwame Nkrumah
            # Circle" at 5.58555,-0.20614 that OSM does not corroborate. One
            # geocoder was not enough here.
            "OpenStreetMap/Nominatim + Amazon Location GeoPlaces (coordinate)",
            "https://www.citinewsroom.com/2025/06/june-3-disaster-ghana-marks-10-years-since-deadly-flood-and-fire/",
            "https://en.wikipedia.org/wiki/2015_Accra_explosion",
        ],
    },
    {
        "name": "Kaneshie market frontage",
        "latitude": 5.5644,
        "longitude": -0.2343,
        "note": (
            "Market ground floods; traders lose stock. The Kaneshie lorry "
            "station area is among the highest flood-risk areas in Accra."
        ),
        "verified": True,
        "sources": [
            # Coordinate: OSM "Kaneshie Market" stop on Dr. Busia High Street
            # 5.56444,-0.23430; Amazon Location GeoPlaces "Kaneshie Market"
            # 5.566,-0.23666. Those two sit ~270m apart, so this point is good
            # to about two cells rather than one -- the weakest of the
            # verified set, and the first to recheck on the ground.
            "OpenStreetMap/Nominatim + Amazon Location GeoPlaces (coordinate)",
            "https://ghanaiantimes.com.gh/kaneshie-flooding-major-drainage-works-begin/",
            "https://www.adomonline.com/heavy-downpour-leaves-kaneshie-and-other-parts-of-accra-flooded-video/",
        ],
    },
    {
        "name": "Obetsebi Lamptey Circle",
        "latitude": 5.5612,
        "longitude": -0.2293,
        "note": (
            "Interchange submerged in heavy rain. NOTE: the 2022 interchange "
            "works integrated new storm drainage here, so the historical "
            "record may overstate current risk."
        ),
        "verified": True,
        "sources": [
            # Coordinate: three OSM highway segments at ~5.5612,-0.2293;
            # Amazon Location GeoPlaces 5.5615,-0.22938. Previous value was
            # ~250m east: right latitude, wrong longitude.
            "OpenStreetMap/Nominatim + Amazon Location GeoPlaces (coordinate)",
            "https://ghanaiantimes.com.gh/saturday-downpour-in-accra-obetsebi-lamptey-circle-submerged-residents-shop-owners-drivers-want-work-to-speed-up/",
        ],
    },
    # ------------------------------------------------------------------
    # Below here: real places with documented flooding, but coordinates that
    # could not be corroborated. Carried as candidates and NOT applied to the
    # grid. Each needs a local check, not another search.
    # ------------------------------------------------------------------
    {
        "name": "Kaneshie First Light",
        "latitude": 5.5640,
        "longitude": -0.2318,
        "note": (
            "Road flooding on the Dr Busia Highway approach. The flooding is "
            "well documented -- the AMA is building an underground drain here "
            "specifically to stop it -- but neither gazetteer carries 'First "
            "Light' as a feature, so the pin cannot be placed. The nearest "
            "corroborated anchor is the Kaneshie centroid, 411m away."
        ),
        "verified": False,
        "sources": [],
    },
    {
        "name": "Odaw channel at Circle",
        "latitude": 5.5690,
        "longitude": -0.2100,
        "note": (
            "Main drain; overtops when silted. Not applied: the stored point "
            "is 876m from the nearest mapped river and sits on a side drain, "
            "and with Kwame Nkrumah Circle corrected this would double-count "
            "the same ground ~300m away. HAND already knows where the channel "
            "runs; that is what the terrain model is for."
        ),
        "verified": False,
        "sources": [],
    },
    {
        "name": "Lartebiokorshie drain",
        "latitude": 5.5565,
        "longitude": -0.2360,
        "note": (
            "Drain backs up into adjacent residential streets. No source "
            "found documenting this specific drain, and the coordinate is "
            "~1km from the OSM Lartebiokorshie centroid with no agreement "
            "between sources. Both the claim and the pin need a local check."
        ),
        "verified": False,
        "sources": [],
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


def points_in_areas(
    areas: list[tuple[str, str, tuple[float, float, float, float]]],
) -> list[FloodPoint]:
    """Historical points falling inside any covered area.

    Deliberately not a check against the envelope of the areas: with disjoint
    areas a point can sit between two of them, and a point applied to a cell
    that does not exist raises susceptibility on nothing at all.
    """
    seen: set[tuple[float, float]] = set()
    collected: list[FloodPoint] = []
    for _, _, bbox in areas:
        for point in points_in_bbox(bbox):
            key = (point["latitude"], point["longitude"])
            if key in seen:
                continue
            seen.add(key)
            collected.append(point)
    return collected


def verified(points: list[FloodPoint]) -> list[FloodPoint]:
    """Points corroborated well enough to override the terrain model."""
    return [point for point in points if point["verified"]]


def unverified(points: list[FloodPoint]) -> list[FloodPoint]:
    """Points carried as candidates but not applied to the grid."""
    return [point for point in points if not point["verified"]]
