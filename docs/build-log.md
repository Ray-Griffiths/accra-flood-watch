# Build log

What was attempted each session, what failed, and what changed. Written as the
work happens rather than reconstructed afterwards.

---

## Day 0 — 2026-09-21 — Account preparation and setup

**Goal:** budget guardrail active, repository live, coding agent connected to AWS
with evidence captured. No application code until this is done.

### Coding agent connection to AWS

Claude Code (Opus 5) connected to AWS via the AWS CLI credential chain and the
AWS MCP server. Verified:

```
$ aws sts get-caller-identity
{
    "UserId": "AIDAU5LH5P47HEZI6H4PU",
    "Account": "337909743422",
    "Arn": "arn:aws:iam::337909743422:user/Ray"
}
```

The agent used the AWS MCP server's regional availability API to settle the
region choice rather than relying on its own training data — see below.

### Decisions taken

| Decision | Choice | Reasoning |
|---|---|---|
| Region | `eu-west-1` | ~90ms to Accra vs ~130ms from `us-east-1`. |
| Lambda runtime | Node.js 22 + TypeScript | Docker is not installed locally. |
| Frontend | Vite + vanilla TypeScript | Low-end Android constraint; no framework runtime. |
| Public URL | Default CloudFront domain | No DNS risk against a tight deadline. |
| Pilot area | Circle / Kaneshie / Avenor | High-traffic commuter corridor, well-documented flooding. |

### Two corrections to the project plan

The plan document was written before both of these and is wrong on them. Both
are now recorded in `CLAUDE.md` so they do not get re-introduced later.

**1. Amazon Location Service no longer uses the resource model.** The plan
describes creating a `Map`, a `PlaceIndex` and a `RouteCalculator`. The current
API is standalone: `GeoMaps`, `GeoPlaces`, `GeoRoutes`. `CalculateRoutes` takes
`Avoid.Areas` directly, which is precisely the mechanism the safe-routing
feature needs.

Checked availability through the AWS MCP server rather than assuming:

```
Geo Maps+GetTile,  Geo Places+SearchText,  Geo Routes+CalculateRoutes
  us-east-1     isAvailableIn
  eu-west-1     isAvailableIn
  eu-central-1  isAvailableIn
  eu-west-2     isAvailableIn
  af-south-1    (absent)
```

`af-south-1` (Cape Town) would have been the nearest region to Accra, but it has
no Location Service. That finding is what settled the region on `eu-west-1`.

**2. No Docker locally, which decides the Lambda language.** Web push requires
VAPID signing. In Python that means the `cryptography` package, which has native
wheels and would need a container build or a hand-built Lambda layer. Node's
`web-push` uses built-in crypto with zero native dependencies, and SAM bundles
TypeScript with esbuild without Docker. The Python preprocessing notebook is
unaffected — it runs locally and never deploys.

### Done

- AWS Budget `AFW-Monthly`, $25/month, alerts at 40% ($10 actual), 100% ($25
  actual) and 100% forecasted → `rggalley1@gmail.com`. Verified via
  `describe-notifications-for-budget`. `IncludeCredit: false`, so alerts fire on
  gross spend and signup credits cannot mask a runaway cost.
- Repository created: `github.com/Ray-Griffiths/accra-flood-watch`, public.
- `CLAUDE.md` written: locked decisions, plan corrections, and the safety,
  privacy, cost and IAM rules that must not be violated.
- SAM CLI 1.166.2 installed.

---

## Day 1 — 2026-09-21 — Skeleton deployment (the ship gate)

**Goal:** a live public HTTPS URL on AWS before any feature work. Shipping is
pass-or-fail; everything after this improves something already shipping.

### Built

- `template.yaml` — S3 (block all public access, OAC, versioned) → CloudFront →
  API Gateway HTTP API → one Lambda. Log groups at 7-day retention from the
  first line rather than added later.
