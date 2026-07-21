# Spend Data Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This run executes via ultracode Workflow orchestration — one subagent per task, sequential within a package, reviews fan out in parallel.

**Goal:** Replace the fake seat-derived spend model with real billing-report data (CSV import), enrich users via a JIRA Insight batch sync, and rebuild the spend UI on the 4-value money model (Gross / Discount / Net / Licences) with org-structure filters.

**Architecture:** Two raw fact tables mirror the billing CSVs (Report 2 = sole money authority incl. licences; Report 1 = per-model stats only). Identity is two lookup tables (`github_users`, `jira_people`) joined **in code** at read time. Money is bigint nano-dollars (1e-9 USD) in Postgres; dollars appear exactly once, at the API response edge. Client fetches one `/api/spend` payload and derives everything (KPIs, trend, model breakdown, user table, filters) in pure functions, matching the existing fetch-once philosophy.

**Tech Stack:** Existing only — Drizzle/Postgres, Fastify-style routes in `apps/api`, React + CSS Modules in `apps/web`, `@dash/shared` contract package. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-21-spend-data-redesign-design.md` — read it fully before any task. It is the authority; this plan is the work breakdown.

## Global Constraints

- `pnpm typecheck` is the only automated gate; it must pass at every commit. Build shared first: `pnpm --filter @dash/shared build && pnpm typecheck`.
- Money: bigint nano-dollars in DB and API internals; parse CSV decimals via **string arithmetic** (split on `.`, right-pad fraction to 9 digits) — `parseFloat` is forbidden for money. Convert to dollars only in `nanoToDollars` at the response edge.
- Never sum Report 1 (`model_spend_daily`) into money totals. Report 2 (`billing_daily`) is the only money source.
- Net KPI/trend = non-licence skus only. Licence KPI = sum of daily `copilot_for_business` rows in range — never `19 × users`.
- Null means unknown, renders `—` (`EMPTY`). No zero-filling.
- All styling from `apps/web/src/styles/tokens.css`; no hex literals; hand-rolled SVG charts.
- Migrations regenerated **from scratch** (delete `apps/api/drizzle/`, single fresh `0000_*.sql`); no drop migrations; strip `"public".` qualifiers from generated SQL. User recreates the DB manually.
- Conventional commits, one per task minimum.
- Sample data for parsers (read-only, outside worktree): `/Users/martin/Workspace/Dash/docs/reports/AIUsageReport_1.csv`, `AIUsageReport_2.csv`, `user-export.csv`, `jira-iql.json`.

---

### Task 1: Shared contract — spend types, billing consts, delete fake cost model

**Files:**
- Create: `packages/shared/src/spend.ts`
- Modify: `packages/shared/src/types.ts` (remove `SpendPoint`, add `RefreshKind`; extend `RefreshJob` with `kind`), `packages/shared/src/index.ts` (exports)
- Delete: `packages/shared/src/cost.ts` (keep `isIdle` — move it to `packages/shared/src/idle.ts` if it lives in cost.ts; check first)

**Produces (verbatim contract — later tasks depend on these exact names):**

```ts
// packages/shared/src/spend.ts
export const BILLING_SKUS = ['copilot_ai_credit', 'copilot_for_business', 'copilot_premium_request'] as const;
export type BillingSku = (typeof BILLING_SKUS)[number];
export const LICENCE_SKU = 'copilot_for_business' satisfies BillingSku;
export const MONTHLY_CREDIT_QUOTA = 1900;

/** One Report-2 row, dollars (converted once, server-side). */
export interface BillingRow {
  date: string; // YYYY-MM-DD
  login: string;
  sku: BillingSku;
  quantity: number;
  gross: number;
  discount: number;
  net: number;
}

/** One Report-1 row, per-model AI-credit stats. Never summed into money totals. */
export interface ModelSpendRow {
  date: string;
  login: string;
  model: string;
  credits: number;
  gross: number;
  discount: number;
  net: number;
}

export interface SpendPerson {
  login: string;
  samlNameId: string | null;
  displayName: string; // "First Last" when mapped, raw login otherwise
  department: string | null;
  b1Manager: string | null;
  b2Manager: string | null;
  mapped: boolean;
}

