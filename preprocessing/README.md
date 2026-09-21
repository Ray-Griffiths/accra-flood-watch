# Terrain preprocessing

Builds the static flood susceptibility grid that the risk model sits on top of.

Runs **once, locally, offline**. Nothing here is deployed — raster processing is
the wrong shape of work for a request handler. The output is a JSON artefact
that `seed_risk_cells.py` loads into the `RiskCells` table.

## Running it

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt

.venv/Scripts/python build_susceptibility.py      # --refresh to re-fetch sources
.venv/Scripts/python seed_risk_cells.py           # --dry-run to inspect first

.venv/Scripts/python -m pytest                    # geohash tests
.venv/Scripts/python calibration_report.py        # score distribution diagnostic
```

Elevation and drainage are cached in `data/` after the first fetch, so tuning
the model does not re-download a 30MB raster or re-hit a free community API.

## What it does

1. **Elevation** — reads a window of the Copernicus DEM (30m) straight out of
   the Cloud Optimized GeoTIFF on the Registry of Open Data, so only the tiles
   needed cross the wire. Reading in-region means no egress charge and no
   multi-gigabyte download over a domestic connection.
2. **Drainage** — queries OpenStreetMap via Overpass for waterways, drains,
   ditches, canals and water bodies. The pilot bbox is small enough that this
   beats parsing a country-wide `.osm.pbf`. Accra returns ~1,100 features,
   mostly drains — OSM coverage here is genuinely good.
3. **HAND** — Height Above Nearest Drainage: the vertical drop from each pixel
   to the nearest drainage pixel. Low value means water arriving nearby has
   very little downhill to travel before it reaches you.
4. **Slope** — flat ground drains slowly even when it is not especially low.
5. **Aggregation** — pixels are bucketed into geohash-7 cells (~152m). The cell
   takes the **10th percentile** of HAND, so a cell containing a low-lying
   pocket is not disguised by surrounding high ground.
6. **Historical points** — documented flood locations raise their cell to at
   least 75 and neighbours to at least 55. Observed reality outranks the proxy.

## Why HAND

It is a well-established hydrological proxy, computable from free data, needs
no historical flood records to calibrate, and explains itself to a
non-technical user in one sentence. Those four properties together are what
make it right for a two-week build, in a way that a hydrodynamic flood model,
however accurate, is not.

## Known limitations

State these honestly in the submission rather than hiding them.

- **30m DEM cannot resolve urban drainage.** A 3m concrete gutter does not
  appear in a 30m pixel. In flat, densely-drained terrain like central Accra,
  HAND consequently degenerates toward "height above nearby ground", and about
  a quarter of cells land at HAND ≈ 0. The measure still separates the Odaw
  floodplain from higher ground, but it cannot distinguish one street from the
  next within a flat block.
- **Euclidean nearest drainage, not flow routing.** This matches the definition
  the project works from, and full flow accumulation would not survive the 30m
  resolution anyway — but it means HAND here ignores which way water actually
  flows.
- **Slope barely discriminates.** Measured slope across the pilot area runs
  ~1.3°–3.7° between the 10th and 90th percentile. The threshold was lowered
  from 6° to 4° so the term contributes signal rather than a constant offset,
  but it remains the weaker of the two inputs.
- **Historical flood points are unverified.** See below.

## ⚠️ Historical flood points need verification

`flood_points.py` contains 8 locations encoded from general knowledge of
Accra's flood geography — **not** read off a NADMO report or a published
dataset. The places are real and well-attested as flood-prone; the coordinates
are approximate and some may be off by a block.

Every entry is flagged `verified: False`, and `build_susceptibility.py` prints
a warning for each one it uses.

This matters: a historical point raises its cell to at least 75, **overriding
the terrain model**. A wrong coordinate paints a false warning onto a street
that does not flood, which costs user trust exactly where the application needs
it most. Verify each against NADMO incident reports, published research on the
Odaw basin, and news coverage of past events, then flip the flag.

## Files

| File | Role |
|---|---|
| `config.py` | Pilot bbox, geohash precision, model weights and thresholds |
| `geohashing.py` | Geohash encode/bounds/neighbours, no dependency |
| `sources.py` | Copernicus DEM window and Overpass drainage, both cached |
| `terrain.py` | HAND and slope on the DEM grid |
| `flood_points.py` | Historical flood locations ⚠️ unverified |
| `build_susceptibility.py` | Orchestrator → `output/susceptibility.json` |
| `seed_risk_cells.py` | Loads the artefact into DynamoDB |
| `calibration_report.py` | Score distribution diagnostic |
| `test_geohashing.py` | Geohash tests, incl. the canonical reference vector |
