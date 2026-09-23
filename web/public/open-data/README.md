# Accra Flood Watch — open data

Terrain flood susceptibility for the Odaw basin, Accra. **5100 cells** at geohash precision 7 (~152m).

Licence **CC-BY-4.0**. Attribute as: _Accra Flood Watch (Raymond Galley), terrain analysis from Copernicus DEM_.

## Files

| file | use |
| --- | --- |
| `terrain.geojson` | Open directly in QGIS, ArcGIS, R or GeoPandas. One polygon per cell. |
| `terrain.json` | The grid keyed by geohash. Smaller, and the natural shape for joining to other cell data. |

## What the fields mean

- **`cell`** — Geohash, precision 7. Roughly 152m x 152m.
- **`susceptibility`** — 0-100. How readily this ground floods, from terrain alone. Combines height above nearest drainage, slope, and proximity to documented historical flood points. This is a STATIC property of the ground: it is not a forecast and does not change with the weather.
- **`hand`** — Height Above Nearest Drainage, in metres. The dominant term. Ground at 0m is level with the nearest channel and floods first.
- **`slope`** — Degrees. Flat ground sheds water slowly.
- **`elevation`** — Metres above sea level, from the Copernicus 30m DEM.
- **`historicalFloodPoint`** — Name of a documented flood location this cell contains, or null. These are places flooding has been RECORDED, not everywhere it has occurred -- absence is not evidence of safety.

## Read this before using it

- Susceptibility describes the ground, not today. It says which streets go under first when it rains, not whether they are under water now.
- Coverage is the Odaw basin only: Korle Lagoon north to Achimota. Cells outside it are absent, not safe.
- Derived from a 30m digital elevation model, so features narrower than that -- a single covered drain, a raised kerb -- are invisible to it.
- No community reports are included here. Those are personal-adjacent, self-delete after 24 hours, and are deliberately not published.

## Method

Susceptibility combines height above nearest drainage, slope and proximity
to documented historical flood points, computed offline from the Copernicus
30m DEM over the whole Odaw catchment. The catchment is modelled as one
block rather than per-neighbourhood: HAND is measured against the nearest
drainage, so cutting a catchment into pieces computes a wrong height for
every cell near a cut.

There is deliberately **no machine learning** anywhere in this model. No
labelled dataset of Accra flooding at cell resolution exists to train or
validate against, and a model that cannot be validated has no business
telling somebody a road is passable.

Live risk — the thing the app shows — combines this with rainfall forecasts
and community reports. Only the static terrain layer is published here.
