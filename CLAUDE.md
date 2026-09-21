# Accra Flood Watch (AFW)

A Progressive Web App giving residents of Accra a street-level flood risk map, one-tap
depth reporting, push alerts for saved locations, and walking/driving routes that avoid
currently-flooded points.

Built for the **AWS Builder Center "Zero to Shipped" hackathon**.
Category `#social-good` (Climate resilience) · Lane `#community`.
Builder: Raymond Galley, Ghana Communication Technology University, Accra.

**The full spec is `docs/Accra-Flood-Watch-Project-Plan.docx`** (22 sections + appendices)
and the architecture diagram is `docs/AFW.png`. Read the plan before making design
decisions — this file records only what the plan leaves open or gets wrong.

---

## The ship gate governs everything

Shipping is **pass-or-fail**. A project that is not live at a public URL on AWS does not
advance to judging regardless of quality. Therefore:

> **A live public HTTPS URL exists before any feature work begins.**
> Everything after that improves something that is already shipping.

Never take an action that could leave the public URL broken. Deploy forward, never
leave the stack in a half-migrated state, and verify `GET /health` after every deploy.

---

## Locked decisions

These were decided at project setup. Do not revisit without asking.

| Decision | Value | Why |
|---|---|---|
| Region | **`eu-west-1`** (Ireland) | Lowest practical latency to Accra (~90ms). `af-south-1` was rejected — it has no Amazon Location Service. |
| Lambda runtime | **Node.js 22 + TypeScript** | Docker is not installed locally. SAM bundles TS with esbuild natively; `web-push` has zero native dependencies. Python's `cryptography` would have required Docker. |
| Frontend | **Vite + vanilla TypeScript + MapLibre GL JS** | Serves the low-end-Android constraint. No framework runtime. |
| IaC | **AWS SAM** (CloudFormation) | Per the plan. One template, one `sam deploy`. |
| Public URL | **Default CloudFront domain** | No DNS risk on a tight deadline. A custom domain can be attached later without redeploying. |
| Pilot area | **Circle / Kaneshie / Avenor** | Approx. bbox `-0.245, 5.550, -0.195, 5.590`. High-traffic commuter corridor with well-documented recurring flooding. |
| Preprocessing | **Python 3.13, local notebook, offline** | Never deployed. Raster work is the wrong shape for a request handler. |

**AWS account:** `337909743422`, IAM user `Ray`. **GitHub:** `Ray-Griffiths`.

---

## Corrections to the plan document

The plan is excellent but predates two facts. Follow this file where they conflict.

### 1. Amazon Location Service is now standalone APIs

The plan describes the legacy resource model (create a `Map`, a `PlaceIndex`, a
`RouteCalculator`). **Do not create those resources.** Use the standalone APIs:

- `GeoMaps` — `GetTile`, `GetStaticMap`. Browser uses a referer-restricted API key.
- `GeoPlaces` — `SearchText`, `Geocode`, `Suggest`. **Server-side only, via IAM.**
- `GeoRoutes` — `CalculateRoutes`. **Server-side only, via IAM.**

`CalculateRoutes` accepts `Avoid.Areas` directly, which is exactly the mechanism the
safe-routing feature needs. Verified available in `eu-west-1`.

### 2. No Docker locally

`sam build` must not rely on `--use-container`. Keep all Lambda dependencies pure-JS.
If something ever needs a native binary, raise it rather than silently adding Docker.

---

## Architecture

Serverless only. Nothing runs, or bills, while idle. **No VPC anywhere** — a NAT gateway
would cost more per month than the entire rest of the system. Lambdas reach DynamoDB and
S3 through service endpoints with IAM auth.

```
Browser (PWA) → CloudFront → S3 (static assets)
                    ↓ /api/*
              API Gateway HTTP API → Lambda ⇄ DynamoDB
                                        ↘ GeoPlaces / GeoRoutes
                                        ↘ Web Push endpoints
EventBridge Scheduler --hourly--> scoreRisk Lambda → forecast API + DynamoDB
```

