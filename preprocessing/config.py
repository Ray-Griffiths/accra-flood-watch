"""Configuration for the terrain preprocessing pipeline.

Everything that defines the shape of the output grid lives here, so that
changing the pilot area or the cell resolution is a one-file edit.
"""

from pathlib import Path

# ---------------------------------------------------------------------------
# Pilot area: Circle / Kaneshie / Avenor, Accra.
# ---------------------------------------------------------------------------
# (west, south, east, north) in WGS84 degrees.
PILOT_BBOX = (-0.245, 5.550, -0.195, 5.590)

# Drainage just outside the pilot area still drains it, and a DEM window cut
# exactly to the boundary would compute a wrong HAND for every edge cell.
BUFFER_DEGREES = 0.015

# Geohash precision. 7 gives ~152m x 152m cells and roughly 1,100 cells over
# the pilot bbox. Precision 6 would give ~1.2km x 0.61km and only ~35 cells,
# which is too coarse to read as a street-level map overlay.
#
# This value is baked into every DynamoDB partition key. Changing it after
# reports exist means migrating the Reports table.
GEOHASH_PRECISION = 7

# ---------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------
# Copernicus DEM 30m, Registry of Open Data on AWS. Public, no credentials.
# The tile covering Accra is N05/W001 (1-degree tiles, named by SW corner).
DEM_BUCKET = "copernicus-dem-30m"
DEM_REGION = "eu-central-1"
DEM_TILE = "Copernicus_DSM_COG_10_N05_00_W001_00_DEM"
DEM_KEY = f"{DEM_TILE}/{DEM_TILE}.tif"

OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT_SECONDS = 180

# ---------------------------------------------------------------------------
# Susceptibility model
# ---------------------------------------------------------------------------
# Height Above Nearest Drainage dominates: it is the strongest single physical
# predictor of where water collects. Slope is a secondary term because flat
# ground drains slowly even when it is not especially low-lying.
WEIGHT_HAND = 0.70
WEIGHT_SLOPE = 0.30

# HAND in metres at which susceptibility has decayed to ~37% of maximum.
# Accra's flood-prone ground sits within a few metres of its drains, so the
# curve must be steep to discriminate usefully at this scale.
HAND_DECAY_METRES = 4.0

# Slope in degrees at or above which terrain is treated as freely draining.
# Accra is nearly flat: measured slope across the pilot area runs from about
# 1.3 to 3.6 degrees between the 10th and 90th percentile. A threshold of 6
# sat above that entire range, so the slope term contributed a near-constant
# offset to every cell instead of discriminating between them.
SLOPE_FREE_DRAINING_DEGREES = 4.0

# Within a cell, take a conservative low percentile of HAND so that a cell
# containing a low-lying pocket is not disguised by surrounding high ground.
HAND_PERCENTILE = 10

# Drainage pixels are excluded from the per-cell HAND statistic. HAND is zero
# *at* the drainage network by definition, so including those pixels dragged
# the low percentile to zero for every cell a drain passed through and scored
# it at maximum susceptibility. That inverts the meaning of the measure: a
# drain is where water goes, and ground beside a working drain may be safe.
# HAND is only meaningful for the ground people actually stand on.
MIN_LAND_PIXELS_PER_CELL = 3

# A cell containing a documented historical flood point cannot score below
# this, whatever the terrain says. Observed reality outranks the proxy.
HISTORICAL_POINT_FLOOR = 75.0
# Immediate neighbours of such a cell get a softer floor: flooding spreads.
HISTORICAL_NEIGHBOUR_FLOOR = 55.0

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).parent
CACHE_DIR = ROOT / "data"
OUTPUT_DIR = ROOT / "output"
DRAINAGE_CACHE = CACHE_DIR / "drainage.json"
DEM_CACHE = CACHE_DIR / "dem_window.npz"
SUSCEPTIBILITY_OUTPUT = OUTPUT_DIR / "susceptibility.json"
