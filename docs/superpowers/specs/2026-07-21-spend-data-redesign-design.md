# Spend Data Redesign — Billing CSV Import + JIRA Identity

Date: 2026-07-21
Status: approved (design), pending spec review

## Problem

The dashboard's spend view is derived from a fake cost model (`PLAN_PRICE`,
`OVERAGE_RATE`, `seatPeriodCost` over seat data). Real spend now comes from
GitHub billing usage report CSVs, which carry per-user, per-day, per-sku money
(gross / discount / net) and a per-model breakdown of AI-credit usage. GitHub
logins are not meaningful to the organisation; identity must come from JIRA
Insight via `saml_name_id`.

The org-level billing API is unavailable (`GET
/organizations/{org}/settings/billing/usage` → 404; billing is managed by the
`raiffeisen` enterprise, whose endpoint has no per-org detail). **CSV import is
the spend data mechanism.** The Copilot metrics API remains the source for
usage (non-money) views, unchanged.

## Decisions made

1. **Spend source: CSV import only** (billing API revisit later; importer is
   source-agnostic so an API pull can be added behind the same persistence).
2. **JIRA: batch sync on demand into Postgres**; reads only ever hit Postgres.
3. **Scope: replace spend, keep usage.** Usage/adoption views untouched. Fake
   cost model deleted.
4. **Unmapped logins: show raw login with an "unmapped" badge**, always counted
   in totals, filterable as an "Unmapped" group.
5. **Data model: raw report rows, join in code** (approach A). No star schema,
   no pre-aggregation.
6. **Money precision: bigint nano-dollars (1e-9 USD)** end-to-end in Postgres;
   conversion to dollars happens once at the API response edge (same
   single-place rule as `toSpendPoint`). CSV amounts have up to 9 decimals, so
   integer cents cannot hold them; nano-dollars keep sums exact.
7. **Migrations regenerated from scratch.** No drop migrations; the DB is
   recreated manually.

## Source files (reference copies in `docs/reports/` of the main checkout)

| File | Content | Role |
|------|---------|------|
| `AIUsageReport_2.csv` | per-day, per-login, per-sku money rows (`copilot_ai_credit`, `copilot_for_business`, `copilot_premium_request`) | **Sole money authority** — licences live only here |
| `AIUsageReport_1.csv` | per-day, per-login, per-**model** AI-credit rows | Per-model statistics only; never summed into money totals |
| `user-export.csv` | GitHub org export: `login` → `saml_name_id` | Identity bridge |
| `jira-iql.json` | Sample Insight IQL response | JIRA parse reference |