- `backend/` — Node 22 + TypeScript, arm64, esbuild-bundled. `GET /api/health`.
- `web/` — Vite + vanilla TS PWA shell, manifest, service worker, icon.
- `scripts/deploy-web.ps1` — two-pass S3 upload so hashed assets get a year of
  immutable caching while `index.html` and the service worker get `no-cache`.
- `samconfig.toml` — written by hand rather than via `sam deploy --guided`, so
  every deploy is non-interactive and reproducible.

### Design notes

**The API is served under `/api/*` on the same CloudFront distribution.** The
browser therefore makes same-origin calls and no CORS preflight ever happens.
It also means the API and the app share one hostname, so there is no second
origin to configure, certificate, or leak in page source.

**The service worker deliberately does not cache `/api/*`.** Stale risk data
shown without a staleness label is worse than no data. Cached risk data with an
explicit "last updated" label arrives with the map, not before.

### Failures and fixes

**`sam build` — "Cannot find esbuild".** SAM's `NodejsNpmEsbuildBuilder` copies
the source to a scratch directory and runs a production-only `npm install`,
which omits `devDependencies`. esbuild was a devDependency, so the builder could
not see it. Moved `esbuild` to `dependencies`. This does not bloat the Lambda
package — with `BuildMethod: esbuild`, SAM ships only the bundled output, not
`node_modules`. Build succeeded on retry.

**`vite build` — `TS2591: Cannot find name 'process'`.** `vite.config.ts` reads
`process.env.VITE_API_ORIGIN` for the dev proxy, but `@types/node` was absent
and `types` in `tsconfig.json` did not list `node`. Added both. Build then
produced 0.88 kB gzipped JS, which comfortably serves the low-end-device
constraint the plan sets.

### Shipped

Stack `accra-flood-watch` reached `CREATE_COMPLETE` in `eu-west-1`, 11 resources.

**Live URL: https://d227oixun34mjp.cloudfront.net**

Verified end to end:

| Check | Result |
|---|---|
| `GET /` | `200`, `cache-control: no-cache, must-revalidate` |
| `GET /api/health` | `200`, `{"status":"ok","region":"eu-west-1",...}` |
| `Strict-Transport-Security` | `max-age=31536000` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| Direct S3 object request | `403` — reachable only via CloudFront OAC |

The ship gate is satisfied on day one. Everything from here improves something
that is already shipping.

---

## Day 2 — 2026-09-21 — Terrain preprocessing

**Goal:** turn open elevation data into a per-cell susceptibility grid and load
it into DynamoDB.

**Resolution decided: geohash-7** (~152m × 152m, 1,140 cells over the pilot
bbox). Geohash-6 would have given only ~35 cells at 1.2km × 0.61km — too coarse
to read as a street-level overlay. This is baked into every partition key.

### Data acquired

| Input | Result |
|---|---|
| Copernicus DEM 30m, `copernicus-dem-30m` (Registry of Open Data, `eu-central-1`) | 252 × 288 window @ 30.8m, elevation 0–69.6m, median 23.8m, zero nodata |
| OpenStreetMap drainage via Overpass | 1,104 features — 933 drains, 150 ditches, 7 river, 4 stream, 1 canal, 9 water bodies |

The DEM window is read straight out of the COG, so only the needed tiles cross
the wire rather than the full 30MB raster. The plan's claim that OSM coverage
of Accra drains is good turned out to be correct.

### Bug found and fixed: HAND was being measured on the water

First run produced a useless map — 38% of cells scored 80–100, median 61. A map
where most of the neighbourhood is dark red carries no information, and users
stop reading it. This is the same failure the plan identifies for notifications:
*"an application that notifies too often is muted, and a muted application saves
nobody."*

`calibration_report.py` showed HAND at p25 = **0.00**. The cause: HAND is zero
*at* the drainage network by definition, and drainage covers 5.2% of pixels. A
cell of ~25 pixels crossed by a drain therefore has ~3 zero-valued pixels, which
drags the 10th percentile to zero and scores the cell at maximum susceptibility.

**Every cell containing a drain was being painted as maximally dangerous.** That
inverts the meaning of the measure. A drain is where water *goes*; ground beside
a working drain may be perfectly safe.