export interface SpendPayload {
  billingRows: BillingRow[];
  modelRows: ModelSpendRow[];
  people: SpendPerson[];
}
```

```ts
// types.ts additions
export const REFRESH_KINDS = ['copilot', 'jira'] as const;
export type RefreshKind = (typeof REFRESH_KINDS)[number];
// RefreshJob gains: kind: RefreshKind
```

Deletions: `PLAN_PRICE`, `PREMIUM_ALLOWANCE`, `OVERAGE_RATE`, `seatPeriodCost`, `SpendPoint`, and any other fake-cost export. Downstream breakage in `apps/web`/`apps/api` is expected and fixed in Tasks 4–6 — this task only keeps `packages/shared` itself compiling (`pnpm --filter @dash/shared build`). Do NOT run repo-wide typecheck as the gate here.

- [ ] Implement, `pnpm --filter @dash/shared build` passes
- [ ] Commit `feat(shared): spend contract for billing reports; drop fake cost model`

### Task 2: DB schema + fresh migrations

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Regenerate: `apps/api/drizzle/` (delete directory, then `pnpm db:generate`)

**Consumes:** Task 1 (`REFRESH_KINDS` for the `refresh_kind` pg enum).

**Produces:** Drizzle tables `billingDaily`, `modelSpendDaily`, `githubUsers`, `jiraPeople` exactly as speced (bigint columns use `{ mode: 'bigint' }`); `spendDaily` removed; `refreshJobs` gains `kind: refreshKindEnum` default `'copilot'`, and the single-flight unique index becomes per-kind: `uniqueIndex(...).on(table.kind).where(status in ('pending','running'))`. Export row/insert types: `BillingDailyRow/Insert`, `ModelSpendDailyRow/Insert`, `GithubUserRow/Insert`, `JiraPersonRow/Insert`.

Steps: edit schema → delete `apps/api/drizzle/` → `pnpm db:generate` → strip `"public".` qualifiers from the generated SQL → fix any api compile errors caused by `spendDaily` removal **only where trivial** (leave `services/dashboard.ts` spend logic for Task 4 if it needs real rework; a temporary minimal stub returning empty spend is acceptable to keep typecheck green).

- [ ] `pnpm --filter @dash/shared build && pnpm typecheck` passes
- [ ] Commit `feat(api): billing + identity schema, per-kind refresh jobs, fresh migrations`

### Task 3: CSV importers (billing reports + user export)

**Files:**
- Create: `apps/api/src/services/billing-import.ts`, `apps/api/src/lib/nano.ts`
- Modify: `apps/api/src/routes/import.ts` (add `POST /api/import/billing`, `POST /api/import/users`), `apps/api/src/services/import.ts` only if shared helpers exist there

**Consumes:** Task 2 tables.

**Produces:**

```ts
// lib/nano.ts
export function parseNano(decimal: string): bigint; // string arithmetic; ≤9 frac digits, else throws; handles negatives
export function nanoToDollars(nano: bigint): number;
```

```ts
// services/billing-import.ts
export type BillingReportType = 'model' | 'billing'; // Report 1 | Report 2
export interface ImportResult {
  reportType: BillingReportType;
  rowsUpserted: number;
  dateRange: { from: string; to: string };
  unknownLogins: string[];
}
export function importBillingCsv(csv: string): Promise<ImportResult>;
export function importUserExportCsv(csv: string): Promise<{ rowsUpserted: number }>;
```

Behaviour (spec §Import pipeline): strip BOM; detect type by header (`model` ⇒ Report 1, `workflow_path` ⇒ Report 2, neither/both ⇒ 400); validate sku against `BILLING_SKUS` (reject file, name the sku); malformed row ⇒ 400 with line number, nothing imported (single transaction); upsert by PK, idempotent; `unknownLogins` = distinct logins absent from `github_users`. Quoted-CSV parsing: follow whatever `services/import.ts` already does for seats (reuse its parser if extractable). Verify against real sample files (paths in Global Constraints) by running the parser via `node`/`tsx` one-off — totals must match `awk` sums of the CSV within exact nano arithmetic.

- [ ] Typecheck green, parser verified against all three sample CSVs
- [ ] Commit `feat(api): billing report + user export CSV import`

### Task 4: JIRA sync job + spend read endpoint + mock + fake-spend removal (api)

**Files:**
- Create: `apps/api/src/jira/client.ts`, `apps/api/src/services/jira-sync.ts`, `apps/api/src/services/spend.ts`, `apps/api/src/routes/jira.ts`, `apps/api/src/routes/spend.ts`
- Modify: `apps/api/src/env.ts` (`JIRA_BASE_URL`, `JIRA_TOKEN`, both optional), `apps/api/src/services/refresh.ts` (kind-aware jobs), `apps/api/src/services/dashboard.ts` (remove fake spend), route registration in `apps/api/src/index.ts`, `apps/api/src/copilot/mock.ts` + `apps/api/src/mock-export*` (billing/user mock generation), `.env.example`

**Consumes:** Tasks 1–3.

**Produces:**

```ts
// services/spend.ts
export function getSpend(from: string, to: string): Promise<SpendPayload>; // dollars via nanoToDollars, people join per spec §Read API
// services/jira-sync.ts
export function startJiraSync(): Promise<RefreshJob>; // refresh_jobs row kind='jira', single-flight per kind
```

JIRA flow per spec §JIRA sync: distinct saml ids → chunked IQL `IN` (50), per-id fallback on 400; attribute ids 9010057/9010056/9010824/9010054/9015211/9015212 (managers via `objectAttributeValues[0].referencedObject.label`), saml PK from 9010917 uppercased; upsert; failure keeps old rows; env unset ⇒ route 503. Mock mode: when `COPILOT_SOURCE=mock` and JIRA env unset, sync generates deterministic (Lehmer-seeded) `jira_people` rows for mock logins instead of calling JIRA; mock export script additionally emits `AIUsageReport_1.csv`, `AIUsageReport_2.csv`, `user-export.csv` into `data/mock/`. Old `GET` dashboard spend response fields and `spend_daily` reads removed; `routes/dashboard.ts` slims accordingly.

- [ ] Typecheck green; jira parser verified against `/Users/martin/Workspace/Dash/docs/reports/jira-iql.json` via one-off script
- [ ] Commit `feat(api): jira identity sync, spend endpoint, mock billing source`

### Task 5: Web data layer + pure spend metrics

**Files:**
- Create: `apps/web/src/hooks/useSpendData.ts`, `apps/web/src/lib/metrics/spendFilter.ts`
- Rewrite: `apps/web/src/lib/metrics/spend.ts`
- Modify: `apps/web/src/api/client.ts` (`fetchSpend(from, to): Promise<SpendPayload>`), `apps/web/src/state/dashboardState.ts` (spend filter state), `apps/web/src/hooks/useCopilotData.ts` / `useDashboardMetrics.ts` (detach from deleted `SpendPoint`/cost model), `apps/web/src/lib/metrics/{chart,table,idle,telemetry}.ts`, `apps/web/src/lib/exportCsv.ts` (drop cost-model usages)

**Consumes:** Task 1 types, Task 4 endpoint.

**Produces (pure functions, memo-friendly, exact names for Task 6):**

```ts
// lib/metrics/spend.ts
export interface SpendKpis { gross: number; discount: number; net: number; licence: number; } // net = non-licence skus only
export interface SpendTrendDay { date: string; gross: number; discount: number; net: number; licence: number; }
export interface ModelBreakdownRow { model: string; credits: number; gross: number; share: number; } // share of credit gross
export interface SpendUserRow {
  login: string; displayName: string; mapped: boolean;
  department: string | null; b1Manager: string | null; b2Manager: string | null;
  credits: number; gross: number; discount: number; net: number; licence: number;
}
export function spendKpis(rows: BillingRow[]): SpendKpis;
export function spendTrend(rows: BillingRow[], from: string, to: string): SpendTrendDay[]; // zero-filled days in range
export function modelBreakdown(rows: ModelSpendRow[]): ModelBreakdownRow[];
export function spendUserRows(billing: BillingRow[], models: ModelSpendRow[], people: SpendPerson[]): SpendUserRow[];

