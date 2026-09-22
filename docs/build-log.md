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

---

## Day 4 — 2026-09-21 — Hourly scoring: the system becomes live

### Shipped

The map no longer shows terrain. It shows *risk right now*: an EventBridge
schedule runs `scoreRisk` at the top of every hour, which combines terrain
susceptibility with the rainfall forecast and the reports standing in and
around each cell, and writes back a score, a level and the sentence that
justifies them. Nothing is scored on the request path.

- **`scoreRisk`** — 1,140 cells in ~2.8s, ~40 prefix queries and 46 batched
  writes. No scan anywhere.
- **Open-Meteo forecast** — four representative points across the pilot area in
  a single request, each cell taking the nearest. Chosen for having no API key:
  no secret to rotate, nothing to leak, nothing to configure on a fresh deploy.
- **Thresholds in Parameter Store**, tunable live. Verified by changing them
  and watching the level distribution move (see below).
- **CloudWatch EMF metrics** plus two alarms: one for scoring stalling
  (`TreatMissingData: breaching`, so silence is itself the alarm) and one for
  the forecast feed being unavailable for three hours.
- **`/api/health` now reports the scoring state** — last run, age, cells
  scored, and whether the forecast was available. Still returns 200 when
  scoring is stale: the service IS up, and conflating "degraded" with "down"
  pages somebody for the wrong thing.

### Verified against production

| Check | Result |
|---|---|
| Full scoring run | 1,140/1,140 cells, 2.8s, forecast available (4 points) |
| `/api/health` | `state: current`, `ageMinutes: 0`, `forecastAvailable: true` |
| Live threshold tuning | watch 45→20, high 70→40 ⇒ `high` went 0 → 285 cells |
| `CellsRaisedToHigh` | correctly reported all 285 transitions |
| Malformed tuning value | rejected, fell back to built-in defaults, still scored 1,140 |
| Restored thresholds | back to low 1,075 / watch 65 / high 0 |

69 tests pass, up from 24. The new ones cover the model itself, including the
boundary at each threshold in both directions.

### Two bugs the testing actually caught

**1. Caching defeated the entire point of Parameter Store.** `loadTuning` held
the value at module scope "for the life of the execution environment". Changing
the threshold and re-invoking produced *no change at all*, because the warm
container kept serving the old value. The saving was a few milliseconds against
a run that takes seconds; the cost was that the one feature the parameter exists
for — tuning during a live demo — silently did not work. Cache removed.

**2. A permanent 20-point handicap on every quiet cell.** The first
implementation weighted reports at 20% and scored their absence as zero. That
holds every cell without reports 20 points below what its terrain and forecast
justify. But nobody reporting water is not evidence that there is no water — it
is evidence that nobody with a phone has walked past yet, which is most true at
night and in the areas with the fewest users. Penalising silence under-warns
precisely the people this is built for.

Both optional components now redistribute their weight when absent rather than
contributing a zero, for the same reason in two disguises: a missing forecast
counted as "no rain" would mark the whole city safe at the exact moment the feed
broke. With neither available the score is the terrain susceptibility itself,
which is the honest answer.

### A visible consequence, stated plainly

Today's forecast for Accra is about 3mm. Under the model that puts the whole
pilot area at `low`, with 65 cells at `watch` along the drainage corridor, and
**no cells at `high`**. The map went from mostly red to mostly blue.

This is correct, and it is the entire point of the hourly job. The plan defines
High as "flooding is likely here, avoid if you can" — on a dry day that is
false, and a map that says it every day is a map people learn to ignore before
the day it matters. The terrain reading has not been lost: it still drives 40%
of the score, it is still returned as `susceptibility`, and the explanation
still opens with "ground here is barely above the nearest drain".

For a demonstration in dry weather, the thresholds in Parameter Store are the
intended lever, and they now genuinely work.

### Honest state

