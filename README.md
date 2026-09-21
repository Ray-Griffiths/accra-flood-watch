# Accra Flood Watch

**Street-level flood risk, one-tap depth reporting, and routes that avoid the water — for Accra.**

Accra floods every rainy season, and it floods in the same streets, year after year.
Residents know which junctions fill first and which gutters back up, but that knowledge
lives in people's heads and in WhatsApp groups. It is never aggregated, never mapped, and
never turned into a warning that reaches the person about to walk into waist-deep water on
their way home.

Accra Flood Watch closes that gap. It combines three things:

- **Permanent terrain data** — which cells of the city are physically prone to flooding,
  derived from Copernicus elevation data via Height Above Nearest Drainage.
- **Live rainfall forecasts** — when water is coming, refreshed hourly.
- **One-tap depth reports from residents** — where water actually is, right now.

From these it produces a risk map, push alerts for saved locations, and walking or driving
routes that go around currently-flooded points instead of leading people through them.

---

**AWS Builder Center "Zero to Shipped" hackathon**
Category: `#social-good` (Climate resilience) · Lane: `#community`

| | |
|---|---|
| Live application | **https://d227oixun34mjp.cloudfront.net** |
| Health endpoint | https://d227oixun34mjp.cloudfront.net/api/health |
| Pilot area | Circle / Kaneshie / Avenor, Accra |
| Region | `eu-west-1` |
| Builder | Raymond Galley, Ghana Communication Technology University |

---

## What it is not

This is a **community information tool, not an official warning service.** For official
warnings, consult NADMO and the Ghana Meteorological Agency.

There is no machine learning in the risk model, deliberately. No labelled historical
dataset of Accra flooding exists at cell resolution, so a model could be neither trained
nor validated — and an unvalidatable model has no business in something people use to
decide whether to walk down a street. The model is a transparent weighted score, and
every risk level stores the sentence that justifies it.

## Privacy

No accounts, no names, no phone numbers, no email addresses, no device identifiers.

A report is coordinates, a severity level and a timestamp. Nothing links two reports from
the same device. Reports delete themselves 24 hours after submission through DynamoDB TTL
— a technical guarantee rather than a promise. Saved locations are stored against the
browser's opaque push subscription identifier, not against a person.

## Architecture

Serverless throughout. Nothing runs, or bills, while idle — which is what lets a community
service survive past the competition. A 500-user pilot costs roughly $10–20/month.

```
Browser (PWA) → CloudFront → S3 (static assets)
                    ↓ /api/*
              API Gateway HTTP API → Lambda ⇄ DynamoDB
                                        ↘ GeoPlaces / GeoRoutes
                                        ↘ Web Push endpoints
EventBridge Scheduler --hourly--> scoreRisk Lambda → forecast API + DynamoDB
```

There is **no VPC** anywhere in the design. A NAT gateway would cost more per month than
the entire rest of the system. Lambdas reach DynamoDB and S3 through service endpoints
with IAM authentication.

See `docs/AFW.png` for the full diagram.

## Repository layout

```
backend/          Lambda handlers (Node.js 22, TypeScript, arm64)
web/              PWA (Vite, vanilla TypeScript, MapLibre)
scripts/          Deployment helpers
docs/             Project plan, architecture diagram, build log
template.yaml     The entire stack as SAM/CloudFormation
CLAUDE.md         Locked decisions and non-negotiable project rules
```

## Development

Requires Node.js 22+, Python 3.13+ (preprocessing only), AWS CLI, and SAM CLI.
Docker is **not** required — all Lambda dependencies are pure JavaScript.

```bash
# Install
cd backend && npm install
cd ../web && npm install

# Deploy infrastructure
sam build
sam deploy                      # region and parameters come from samconfig.toml

# Deploy the web app
pwsh scripts/deploy-web.ps1

# Local frontend development
cd web && npm run dev

# Verify the ship gate
curl https://<distribution>.cloudfront.net/api/health
```

## Documentation

- **`docs/Accra-Flood-Watch-Project-Plan.docx`** — the full 22-section project plan:
  problem context, risk model, API design, cost analysis across three scales, safety and
  privacy design, testing strategy, impact measurement, roadmap.
- **`docs/build-log.md`** — what was attempted each session, what failed, what changed.
- **`CLAUDE.md`** — locked decisions, corrections to the plan, and the rules that must
  not be violated.

## Data sources

| Source | Provides | Access |
|---|---|---|
| Copernicus DEM, 30m | Elevation → slope and Height Above Nearest Drainage | Registry of Open Data on AWS |
| OpenStreetMap, Ghana | Roads, waterways, drains | Free extract, processed offline |
| Open-Meteo | Hourly precipitation forecast | Free, no API key |
| Ghana Meteorological Agency | Authoritative forecasts, used as cross-check | Public bulletins |
| Historical flood points | ~50–100 recurring locations | Hand-encoded from NADMO reports, research and news coverage |

## Licence

MIT