// lib/metrics/spendFilter.ts
export interface SpendFilters { department: string | null; b1Manager: string | null; b2Manager: string | null; login: string | null; unmappedOnly: boolean; }
export function filterLogins(people: SpendPerson[], f: SpendFilters): Set<string> | null; // null = no filter
export function applySpendFilter<T extends { login: string }>(rows: T[], logins: Set<string> | null): T[];
```

Filters restrict the login set; KPIs/trend/model breakdown/user table all recompute from filtered rows (spec §Web app). State: filter fields + spend date range join the existing reducer.

- [ ] Typecheck green (web may still fail on components — those are Task 6; keep this task's files green and note remaining component errors for Task 6)
- [ ] Commit `feat(web): spend data layer and pure metric derivations`

### Task 6: Web UI — spend section, filters, cost-column removal

**Files:**
- Create: `apps/web/src/components/spend/` (KPI row, trend wiring, model breakdown, user table, filter bar — split per existing component granularity, CSS Modules per file)
- Modify: whichever page/section component hosts the old spend UI (locate via old `SpendTrendChart` usage), `apps/web/src/components/UserTable.tsx` + `modal/ManualEntryTab.tsx` (drop cost columns/logic), delete dead fake-spend components

**Consumes:** Task 5 functions/types verbatim.

Behaviour per spec §Web app: 4 KPI values never summed with each other; licence labelled "included in Gross"; 4-line trend on the existing hand-rolled SVG chart (extend the chart component for N series if it is 2-series today — keep path maths); model table labelled "AI credit spend by model"; user table shows displayName + "unmapped" badge, `—` for nulls; filters: department, B-1, B-2, single user, Unmapped group — all client-side, recompute everything. Tokens only, no hex.

- [ ] `pnpm --filter @dash/shared build && pnpm typecheck` fully green (whole repo)
- [ ] Commit `feat(web): spend section on billing data with org-structure filters`

### Task 7: End-to-end verification

Drive the app (mock source): `cp .env.example .env` if needed, `pnpm dev`; import the three real CSVs via curl to `/api/import/*`; `POST /api/jira/sync` (mock mode); open dashboard: KPI totals must equal independent `awk`/`python` sums over the CSVs (gross all-sku; discount; net non-licence; licence daily sum); unmapped login shows badge; filters recompute totals; re-import same CSV → identical totals (idempotency). Fix whatever this surfaces; commit fixes individually.

- [ ] All checks pass, evidence captured in final report
- [ ] PR from `worktree-spend-data-redesign` to `main` via GitHub CLI/MCP, business-focused description