- The legend previously described terrain ("floods readily when it rains
  hard"). That stopped being true the moment levels started responding to the
  forecast, so it now describes the situation: "flooding likely — avoid if you
  can". Same for the other three levels.
- **Watcher notification is counted, not dispatched.** `scoreRisk` detects
  cells newly crossing into `high` and emits `CellsRaisedToHigh`, but web push
  does not exist yet, so nobody is told. `saveWatch` turns the count into a
  dispatch.
- The 8 historical flood points remain **unverified** and still override the
  terrain model in their cells.
- Test reports created during verification were deleted afterwards; the
  `Reports` table is empty.

### Next

- `saveWatch` and web push, which turns `CellsRaisedToHigh` into an alert.
- `calculateSafeRoute` with `GeoRoutes.CalculateRoutes` and `Avoid.Areas`.

---

## Day 5 — 2026-09-21 — Terrain view, safe routing, and alerts that actually send

Three things shipped. The first came out of looking honestly at what Day 4 had
produced; the other two were the last features on the plan's list.

### The problem with a correct map

Day 4 ended with the map going from mostly red to mostly blue, and the log
entry arguing — correctly — that this was the whole point of the hourly job. On
a dry day "flooding is likely here" is false, and a map that says it every day
is a map people learn to ignore before the day it matters.

That reasoning is right and it is also incomplete. A map that reads "Low"
everywhere is honest and useless. It discards the one thing this project knows
that nobody else publishes: **which specific streets go under first.** That
does not change with the weather, and on a dry day it is the only thing worth
showing.

So the map now answers two questions, and says which one it is answering.

| | Live view | Terrain view |
|---|---|---|
| Question | Is this street dangerous now? | Which streets flood when it rains? |
| Palette | blue → orange → red | purple ramp |
| Texture | diagonal hatching | horizontal banding |
| Words | "Flooding likely — avoid if you can" | "Floods first — goes under earliest when it rains hard" |

The two languages are deliberately unrelated. Somebody glancing at the terrain
view must not come away believing they were warned about right now, so it
shares no colour, no texture and no verb tense with the warning map.

**The switch follows the weather.** `GET /risk` now returns a `rainOutlook` for
the viewport (`none` / `light` / `significant`), derived from the rainfall the
scoring job actually used. `none` selects the terrain view automatically. A
toggle marked "Right now" / "When it rains" is always available.

Two rules are safety rules and override the user's choice: a `confirmed` cell
anywhere in view forces the live map, and so does `rainOutlook: significant`.
Both say so in the banner, and the override consumes the manual choice rather
than silently reverting to terrain once the rain passes.

A third rule is the one most likely to be got wrong later: **a missing forecast
is not "no rain".** `rainOutlook` is null when the feed was down, and null keeps
the live view. Reading a missing number as good news, at the exact moment the
system knows least, is how this feature would have become dangerous.

`web/src/view.ts` holds the rules as one pure function, tested in both
directions of every override.

### Safe routing

`POST /api/route` turns active reports and scored cells into `Avoid.Areas` for
`GeoRoutes.CalculateRoutes`.

The split between what is *avoided* and what is *blocked* is the interesting
part. A `confirmed` cell, or any cell with a knee-deep-or-worse report, is a
hard block. A cell merely scored `high` is a soft preference. The difference is
evidence versus inference: two people saying there is water is reason enough
not to send somebody down that street; a model saying there might be, every
time it rains, is how a tool gets uninstalled. Ankle-deep reports do not block
at all — closing roads on passable water would make the feature useless in
ordinary Accra rain and teach people the blocks mean nothing.

**`Avoid.Areas` is documented as best effort.** It "may still include
restricted areas if no feasible alternative route exists". For toll roads that
is reasonable. For water it is not, because the entire promise of the feature
is that the returned route does not go through it.

So `lib/geometry.ts` checks the returned geometry against the blocked cells and
discards any route that crosses one. Segment-against-box by the Liang-Barsky
slab method rather than sampling points along the line: a straight road
crossing the corner of a 152m cell passes between samples however finely they
are spaced, and that hole is exactly the case worth catching.

### Alerts

`POST /api/watch` registers the browser's push subscription against a cell.
Keyed by cell rather than by user, so a red cell finds everyone who needs
telling in one query; keying by user would force a scan at exactly the moment
the system is busiest. The sort key is a SHA-256 of the push endpoint — not a
security measure, since the endpoint must be stored alongside it to send
anything, but it keeps the thing that can push to somebody's phone out of log
lines and metrics.

The endpoint is validated against a host allow-list. Without it, anyone could
register an arbitrary URL and turn the hourly job into a request generator
pointed wherever they liked.

Alerts fire on the *crossing* into danger, not on the state. Re-alerting every
hour while a cell stays `high` is how people turn notifications off, and they
turn them off before the hour that mattered. The one repeat worth sending is
`high` → `confirmed`: "flooding is likely" and "people are standing in it" are
different claims.

VAPID keys are provisioned out of band, because CloudFormation cannot create a
SecureString. A stack without them scores normally and sends nothing — the
right failure, since the map staying current matters more than the alerts, and
a scoring run that threw because a notification key was missing would leave
last hour's numbers on screen looking current.

### Verified against production

| Check | Result |
|---|---|
| `/api/health` | `state: current`, 1,140 cells, forecast available |
| `rainOutlook` today | `none` (0.3mm/6h, 0.6mm/24h) |
| Terrain bands | 466 `floods-first`, 175 `floods-heavy`, 499 `usually-dry` |
| Live levels today | 1,075 `low`, 65 `watch`, 0 `high` |
| Terrain view auto-selects | yes — "No rain forecast. Showing which streets flood when it rains." |
| Toggle back to live | yes — legend and palette swap, no refetch |
| Walking route, nothing in the way | 5,122 m, 87 min |
| Driving route, nothing in the way | 6,164 m, 11 min |
| Walking route, 3 cells blocked | 6,186 m, 105 min — "goes around 3 places where people are reporting water. That is about 18 minutes more walking." |
| Report planted at the destination | service returned a route; **the geometry check rejected it**; answer was `found: false`, no geometry, "Do not walk this route." |
| `POST /watch` | registers and cancels; rejects an unknown push host and a point outside the pilot area |
| Alert dispatch | cell raised `watch` → `confirmed` → watcher found → VAPID loaded → **FCM accepted the message**, `AlertsSent: 1` |
| Subscription pruning | FCM returned 404 for a retired token; the row was **deleted**, `SubscriptionsPruned: 1` |
| Alert de-duplication | second run with the cell still `confirmed` → `CellsRaisedToHigh: 0`, nothing sent |

### Three bugs the verification caught

**1. A due-east route through a flooded cell read as clear.** The Liang-Barsky
parallel-segment branch tested `distance <= 0` where it needed `distance >= 0`.
Any route running exactly along a line of latitude — on a street grid, a great
many of them — skipped the check entirely. Caught by the first test written for
the function, before it ever ran against the service.

**2. Every route reported "0 m, 0 minutes".** `Route.Summary` comes back empty
from `CalculateRoutes` in `eu-west-1`, for both Pedestrian and Car. The totals
live in `Legs[].{Pedestrian,Vehicle}LegDetails.Summary.Overview` and must be
summed. Nothing in the types suggests this; only calling it does.

**3. The action bar covered the disclaimer.** A second button made the label
wrap to three lines, and the new view toggle pushed the page 86px past the
viewport so it began to scroll. The fixed bar then floated over "not an
official warning service" — the one sentence on this page that is never allowed
to be obscured, and which `styles.css` already carried a comment about.

The fix is worth recording because the obvious one is wrong. The map's
`min-height` was forcing the overflow, and lowering it does **not** shrink the
map, because `flex: 1` still hands the map everything the other bands do not
use. It went from 55vh to 38vh and the map still renders at 412px of an 844px
screen. A `min-height` on a flex child is a floor for short screens; it has to
stay below what flex would give, or it silently becomes a scrollbar.

### Honest state

- **Push is verified as far as the push service, not as far as a phone.** A real
  Chrome subscription was registered against a real cell, and when that cell
  crossed into `confirmed` the scoring job composed, signed and sent the
  message, and **FCM accepted it** (`AlertsSent: 1`). What has not been
  observed is the last hop: a notification actually appearing on a handset.
  That needs a device and was not done. Everything up to the handover is
  exercised in production, including pruning a retired subscription on a 404
  and suppressing a repeat while a cell stays dangerous.
- The 8 historical flood points remain **unverified** and still override the
  terrain model in their cells.
- There is no place search. A destination is chosen by tapping the map, which
  is faster than typing and works when you do not know the junction's name.
  `GeoPlaces` would be a second endpoint and is not needed for the pilot.
- The soft/hard avoidance split has not been tuned against a real storm. It is
  a judgement, documented in `lib/routing.ts`, not a measurement.
- All test reports and watchers created during verification were deleted, and
  the grid was rescored to baseline afterwards. Both tables are empty.

### Counts

- 160 backend tests (up from 69), 13 frontend tests (new), 0 failures.
- 6 Lambda functions, 3 DynamoDB tables, 1 hourly schedule, 2 alarms.
- Evidence: `docs/evidence/day5-terrain-view.png`, `docs/evidence/day5-now-view.png`.

---

## Day 6 — 2026-09-22 — Throttling the abuse surface, and cleaning up after testing

A review session rather than a feature session. Two things came out of it that
were worth acting on immediately, and one finding that changes how urgent the
Lambda quota increase is.

### Stale test data was live on the public map

`GET /api/reports` was serving a report submitted at 2026-09-21T21:17:06Z —
ankle-deep water at 5.57, -0.22, showing to visitors as "12 hours ago". A test
FCM push subscription was registered against cell `ebzzen0` alongside it.

Day 5's log says both tables were emptied after verification. They were; a
later session at 21:16–21:17 recreated them and did not clean up. The report's
own TTL would have cleared it that evening, but until then anyone opening the
app — including a judge — saw a flood report that no resident made.

Both records deleted with conditional deletes. Both tables now hold zero items.
The affected risk cell was unharmed: it read `basis: terrain-and-forecast` at
score 46.3, so the single ankle-deep report never entered the score. One report
marks a cell `reported`, not `confirmed`, and ankle is not a confirming depth.

The lesson is not "remember to clean up". It is that nothing in the system
distinguishes a test report from a real one, by design — reports carry no
identity. So verification against production has to be paired with deletion in
the same session, because afterwards there is no way to tell them apart.

### The API had no throttling, despite the code saying it did

`submitReport.ts` has carried this comment since Day 3:

> That makes this the abuse surface, so validation here and throttling at the
> API are what keep it honest.

There was no throttling at the API. No `DefaultRouteSettings`, no
`RouteSettings`, nothing in the template. The unauthenticated write path was
open at whatever rate a client could generate.

Now set on the `$default` stage:

| Route | Rate | Burst |
|---|---|---|
| default (all routes) | 40/s | 80 |
| `POST /api/reports` | 5/s | 20 |
| `POST /api/route` | 5/s | 10 |
| `POST /api/watch` | 5/s | 10 |

`/api/route` is tightest per unit of harm: every call is a GeoRoutes call, the
most expensive request the system makes.

These are **stage** limits, not per-caller limits. API Gateway does not do
per-IP throttling and WAF is out of scope, so this bounds total spend without
isolating one bad client from everyone else. That is the right trade when
uncontrolled cost is the risk that ends the project and brief denial is the
risk that annoys — but it is a trade, not a fix, and it is written into the
template so the next person does not have to rediscover it.

### Verified against production

Deployed via a reviewed changeset: twelve resources, all `Modify`, zero
`Replacement`. CloudFront, S3 and all three DynamoDB tables untouched, so the
public URL could not be disturbed. Health returned 200 before and after.

Throttling verified behaviourally, not just by reading it back from the stage —
a stored route key proves nothing about whether it matches a real route. The
probe sends a deliberately invalid body, so any request that is *not* throttled
returns 400 from the handler and writes nothing, which meant testing the write
path on production without putting data back on the map it had just been
cleaned off.

- 120 concurrent requests through CloudFront → **exactly 25 reached the handler**,
  which is burst 20 plus one second of refill at 5/s. The limit is exact.
- A single request against a drained bucket → `429 Too Many Requests`.
- Reports table still empty afterwards. Ship gate still 200.

### The finding that matters more than the throttling

Under the 120-request burst, most rejections came back **503, not 429** — and
they did so against API Gateway directly, with CloudFront out of the path.

That is not the stage throttle. It is Lambda. The burst limit of 20 admits 20
simultaneous requests, and this account's Lambda concurrency is still the
new-account default of **10**, so half of an admitted burst is rejected by the
integration and surfaces as Service Unavailable.

This is exactly the shape of a real event: a storm produces a cluster of
reports from one junction within seconds. Roughly half of them would currently
fail, and fail looking like an outage rather than like backpressure.

`ListRequestedServiceQuotaChangeHistory` for Lambda in `eu-west-1` returns zero
requests — the increase the template has been deferring to since Day 3 had
never actually been filed. Trying to file it is where the session stopped being
routine.

Throttling was the half of this that could be fixed today. It is done.

### Why the quota increase could not be filed from here

Attempting it returned something more informative than success:

> `IllegalArgumentException: You must provide a quota value greater than the
> default quota value of 1000.0`

The numbers explain the whole situation:

| | Value |
|---|---|
| Applied to this account | **10** |
| AWS default for the quota | **1000** |

The 10 is therefore **not the quota's default** — it is a new-account
onboarding restriction sitting underneath a quota whose default is a hundred
times larger. Service Quotas only brokers requests *above* a default, so it
refuses to act on a value of 200: as far as that API is concerned this account
already has 1000 and is asking to go down.

Lifting a new-account restriction goes through Support, and the Support API
returns `SubscriptionRequiredException` on this account — programmatic case
creation needs a paid Premium Support plan. A service limit increase case is
free to raise on Basic support, but only through the Support Center console.

So this one cannot be automated from the agent, and the log should say so
rather than leave a checkbox that looks fillable. Raised by hand instead; see
the next entry for the outcome.

The practical consequence for now: the burst limit of 20 on `POST /api/reports`
is a ceiling the compute underneath cannot reach, and
`ReservedConcurrentExecutions: 20` stays commented out at template.yaml:492.

### The README was the one place overselling this project

The build log has been candid about the flood points since Day 2. The README
had not caught up, and the README is what gets read first.

| Claim | Reality |
|---|---|
| "~50–100 recurring locations" | **8**, none verified |
| Diagram shows `GeoPlaces` | Not used — the only reference in the codebase is a comment explaining why there is no place search |
| Ghana Met Agency listed as a data source | Not integrated; Open-Meteo is the only feed called |
| "Licence: MIT" | No `LICENSE` file existed |

All four corrected, and the flood points now get a section of their own rather
than a table row — including the fact that a historical point overrides the
terrain model, which is why an unverified coordinate is a real problem and not
a footnote. `LICENSE` added.

Checked each against the source rather than against the Day 5 summary: the
count came from importing `HISTORICAL_FLOOD_POINTS` and counting, and the
GeoPlaces and Open-Meteo claims from grepping the handlers and the template.

Note for later: the architecture diagram in `CLAUDE.md` still shows
`GeoPlaces / GeoRoutes`. Left alone deliberately — it describes the intended
API model rather than making a claim about what is built — but if place search
never lands, that line should go too.

### Counts

- 160 backend tests, 13 frontend tests, 0 failures. No application code changed.
- Reports: 0 items. Watchers: 0 items. RiskCells: 1,140 cells + 1 meta record.
- Lambda concurrency still 10; the Support case is in, outcome pending.

---

## Day 6, continued — Alarms that reach someone, least privilege, instant alerts

Three things, in increasing order of how much they change the product.

### The alarms were talking to nobody

Both alarms have existed since Day 4. Both evaluated correctly. Neither had an
action, so a stalled scoring job would have changed an alarm state in a console
nobody had open. The entire point of the stalled-scoring alarm is to be seen
*without* anyone opening a console.

An SNS topic, an email subscription, and `AlarmActions` plus `OKActions` on
both. `OKActions` because "it started working again" is information too —
without it, the only way to learn the outage ended is to go and look, which is
the habit the alarm exists to remove.

The address is a template **parameter with no default**. This repository is
public, and a default would publish it. It is passed at deploy time and lives
in the stack parameters instead. Left empty, the alarms evaluate and have
nowhere to send, which is exactly the behaviour from before — so the template
degrades to its old self rather than failing to deploy.

### Least privilege, actually

Five SAM managed policies replaced with explicit statements matching what the
handlers really call. Verified by reading the call sites, not by trusting the
previous session's notes:

| Function | Was | Now |
|---|---|---|
| `health` | `DynamoDBReadPolicy` | `GetItem` |
| `getRisk` | `DynamoDBReadPolicy` | `Query` |
| `getReports` | `DynamoDBReadPolicy` | `Query` |
| `calculateSafeRoute` | `DynamoDBReadPolicy` ×2 | `Query` on both tables |
| `submitReport` | `DynamoDBCrudPolicy` + unused RiskCells read | `PutItem` + `Query` |
| `scoreRisk` | `DynamoDBCrudPolicy` | `Query` + `BatchWriteItem` |

Two of these are worth naming. `DynamoDBReadPolicy` grants `Scan` — and this
project's whole table design exists to never need one, so holding it anywhere
contradicted the schema. And `DynamoDBCrudPolicy` on `submitReport` granted
`DeleteItem` and `BatchWriteItem` on the **public, unauthenticated write path**,
against the one table whose contents cannot be regenerated. That is the
difference between "a bug writes a bad report" and "a bug empties the reports
table".

`submitReport`'s RiskCells read grant was dead — that handler has never read
that table. Removed rather than kept "in case".

### Confirmed flooding now leaves the building immediately

This was the real gap. `submitReport` recorded confirmed flooding and told
nobody; the hourly run did the telling, so on a bad draw a watcher learned
59 minutes after somebody stood in the water and said so. For the strongest
signal the system has, that was the slowest path out of it.

Dispatching from `submitReport` was rejected. That handler is the public
unauthenticated write path, and giving it the Watchers table would let the most
exposed function in the stack enumerate who is watching where. Instead a
separate `notifyCell` function owns dispatch, and `submitReport` holds exactly
one new permission: `lambda:InvokeFunction` on that one ARN. It can *cause* an
alert; it still cannot see who receives one, or reach the keys used to sign it.

Invoked asynchronously, so a person standing in rain gets their confirmation
screen without waiting on a push service, and so a failure to notify can never
fail a report that was successfully recorded.

**The ordering inside `notifyCell` is the part worth keeping.** It claims the
transition with a *conditional* update before sending anything, rather than
reading the level and then writing it. Several people reporting one junction
within seconds produce several concurrent invocations; read-then-write would
have every one of them find "not yet confirmed" and every one of them alert.
The conditional update means exactly one wins and the losers return silently.
Alert-then-write would leave that race open, and the failure mode is one
person's phone buzzing four times for one flood.

### Verified against production

Both paths, on the live stack.

- **Suppression.** A report into a cell the hourly run had already confirmed:
  `ConditionalCheckFailedException` → *"Cell ebzzdvz was already confirmed; no
  alert sent"*, `InstantAlertSuppressed: 1`. No duplicate.
- **Transition.** Two reports into a clean cell (`ebzzdzb`, baseline `low`,
  score 8.5). Second report returned `confirmed`; 793 ms later `notifyCell` had
  claimed the transition, and the public API was serving *"People here are
  reporting water waist deep right now. 2 independent reports in the last three
  hours. Avoid this area."* Previously: up to 59 minutes.
- `strongestDepth` correctly chose `waist` over the earlier `knee`.
- The 13:00 scoring run wrote all 1,140 cells under the tightened IAM, and
  `/api/risk`, `/api/reports`, `/api/config` and `/api/route` all answer 200.
- Changeset reviewed before executing: 5 adds, every modify non-replacing, no
  CloudFront, S3 or DynamoDB resource touched.

Test data cleaned in the same session this time, per the lesson recorded above:
three reports deleted and `ebzzdzb` restored to the exact values the 13:00 run
wrote, rather than left for the next hour to fix.

### Counts

- **173 backend tests** (up from 160), 13 frontend, 0 failures.
- 7 Lambda functions (up from 6), 3 DynamoDB tables, 1 hourly schedule,
  2 alarms now wired to an SNS topic.
- New shared modules: `lib/vapid.ts`, `lib/metrics.ts` — extracted rather than
  duplicated once a second caller needed them.

---

## Day 6, continued — Four console errors, three explanations

Reported from a real phone: a WebGL warning, repeated `400`s from `/api/route`,
repeated `422`s from `/api/reports`, and a view toggle that appeared dead.

### The 400s and the 422s were the same bug

Both endpoints were refusing correctly. `/api/route` said *"The starting point
is outside the Circle, Kaneshie and Avenor pilot area"* and `/api/reports` said
the equivalent — because the device's GPS fix genuinely was outside it. The
pilot box is about 5.5km × 4.4km. Standing a few streets beyond it is the
normal case, not an edge case.

The bug is that **the browser already knew the boundary and never consulted
it.** `/api/config` returns `pilotArea.bbox`, and `main.ts` uses it to bound
the map — but `reporting.ts` and `route-flow.ts` each took
`position.coords` and sent it, then surfaced the rejection as a console error.
The app had every piece of information needed to explain the situation and
chose to let the server refuse instead.

Fixed by checking before sending, in both flows:

- `web/src/pilot.ts` — `isInsidePilotArea(bbox, lon, lat)`, pure and tested,
  including the transposed-arguments case, because longitude and latitude are
  both plausible small numbers and swapping them silently yields "outside".
- Reporting gained a third origin source, `outside-area`, distinct from
  `map-centre`. They need different sentences: one means *we could not find
  you*, the other means *we found you and you are not somewhere this map
  covers*. Collapsing them would be a small lie.
- Routing simply declines to adopt an out-of-area fix, leaving the map centre —
  which is inside the area by construction.

Neither flow dead-ends. Somebody outside the area can still report a junction
they can see on screen, which is a legitimate report; they are just told which
position is about to be sent.

### The toggle was working exactly as specified

`view.ts` rule 1: a `confirmed` cell anywhere in the viewport forces the live
view and overrides a manual choice, because somebody standing in water
outranks a preference expressed earlier. That is a documented safety rule with
tests in both directions.

It was firing because a leftover test report had `ebzzdvz` sitting at
`confirmed`, so `rainOutlook: none` could not take the map to terrain. Nothing
to fix in the code. The test data is gone and the grid is back to 0 confirmed
cells, 59 watch, 1,081 low, so the toggle moves again.

Worth noting what this near-miss says, though: the override is correct, but a
user who has not read `view.ts` experiences it as a broken control. The banner
does say why — `overrodeChoice` is plumbed through for exactly this — so the
remaining question is whether that sentence is prominent enough to be read
before the toggle is pressed a second time. Not changed today; recorded.

### The WebGL warning is not ours

*"READ-usage buffer was written, then fenced, but written again before being
read back."* That is MapLibre's tile rendering talking to the GPU driver, on a
performance channel, in a build we pin at v5 for reasons recorded on Day 3. No
functional effect and no action.

### Counts

- 19 frontend tests (up from 13), 173 backend, 0 failures.
- New: `web/src/pilot.ts`, `web/src/pilot.test.ts`.
- Reports: 0 items. Watchers: 0 items. Grid: 0 confirmed.

---

## Extending coverage to the Odaw catchment

Asked to review how feasible four out-of-scope items were, the answer to three
was "don't". The fourth — coverage beyond the pilot — was worth doing at a
smaller size than the question implied, so it got built.

### Why the catchment and not "more of Accra"

Whole-of-Greater-Accra costs about 150,000 cells and ~$140/month in DynamoDB
writes alone, roughly seven times the target for everything. It also breaks
`scoreRisk`, which loads every cell through one `Promise.all` and batch-writes
them in a 120s Lambda.

The Odaw basin is 5,100 cells and ~$5/month, and needs no redesign anywhere.
More to the point it is the right *shape*: Accra flooding is one system
draining to the Korle Lagoon, and the pilot box sat in the middle of it, able
to see where water arrived but not where it came from. Achimota and Lapaz —
asserted as outside the grid in the old tests — are the headwaters.

Measured before writing anything, which is what made the size decision
obvious:

| Option | Cells | Prefixes | DDB writes/mo |
|---|---|---|---|
| Pilot only (before) | 1,140 | 48 | $1.16 |
| **Odaw catchment** | **5,100** | **176** | **$5.19** |
| Greater Accra | ~150,000 | ~4,750 | ~$140 |

Contiguous rather than scattered pockets, for a physical reason: HAND is
measured against the nearest drainage, so cutting a catchment into boxes
computes a wrong height-above-drainage for every cell near a cut. That is the
failure `BUFFER_DEGREES` already exists to prevent. The three additions worth
having most (Alajo, Nima, Agbogbloshie) turned out to be adjacent to or
overlapping the pilot anyway — "disjoint pockets" was a fiction for the Odaw
corridor.

### Coverage is a list, not a box

Widening `PILOT_BBOX` would have worked exactly once. The next areas worth
adding — Dansoman, Weija, Madina — are not adjacent to anything, and a box
drawn around all of them claims thousands of cells over ground the terrain
model has never seen.

So `COVERED_AREAS` is a list of named areas, `COVERAGE_ENVELOPE` frames the
map and is never a boundary test, and the gap between two areas is outside
coverage rather than inside the envelope. Production ships one area today,
which would have left every disjoint and overlapping path untested — so the
helpers take the area list as an argument defaulting to the constant, and the
tests pass deliberately gappy and overlapping fixtures.

### Three things the larger area broke

**Routing silently stopped verifying whole trips.** `loadCorridor` capped its
prefixes at `MAX_PREFIXES_PER_REQUEST`. Over the pilot that never bound; over
the catchment a Korle-Lagoon-to-Achimota corridor needs 176 and would have
been truncated to 128, then presented with the same confidence as a fully
checked route. A viewport that returns some of its cells is a map missing a
corner; a corridor that returns some of its hazards is a lie. `prefixesForCorridor`
is uncapped and returns null past a sanity bound, and the handler refuses the
route rather than checking part of it.

**The opening request grew to two megabytes.** The first risk fetch goes out
before the map exists, on purpose, so the overlay is in flight while tiles
load — which meant it could not ask what was on screen and asked for the whole
area instead. `web/src/viewport.ts` computes the viewport from the centre,
zoom and container size, all known beforehand, so the request still leaves
first and is now a fraction of the size. Steady-state viewport fetching
already existed on `moveend`; only the opening call was whole-area.

**A zoomed-out map would have drawn a partial overlay as a complete one.** The
whole catchment at once exceeds the per-request cap. Truncating spatially
means some streets render and others do not, and blank ground looks exactly
like safe ground. Below `RISK_MIN_ZOOM` (13, where a phone viewport needs ~56
partitions — close to what the pilot needed) the overlay is cleared and the
map says *"Zoom in to see street-level flood risk."* When the cap does bite,
the response carries `truncated` and the client says so.

### Kept deployable

`getConfig` serves the new `coverage` object *and* the old `pilotArea`. The
stack and the web bundle deploy separately, so there is a window where a
browser holding the previous bundle talks to the new backend; it reads
`pilotArea` and nothing else. Same for `outsidePilotArea` alongside
`outsideCoverage`. Both can go once the new bundle has been live a while.

No table migration: cells and prefixes derive from coordinates at unchanged
precision, so existing pilot cells and reports stay valid. New ground needs a
re-run of `build_susceptibility.py` and `seed_risk_cells.py`.

### Guarding the mirror

`config.py` and `pilot.ts` both carry a comment saying they must agree, which
has never once stopped two constants diverging. `test_covered_areas_mirror_the_backend_definition`
parses `COVERED_AREAS` out of the TypeScript and compares it to the Python.
Checked that it bites rather than silently parsing nothing.

The encoder cross-check tests had been using `PILOT_BBOX` as a fixture,
including the 1,140-cell count measured against the preprocessing output. That
number pins the Python and TypeScript encoders to the same grid, so it is now
a pinned literal in both test files rather than whatever coverage happens to
be — otherwise a real cross-implementation check becomes a number edited
whenever it fails.

### Still unresolved

The eight historical flood points are still `verified: False`, and each raises
its cell to at least 75, overriding the terrain model. Extending coverage
multiplies that unverified surface rather than reducing it. Verifying them
against NADMO reports is now more overdue than it was.

### Counts

- 193 backend tests (up from 173), 45 frontend (up from 19), 17 preprocessing
  (up from 13). 0 failures. `sam build` clean, `npm run build` clean.
- New: `backend/src/lib/pilot.test.ts`, `web/src/viewport.ts`,
  `web/src/viewport.test.ts`.
- Grid: 5,100 cells, 176 partitions. Not yet deployed or re-seeded.

---

## Verifying the historical flood points

The eight points had carried `verified: False` since they were written. Each
raises its cell to at least 75 and its neighbours to 55, overriding the
terrain model, so this was the largest known unquantified risk in the data.

### Method

Two criteria, both required. The place had to be documented as flooding by a
source that is not this project, and the coordinate had to be corroborated by
two independent gazetteers — OpenStreetMap via Nominatim, and Amazon Location
GeoPlaces — agreeing with each other to within about one grid cell.

Using GeoPlaces for this is the same IAM path `calculateSafeRoute` already
uses, so it needed no new permissions.

### What the check found

Every place was real and documented as flooding. **Five of the eight
coordinates were wrong enough to land in a different geohash cell** — they had
been painting the floor of 75 onto the wrong streets.

| Point | Error | Corrected to |
|---|---|---|
| Kwame Nkrumah Circle | **~870m ENE** | 5.5696, -0.2153 |
| Alajo | **~1.4km S** | 5.5937, -0.2169 |
| Kaneshie market frontage | ~270m SE | 5.5644, -0.2343 |
| Obetsebi Lamptey Circle | ~250m E | 5.5612, -0.2293 |
| Avenor | 134m (sub-cell) | 5.5777, -0.2186 |

Circle is the one that matters. A single geocoder would not have caught it:
Amazon Location returns *two* different POIs named "Kwame Nkrumah Circle",
1.8km apart, and only one is corroborated by OSM's four highway segments of
that name. A third, independent check settled it — the cached drainage puts
the old coordinate 1,176m from the nearest mapped river and the corrected one
302m, and Circle is a place defined by sitting beside the Odaw.

Three could not be verified and are now carried as candidates rather than
applied:

- **Kaneshie First Light** — flooding is beyond doubt (the AMA is building an
  underground drain there specifically to stop it) but neither gazetteer
  carries "First Light" as a feature, so the pin cannot be placed.
- **Odaw channel at Circle** — sits on a side drain 876m from the river, and
  once Circle is corrected it double-counts the same ground 300m away.
- **Lartebiokorshie drain** — no source for this specific drain, coordinate
  ~1km from the OSM centroid with no agreement between sources.

### The flag now does something

`verified` used to print a warning and apply the point anyway. A guessed
coordinate raised a cell to 75 exactly as hard as a checked one, which is the
opposite of what the flag is for. Only verified points are applied now;
unverified ones are listed and passed over. A warning nobody can act on is not
a control.

Each verified entry also records *what* verified it. "Verified" with no
source is a claim, not a verification, and a test enforces that the two travel
together.

### A silent failure the coverage change had introduced

`load_elevation` and `load_drainage` reused their caches whenever the file
existed, with no record of which bounding box produced them. Safe while the
area was a constant; now that coverage is configuration, widening it and
re-running without `--refresh` would have read a DEM window that does not
reach the new ground and computed HAND and slope for cells the raster never
covered — silently, with a full-looking grid at the end.

Both caches now stamp their window and re-fetch on a mismatch. The existing
cache was built for `(-0.260, 5.535, -0.180, 5.605)` and the catchment needs
`(-0.265, 5.520, -0.155, 5.665)`, so it correctly reports itself stale.

### Caveats worth keeping

- Obetsebi Lamptey and Kaneshie First Light have both had major drainage works
  since the flooding was recorded. The historical floor may overstate current
  risk at both. Recorded in the notes rather than silently adjusted.
- Kaneshie market frontage is the weakest verified point: the two gazetteers
  sit 270m apart, so it is good to about two cells. First to recheck on the
  ground.
- Coordinates are stored to four decimals (~11m). That is finer than the
  sources justify; the honest precision is the cell.

### Counts

- 26 preprocessing tests (up from 17), 193 backend, 45 frontend. 0 failures.
- New: `preprocessing/test_flood_points.py`.
- 5 points applied, 3 carried as candidates. Previously 8 applied, 0 checked.
- **Not re-run end to end**: `rasterio` is not installed in this shell, so
  `build_susceptibility.py` has not been executed against the corrections.

---

## Deployed: the Odaw catchment is live

Deployed 2026-09-22, in the order the compatibility shims were built for.

Preprocessing ran **first**, before anything touched AWS. If the grid could not
be regenerated there was no point deploying a backend that claims ground it
has no cells for, and this way a failure costs nothing.

### The run

`rasterio` was not installed locally; installing it was the only prerequisite.
Then both caches did exactly what they were changed to do two hours earlier:

```
elevation: cached window does not match the covered area
           (None != [-0.265, 5.52, -0.155, 5.665]); re-reading
drainage:  cached window does not match the covered area; re-querying
```

The old DEM cache predated the bbox stamp entirely, so it reported `None` and
was correctly treated as stale. Overpass returned 2,249 drainage features, up
from 1,104 over the pilot window.

| | Before | After |
|---|---|---|
| Grid cells | 1,140 | **5,100** |
| Drainage features | 1,104 | 2,249 |
| Median susceptibility | 61.1 | **40.4** |
| Flood points applied | 8 (0 checked) | **5 (all checked)** |

The median dropping from 61 to 40 is the catchment doing its job: the pilot box
was all low-lying Odaw floodplain, and the new area reaches up to the Achimota
high ground that drains into it. A model that scored those equally would be
broken.

### Sequence

1. `build_susceptibility.py` — 5,100 cells, 5 points applied, 3 named as
   skipped. Artefact validated against the flood-point contract before deploy.
2. `sam deploy` — stack updated, `/api/config` serving `coverage` with the
   `pilotArea` compatibility field alongside it.
3. `seed_risk_cells.py` — 5,100 cells written.
4. `scoreRisk` invoked directly rather than waiting for the top of the hour.
   Seeding writes whole items, so it clears the score the hourly job owns;
   every cell would otherwise have read terrain-only until 17:00Z. Scored
   5,100, forecast available, 0 alerts.
5. `deploy-web.ps1` — S3 sync plus CloudFront invalidation.

### Verified live

- Ship gate: site 200, health 200, 5,100 cells scored, forecast available.
- Deployed bundle hash matches the local build exactly.
- Achimota — outside the pilot box until today — returns 132 scored cells on
  `terrain-and-forecast`, not truncated.
- Both corrected flood points resolve at their new cells: Kwame Nkrumah Circle
  at `ebzzejg`, Avenor at `ebzzep2`. The detail text reads "flooding has been
  recorded at Kwame Nkrumah Circle" off the corrected coordinate.
- **A 10.5km route across the whole catchment, Korle Lagoon to Achimota,
  returns a real distance and duration.** That corridor needs 176 partitions;
  before today it would have been verified over 128 of them and presented with
  full confidence. This was the point of the change.
- Tema and a destination outside coverage are both refused, naming the covered
  area from the configuration rather than a hardcoded string.
- 0 confirmed cells across all four quadrants; nothing truncated.

### Test data

One report was submitted at Achimota to exercise the write path over newly
covered ground, then deleted, and the cell verified back at `low`/2.6.

Two reports that are **not** test data were found in the table and left alone:
`ebzzdvz` (waist, 13:50Z, coordinates 5.57/-0.22 — the old map centre, so
possibly a map-centre report) and `ebzzdsx` (ankle, 16:20Z, 5.562391/-0.231453
— a precise fix, so probably a real device). Neither confirms a cell on its
own and neither forces the view override. Community reports are the one
irreplaceable asset here; deleting something merely because its provenance is
unclear is the wrong default.