Fix: exclude drainage pixels from the per-cell HAND statistic, falling back to
all pixels only where a cell has fewer than 3 land pixels (4 cells, all channel).

Second, smaller fix: measured slope spans only 1.3°–3.7° between p10 and p90,
entirely below the 6° free-draining threshold — so the slope term contributed a
near-constant ~18 points to every cell instead of discriminating. Threshold
lowered to 4°.

| Distribution | Before | After |
|---|---|---|
| low (0–40) | 38.5% | 41.5% |
| watch (40–60) | 10.6% | 12.1% |
| high (60–80) | 12.7% | 20.9% |
| very high (80+) | **38.2%** | **25.5%** |

### Honest limitation

HAND p25 is still 0.00 after the fix, and that residue is real rather than a
bug: a 30m DEM cannot resolve a 3m concrete gutter, so in flat densely-drained
terrain HAND degenerates toward "height above nearby ground". The measure still
separates the Odaw floodplain from higher ground, but it cannot distinguish one
street from the next within a flat block. Documented in `preprocessing/README.md`
rather than tuned away.

### Historical flood points — UNVERIFIED

8 locations encoded from general knowledge of Accra's flood geography, not from
a NADMO report or published dataset. The places are real and well-attested; the
coordinates are approximate and some may be off by a block.

Each raises its cell to at least 75, **overriding the terrain model**, so a wrong
coordinate paints a false warning onto a street that does not flood. All are
flagged `verified: False` and the build prints a warning for each. **These must
be checked against NADMO sources before the pilot goes live.**

### Shipped

- Three DynamoDB tables added to the template, all partitioned by geohash cell.
  `Reports` carries TTL on `expiresAt`, point-in-time recovery, and
  `DeletionPolicy: Retain` — a stack delete must never take community reports
  with it.
- 1,140 cells seeded. Verified: Kwame Nkrumah Circle (`ebzzeq0`) reads HAND
  0.57m at 12.7m elevation, susceptibility 76.5.
- `sam validate --lint` findings actioned: explicit `SSESpecification` on all
  three tables (AWS-owned key — encrypted at rest at no cost; an AWS-managed KMS
  key would add charges for no benefit on non-personal data), explicit
  deletion policies, and a `DenyUnencryptedTransport` statement on the bucket.
- 13 geohash tests passing, including the canonical `u4pruydqqvj` reference
  vector and coverage checks for points inside and outside the pilot boundary.

### Next

- DEM-derived risk overlay on the map (MapLibre + Amazon Location GeoMaps).
- `getRisk` / `getReports` handlers reading the seeded grid.
- Then: one-tap reporting, hourly scoring, notifications, safe routing.

---

## Day 3 — 2026-09-21 — The map, the risk overlay and one-tap reporting

### Shipped

The public URL now shows the thing the project is actually for: a street-level
flood risk map of Circle, Kaneshie and Avenor, with a two-tap water depth
report and a plain-language explanation behind every cell.

- **Backend deployed.** `getRisk`, `getReports`, `submitReport` and `getConfig`
  are live behind CloudFront. All 24 backend tests pass; `tsc --noEmit` clean.
- **Tables migrated to the geohash-prefix key schema.** The deploy replaced all
  three (the explicit `TableName` was removed precisely so this could happen),
  and the 1,140 terrain cells were re-seeded into the new `RiskCells` table.
- **Map overlay** — MapLibre GL over Amazon Location GeoMaps, risk cells drawn
  as polygons beneath the basemap's label layers so street names stay readable
  through the overlay.
- **Two-tap reporting** with device geolocation, falling back to the map centre
  when the permission is refused rather than dead-ending.
- **Edge tile caching verified working** (see below).

### Verified end to end, against production