### Lambda functions

| Function | Trigger | Responsibility |
|---|---|---|
| `getRisk` | `GET /risk?bbox=` | Bounds → geohash prefixes → risk cells. The dominant read. |
| `getReports` | `GET /reports?bbox=` | Active reports with age + severity. Never returns an identifier. |
| `submitReport` | `POST /reports` | Validate, confirm inside pilot boundary, derive cell, write with TTL, recompute live risk component, notify watchers if a threshold is crossed. |
| `saveWatch` | `POST /watch` | Register a web push subscription against a cell. |
| `calculateSafeRoute` | `POST /route` | Active reports → avoidance areas → `GeoRoutes.CalculateRoutes` → route + explanation. |
| `scoreRisk` | EventBridge, hourly | Fetch forecasts, recompute every cell, batch-write, dispatch alerts for newly raised cells. |

Plus `GET /health` — liveness and last scoring run time. Monitored through judging.

### DynamoDB tables

All **on-demand**. Partition key is a **geohash prefix (length 6)** in every table —
this is the central design decision. A geohash prefix describes a contiguous area, so a
viewport resolves to a small set of prefixes and every read is a single query. No
geospatial index, no scan, no filter, ever.

| Table | PK | SK | Notes |
|---|---|---|---|
| `Reports` | `cell` | `timestamp#reportId` | **TTL on `expiresAt`, 24h.** Point-in-time recovery enabled — accumulated community reports are the one irreplaceable asset. |
| `RiskCells` | `cell` | — | susceptibility, forecast rainfall (6h/24h), score, level, **explanation string**, updatedAt. |
| `Watchers` | `cell` | `subscriptionId` | Keyed by cell, **not by user**, so a red cell finds everyone to notify in one query. |

### Risk model

Deliberately simple, transparent, tunable. **No machine learning** — there is no labelled
historical dataset of Accra flooding at cell resolution to train or validate against, and
an unvalidatable model has no place in something people use to decide whether to walk
down a street.

Score 0–100 = ~40% static susceptibility (HAND + slope + historical points)
+ ~40% forecast rainfall (scaled **non-linearly**) + ~20% live reports (decaying with age).

Levels: `low` → `watch` → `high` → `confirmed`.

**`confirmed` is an override, not a threshold:** two or more independent reports within
three hours sets it regardless of computed score. Reality outranks the model.

Thresholds live in **SSM Parameter Store**, not in code, so they can be tuned during a
live demo without redeploying.

---

## Non-negotiable rules

Violating any of these breaks a safety, privacy, or cost guarantee the project promises.

### Safety
- Every view footer states this is a **community information tool, not an official warning
  service**, and points to NADMO and the Ghana Meteorological Agency.
- **Never return a route through a `confirmed` cell**, even if faster.
- When avoidance lengthens a route, **say so explicitly** in the UI.
- If no safe route exists, **say that plainly and advise not travelling.** Never silently
  fall back to a route through water.
- If the forecast feed fails, show terrain + reports with a **visible staleness label**.
  Degrade readably; never show nothing.

### Privacy
- No accounts, names, phone numbers, emails, or device identifiers. Ever.
- A report is coordinates + severity + timestamp. **Nothing links two reports from the
  same device.**
- Reports self-delete at 24h via DynamoDB TTL — a technical guarantee, not a promise.
- Saved locations key off the browser's opaque push subscription ID, not a person.
- Request bodies are **excluded from API Gateway access logs** so coordinates are not
  duplicated into CloudWatch.

### Cost
The whole low-cost profile follows from these. A pilot must stay near $10–20/month.
- **No VPC, no NAT gateway, no RDS, no containers, no always-on anything.**
- **Log retention is set explicitly to 7 days on every log group in the template.**
  The default is never-expire and forgetting it is the most common source of surprise cost.