The two reports overlap on AI-credit money. By construction they land in
separate tables and only Report 2 feeds money totals, so double counting is
impossible (user guidance #2, #3).

### CSV semantics (agreed reading)

- `gross_amount` — raw cost (credits × $0.01, or licence accrual).
- `discount_amount` — covered by the shared enterprise pool (funded by licence
  payments); not an extra charge.
- `net_amount` — the charge beyond the enterprise pool (gross − discount).
- **The displayed Net KPI covers non-licence skus only** (`copilot_ai_credit`,
  `copilot_premium_request`): it answers "what did we pay beyond the pool for
  usage". Gross 10, Discount 10 ⇒ Net 0 — the daily licence accrual does not
  leak into it. Licence money is its own KPI, never mixed into Net.
- Licence rows (`copilot_for_business`): daily accrual of a fraction of a
  user-month at $19; `discount_amount` = 0. The licence total for a range is
  the **sum of the daily licence rows in that range** — never `19 × user
  count`, because users joining mid-month accrue partial amounts and each day
  carries its own individual payment. Licence total is displayed separately
  **and** is part of overall Gross — labelled as such, never added to Gross a
  second time.
- `total_monthly_quota` = constant 1900 credits (= $19 licence) → shared const
  `MONTHLY_CREDIT_QUOTA`, not stored per row.
- Ignored columns: `product`, `unit_type`, `applied_cost_per_quantity`,
  `organization`, `repository`, `workflow_path`, `cost_center_name`,
  `aic_quantity`, `aic_gross_amount`.

## Schema

Kept unchanged: `copilot_seats`, `org_daily`, `usage_breakdown_daily`,
`adoption_phase_daily`, `model_daily`, `refresh_jobs` (gains a `kind` column),
OTLP tables. Deleted: `spend_daily`.

```
billing_daily                    -- Report 2, money authority
  date           date            not null
  login          varchar(100)    not null
  sku            varchar(40)     not null
  quantity_nano  bigint          not null  -- credits or user-months × 1e9
  gross_nano     bigint          not null  -- USD × 1e9
  discount_nano  bigint          not null
  net_nano       bigint          not null
  synced_at      timestamptz     not null default now()
  PK (date, login, sku)

model_spend_daily                -- Report 1, per-model stats only
  date           date            not null
  login          varchar(100)    not null
  model          varchar(80)     not null
  credits_nano   bigint          not null  -- ai-credit quantity × 1e9
  gross_nano     bigint          not null
  discount_nano  bigint          not null
  net_nano       bigint          not null
  synced_at      timestamptz     not null default now()
  PK (date, login, model)

github_users                     -- user-export.csv
  login          varchar(100)    PK
  saml_name_id   varchar(40)     null      -- may be blank in export
  synced_at      timestamptz     not null default now()

jira_people                      -- JIRA Insight batch sync
  saml_name_id   varchar(40)     PK        -- stored uppercase; matched case-insensitively
  first_name     varchar(100)
  last_name      varchar(100)
  department     varchar(200)
  b1_manager     varchar(200)              -- referencedObject.label verbatim
  b2_manager     varchar(200)
  jira_user_id   varchar(40)
  synced_at      timestamptz     not null default now()
```

`sku` stays `varchar`, validated at import against shared const
`BILLING_SKUS = ['copilot_ai_credit', 'copilot_for_business',
'copilot_premium_request']` — a new sku appearing in a future CSV must fail
loudly at import, not silently pass (hence no Postgres enum; the error message
names the unknown sku).

Joining `billing_daily.login → github_users.saml_name_id → jira_people` happens
in code at read time (user guidance #5). No FKs between these tables — imports
arrive in any order.

## Import pipeline

`POST /api/import/billing` — CSV body (multipart or `text/csv`).

1. Strip UTF-8 BOM; parse header.
2. Detect report type by header set: `model` column ⇒ Report 1
   (`model_spend_daily`); `workflow_path` column ⇒ Report 2 (`billing_daily`).
   Neither/both ⇒ 400.
3. Parse rows: date `YYYY-MM-DD`; decimal strings converted to nano-dollars via
   string arithmetic (split on `.`, pad to 9 digits) — **never** through
   `parseFloat`, which would reintroduce float drift.
4. Validate sku (Report 2) against `BILLING_SKUS`; reject file on unknown sku.
5. Upsert by PK in one transaction. Re-importing the same or an overlapping
   file is idempotent.
6. Response: `{ reportType, rowsUpserted, dateRange, unknownLogins }` where
   `unknownLogins` = distinct logins absent from `github_users` (informational).

`POST /api/import/users` — user-export.csv → upsert `github_users`. Blank
`saml_name_id` stored as null.

Existing `POST /api/import` (mock seats) stays as is.

## JIRA sync

`POST /api/jira/sync` — a job using the `refresh_jobs` table, which gains
`kind: 'copilot' | 'jira'` (enum column, default `'copilot'`). Single-flight
index becomes per-kind: unique on `kind` where status in
(`pending`,`running`) — a Copilot refresh and a JIRA sync may run
concurrently, but not two of the same kind.

Flow:

1. Collect distinct non-null `saml_name_id` from `github_users`.
2. Chunked IQL calls (chunks of 50):
   `GET {JIRA_BASE_URL}/rest/insight/1.0/iql/objects?objectSchemaId=9000001&includeAttributesDeep=1&iql=ObjectTypeId=9000005 AND Status=Active AND icza IN (id1,id2,…)`
   Fallback: if `IN` is rejected (400), one call per id (`icza=xxx`).
3. Parse each `objectEntries[]` entry's `attributes[]` by
   `objectTypeAttributeId`:
   - `9010057` first name, `9010056` last name (spec correction: the request
     listed 9010824 for both Department and Last Name; sample data proves
     9010824 is Department)
   - `9010824` department
   - `9010054` user id
   - `9015211` B-1 manager, `9015212` B-2 manager — via
     `objectAttributeValues[0].referencedObject.label`
   - the entry's saml id read from `9010917` (lowercase in JIRA), uppercased
     for the PK
4. Upsert `jira_people`. Ids with no hit are left absent (render unmapped).
5. Failure semantics: JIRA unreachable ⇒ job `failed` with error, existing
   `jira_people` rows untouched (stale-tolerant, same
   delete-nothing-on-failure spirit as the seat refresh).

Env (added to `env.ts` + `.env.example`): `JIRA_BASE_URL`, `JIRA_TOKEN`
(bearer). Both optional; `POST /api/jira/sync` returns 503 with a clear message
when unset. The app never calls JIRA at read time.

## Read API

`GET /api/spend?from=YYYY-MM-DD&to=YYYY-MM-DD` — one payload, fetch-once like
the rest of the app. Nano→dollar conversion happens here, in one function
(`nanoToDollars`), nowhere else.

```ts
{
  billingRows: { date, login, sku, quantity, gross, discount, net }[],   // dollars
  modelRows:   { date, login, model, credits, gross, discount, net }[],
  people: {
    login, samlNameId, displayName,      // "First Last" or raw login
    department, b1Manager, b2Manager,    // null when unmapped
    mapped: boolean
  }[]
}
```

`people` is the code-side join of `github_users` × `jira_people` (case-
insensitive on saml id), one entry per login appearing in either identity
table or in billing rows. No usage metrics in this payload (guidance #3).

## Web app

New spend section replaces the fake one. All derivation client-side in
`lib/metrics/`-style pure functions; page state joins the existing reducer.

- **KPI row — four separate dollar values** for the selected range:
  1. Gross — all skus, licences included.
  2. Discount — covered by the enterprise pool.
  3. Net — **non-licence skus only** (usage paid beyond the pool; 0 when the
     pool covers everything).
  4. Licences — sum of the daily `copilot_for_business` rows in range
     (prorated joins accrue partially; never `19 × users`); labelled
     "included in Gross".
  Never summed with each other.
- **Trend chart** — daily Gross / Discount / Net / Licence lines (Net uses the
  same non-licence definition as the KPI); existing hand-rolled SVG chart
  component, tokens from `tokens.css`.
- **Model breakdown** — from `modelRows`: credits + gross per model, share of
  credit spend. Labelled "AI credit spend by model" (licences excluded by
  nature of Report 1).
- **User table** — displayName (raw login + "unmapped" badge when
  `mapped=false`), department, B-1, B-2, credits, gross / discount / net for
  range. Client-side sort/page.
- **Filters** — department, B-1 manager, B-2 manager, single user, "Unmapped"
  group. Filtering recomputes KPIs, chart, model breakdown, table. All
  client-side.
- Nulls render as `—` (`EMPTY`), per existing invariant.

Deletions in `packages/shared`: `PLAN_PRICE`, `PREMIUM_ALLOWANCE`,
`OVERAGE_RATE`, `seatPeriodCost`, `SpendPoint` (replaced by new spend types).
Seat-cost columns disappear from usage views; usage views keep everything
non-money.

## Mock source

`COPILOT_SOURCE=mock` gains a billing generator: deterministic (Lehmer-seeded)
`billing_daily` + `model_spend_daily` + `github_users` + `jira_people` rows so
local dev shows the spend section without CSVs or JIRA. Exported to
`data/mock/*.csv` alongside the existing set.

## Error handling summary

| Failure | Behaviour |
|---------|-----------|
| Unknown sku in CSV | 400, file rejected, sku named |
| Malformed row (bad date/number) | 400 with line number, nothing imported (single transaction) |
| Wrong/ambiguous CSV headers | 400 |
| JIRA down / auth fail | sync job `failed`, old rows kept |
| JIRA `IN` unsupported | per-id fallback |
| Login without saml id / JIRA hit | rendered unmapped, counted in totals |
| `JIRA_*` env unset | `POST /api/jira/sync` → 503 |

## Testing

No test framework in repo; `pnpm typecheck` is the gate. Verification by
driving the app: import the three real CSVs, run JIRA sync against a sample
(or load `jira-iql.json` through the parser in mock mode), compare KPI totals
against spreadsheet sums of the CSVs, check an unmapped login renders with
badge, check filters recompute totals.

## Out of scope

- Enterprise billing API automation (revisit when token/entitlement exists).
- Changing usage/adoption views or the Copilot metrics ingestion (the
  daily-grain persistence idea for `users-28-day` is a separate future task).
- `aic_quantity` / `aic_gross_amount` columns (explicitly deferred).