| Check | Result |
|---|---|
| `GET /api/health` | `status: ok` |
| `GET /api/risk?bbox=` | 1,140-cell grid, terrain scores + explanations |
| `POST /api/reports` valid | `201`, `level: reported` |
| `POST /api/reports` ×2 same cell | `201`, `level: confirmed`, `recentReports: 2` |
| `POST /api/reports` outside pilot area | `422` with a sentence, not a stack trace |
| `POST /api/reports` bad depth | `400` |
| Tile via CloudFront `/v2/*` | `200`, `x-cache: Hit from cloudfront` |

The confirmation override works as specified: two independent reports within
three hours set `confirmed` regardless of the computed score.

### The tile-cost bug that would have gone unnoticed

The Amazon Location style descriptor returns **absolute**
`maps.geo.eu-west-1.amazonaws.com` URLs for tiles, glyphs and sprites. Left
alone, every tile request would have gone straight to Amazon Location and
bypassed the CloudFront cache behaviour entirely — the single most expensive
line item in the system, silently uncached, and nothing would have looked
broken.

Fixed with a `transformRequest` that rewrites every Amazon Location URL back to
this origin. Confirmed: repeat tile requests now return
`x-cache: Hit from cloudfront`.

The same rewrite made the tiles same-origin, which meant the service worker's
cache-first branch would have started caching tiles without bound. `/v2/*` is
now excluded from it alongside `/api/*`. Full offline tile caching is out of
scope; the edge is where tile caching belongs.

### MapLibre GL v6 does not work with this style — pinned to v5

`maplibre-gl@6.10.0` never fires `load` and never requests a single tile
against the Amazon Location Standard style. The style parses (160 layers, the
source resolves, `_sourceLoaded: true`, WebGL2 context live, no errors on any
channel) but the covering-tile computation never produces anything, so no tile
or glyph request is ever made and the canvas is never painted.

It reproduces with the stock MapLibre demo style and with no custom map options
at all, so it is not this project's code, the AWS style, or the API key.

**`maplibre-gl@5.24.0` renders correctly.** Pinned to `^5.24.0`.

A false lead cost time and is worth recording: after downgrading, Vite kept
serving its cached v6 pre-bundle from an already-running dev server, so the
first "v5 also fails" and "the demo style also fails" results were both
measured against v6. The giveaway was `map.transform` being `undefined` — a v6
API shape — while `node_modules` held v5. **When bisecting a dependency under
Vite, restart the dev server and clear `node_modules/.vite`, then assert the
version from inside the page before trusting any result.**

### Accessibility, deliberately

Risk levels are encoded three independent ways, because a map whose only
warning channel is hue fails exactly the people it was built for — outdoors, in
glare, possibly colour-blind:

- colour (lightness-ordered, so the ramp survives deuteranopia),
- **texture** — sparse dots, diagonal hatch, cross-hatch, solid — generated to a
  canvas at load time and registered as fill patterns,
- **the word itself**, on the cell and in the legend.

The legend repeats the map's own texture rather than showing a plain colour
chip, so it teaches the pattern and not only the colour.

### Honest state

- The status banner reads **"Terrain only — no rainfall forecast yet."** and
  will keep saying so until the hourly scoring job exists. What is on screen is
  terrain susceptibility, and presenting it as a live forecast would overstate
  what the map knows.
- The 8 historical flood points remain **unverified** and still override the
  terrain model in their cells. Unchanged from Day 2; still to be checked
  against NADMO sources.
- Test reports created during verification were deleted from the `Reports`
  table afterwards. A fake "impassable" at Circle is precisely the false
  warning this project must never display.
- The pre-migration `accra-flood-watch-reports` table was retained by
  `DeletionPolicy: Retain` and is now an empty orphan. Harmless and free, but
  it should be deleted by hand.
- Bundle is 291 kB gzipped, nearly all MapLibre. Heavy for a low-end Android on
  a poor connection, and the most obvious next optimisation.

### Next

- Hourly `scoreRisk` job: forecast rainfall, real scores, the `updatedAt` the
  interface is already prepared to display.
- `saveWatch` and web push for saved locations.
- `calculateSafeRoute` with `GeoRoutes.CalculateRoutes` and `Avoid.Areas`.
