# GitHub Copilot integration

How the live `github` source pulls Copilot data. Verified against the
`RBCZ-copilots` org on 2026-07-16.

## The data sources GitHub actually gives us

Raiffeisen consumes Copilot through **github.com** (Enterprise Cloud), with several
orgs grouped under an enterprise account for billing. That shapes what the API exposes:

| Need | Endpoint | Notes |
| --- | --- | --- |
| Seat roster: `login`, `name`, `plan`, `last_activity_at`, editor | `GET /orgs/{org}/copilot/billing/seats` | Per-seat, reliable. Scopes: `manage_billing:copilot` or `read:org`. |
| Per-user usage (28-day) | `GET /orgs/{org}/copilot/metrics/reports/users-28-day/latest` | `ai_credits_used`, `used_agent/chat/cli`, activity counts, `totals_by_language_model`, `totals_by_ide`. **No** plan / last-activity. |
| Org aggregate per day | `GET /orgs/{org}/copilot/metrics/reports/organization-1-day?day=YYYY-MM-DD` | DAU/WAU/MAU, LOC, `totals_by_language_model`, `totals_by_model_feature`. |
| Org aggregate (28-day) | `GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest` | Rolling window equivalent of the daily report. |
| **Dollar-denominated billing** | ~~`GET /organizations/{org}/settings/billing/usage`~~ | **404 for this org** — not on the enhanced billing platform at org level. Spend is *derived*, see below. |

### The reports API is indirect

The `.../reports/...` endpoints do **not** return the data. They return short-lived
**presigned download links** to newline-delimited JSON (NDJSON) on
`copilot-reports.github.com`:

```json
{ "download_links": ["https://copilot-reports.github.com/...?sig=...&se=..."],
  "report_end_day": "2026-07-15", "report_start_day": "2026-06-18" }
```

Ingestion rules baked into `copilot/reports.ts`:

1. **`download_links` is an array — reports are sharded** (`part-00366-…`). Download and
   parse *every* link, not just `[0]`, or large orgs get silently truncated.
2. **Links expire in ~1 hour** (`se` − `st` in the URL). Fetch, stream-parse, discard.
   Never persist the link or the file — the parsed rows go straight to Postgres.
3. **`204 No Content` means "no report for that day"** — skip it, it is not an error.
   The org has no data before it started reporting (earlier days 204), so the history
   floor is discovered dynamically by walking back until the reports run dry.
4. **Recent days are mutable.** The reports come from a versioned ETL (`etl_id=green` in
   the URL); a day can be revised for ~1–3 days as late telemetry lands, then settles.
   We upsert keyed on the natural key and re-pull the trailing days each refresh.

## Enterprise billing: real dollars, one login at a time

The **enterprise-level** billing endpoints do work for this tenant (validated live
2026-07-24 against enterprise `raiffeisen`), even though the org-level one 404s:

| Need | Endpoint | Notes |
| --- | --- | --- |
| Per-user AI-credit dollars | `GET /enterprises/{ent}/settings/billing/ai_credit/usage?year&month&day&user={login}` | Per-model rows with `grossQuantity` / `grossAmount` / `discountAmount` / `netAmount`. **Only** the `?user=` form carries a username — the aggregate response drops it, so per-user data costs one request per login per day. `404` = login unknown to the enterprise (left / renamed), treated as zero usage. |
| Cost-center summary (licences) | `GET /enterprises/{ent}/settings/billing/usage/summary?year&month&day&cost_center_id=` | `copilot_for_business` user-months at $19 — real licence dollars, org-level only. Not ingested yet. |
| Budgets | `GET /enterprises/{ent}/settings/billing/budgets?scope=organization` | Current state only, no history. Not ingested yet. |

The daily **billing sync** (`services/billing-sync.ts`, kind `billing`) feeds
`billing_daily` and `model_spend_daily` from the per-user endpoint — the same tables,
keys, and nano-dollar encoding as the manual CSV import, so both sources interleave.
Because of the one-request-per-login shape, each run covers only yesterday plus the
day before (re-pulled for late-landing usage): **history bootstraps through the CSV
import; the sync keeps it current.** Licence accrual has no per-user API and stays
CSV-only. The sync runs at 07:00 Europe/Prague (`scheduler.ts`) and on
`POST /api/refresh/billing`; both need `GITHUB_ENTERPRISE` (+ a token with enterprise
billing read — org tokens usually lack it, hence the separate `GITHUB_BILLING_TOKEN`).

## Spend is derived, not fetched (when billing is not configured)

Without `GITHUB_ENTERPRISE` (and before the CSV import has supplied real rows), money
on the dashboard comes from the cost model in `packages/shared/src/cost.ts`, not from
GitHub:

- **License** = assigned seats × plan price (Business $19 / Enterprise $39) ÷ 30 per day.
  The roster is real (seats endpoint); the price is the published list price.
- **Premium / credit overage** = `premiumOverage(plan, ai_credits_used)` per seat, where
  `ai_credits_used` (28-day, from the users report) is treated as the premium-request
  proxy — the same mapping the original CSV design used (`ai_credits_used` column).
  For the daily trend the 28-day overage is spread evenly across the window.

This is an **estimate**, labelled as such in the UI. `ai_credits_used` is a credit unit,
not a dollar figure, and GitHub does not publish the credit→dollar conversion, so we do
not claim billed dollars — we claim list-price license cost plus a modelled overage.

## What lands in the database

`copilot_seats` is the roster (seats endpoint) enriched, by `login`, with the metrics
from `users-28-day`. Per-day org and per-model aggregates land in `org_daily` and
`model_daily` (from `organization-1-day`, backfilled up to 90 days). See
`apps/api/src/db/schema.ts`.

## Time ranges

GitHub's native grains are **1-day** (any past day, back to the org's floor) and
**28-day rolling**. The dashboard's 28 / 56 / 90-day selector slices the backfilled
daily org series; options are capped to the days actually available. Per-user figures
are always the 28-day rolling window (GitHub's only per-user grain).