- **Map tiles are the dominant cost at scale.** The CloudFront tile-caching behaviour with
  a long cache policy is designed in from the start, not added after a large bill.
- **`GeoPlaces` and `GeoRoutes` are never called from the browser.** Anyone reading page
  source could otherwise drive up spend. Browser holds only a referer-restricted tile key.
- AWS Budget alerts at **$10 and $25** must be active before any application code exists.
- SMS via SNS is **out** — ~$0.03–0.09/msg to Ghanaian numbers would exceed every other
  cost combined. Web push only.

### IAM
- **One execution role per function**, granting only what that function does.
  `submitReport` writes `Reports` and reads `RiskCells`; it cannot read `Watchers`.
  Read handlers have no write permission at all.
- Resource-level conditions scope DynamoDB actions to the **specific table ARNs** in the
  stack, never `*`.
- **No long-lived access keys anywhere in the running system.**
- S3 blocks all public access; CloudFront reads via **Origin Access Control** only.

### UI
The user is on a mid-range Android phone, outdoors, in rain, possibly holding an umbrella,
under time pressure.
- Report button is large, fixed, thumb-reachable.
- Risk levels differ by **shape and label as well as colour** — glare and colour-blindness.
- Service worker caches the shell and last risk data, labelled with when it was updated.
- Risk overlay loads **before** map tiles. It carries the information that matters.
- Text is short, concrete, free of meteorological jargon.
- **Every risk level explains itself in plain language.** This is a functional requirement:
  a number a user cannot interrogate is a number they will not trust, and an untrusted
  warning is an ignored warning.

---

## Scope discipline

Scope creep, not technical difficulty, is what makes hackathon projects miss the ship gate.

**Out of scope — do not build, do not suggest:** user accounts / auth / Cognito, coverage
beyond the pilot area, native apps, SMS or voice alerting, an admin dashboard for emergency
services, ML-based prediction, full offline tile caching, SQS buffering, WAF.

Amazon Bedrock is **optional and narrow**: phrasing a structured risk state as a natural
sentence, optionally in Twi or Ga. It is **never** used for prediction. A language model
has no business estimating flood risk.

---

## Commands

```bash
# Infrastructure
sam build
sam deploy --region eu-west-1          # --guided on first run
sam logs -n scoreRisk --tail

# Frontend
npm run dev                             # Vite dev server
npm run build                           # → dist/
npm run deploy:web                      # sync dist/ to S3 + CloudFront invalidation

# Verify the ship gate after every deploy
curl https://<distribution>.cloudfront.net/health
```

**S3 cache headers at upload:** long immutable caching for hashed filenames, `no-cache`
for `service-worker.js` and `index.html` so users get updates promptly.

---

## Evidence capture (a judging requirement, not bookkeeping)

The rules require documented proof of a coding agent connected to AWS. Reconstructed
evidence looks exactly like what it is, so capture continuously:

- `docs/build-log.md` — updated each working session: what was attempted, what failed,
  what changed. Commit it alongside the code.
- Screenshots of agent-to-AWS connection and `sam deploy` output showing stack changes.
- Before/after diffs for at least three substantive agent-authored changes.
- The SAM template is the single most legible evidence artefact — the agent's contribution
  is a reviewable diff, not an unverifiable claim about console clicks.

Round 1 is AI-scored on creativity/storytelling, technical innovation, community impact,
and communication quality. An honest build log outscores a richer feature set with no story.

---

## Working agreements

- **Read `docs/Accra-Flood-Watch-Project-Plan.docx` before proposing design changes.**
  Most questions are already answered there in detail.
- Access patterns were designed before the keys. If a change needs a `Scan`, the change
  is wrong.
- Keep files focused. When one grows large, it is doing too much.
- Test risk scoring against fixed inputs including **boundary cases at each threshold**,
  and geohash conversion against known coordinates inside and outside the pilot boundary.
- Ask before any action that could interrupt the public URL during the judging window.
