# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ALWAYS WORK LIKE THIS

1. NEVER WORK ON MAIN BRANCH, always create worktree using claude superpowers.
2. Always commit using conventional commits.
3. Always create a PR for changes to the branch.
3. Keep the description business focused, not implementation-focused.
4. USE GitHub MCP to create PRs, alternatively GitHub CLI. NOT git CLI,.

## Commands

`README.md` has the full command table. The essentials:

```bash
cp .env.example .env    # required before anything — both the API and compose read it
pnpm install
pnpm dev                # Postgres in Docker, then api (:4000) + web (:5173) in watch mode
pnpm typecheck          # the only automated gate in the repo
pnpm build              # recursive, dependency-ordered
```

**There is no test framework and no linter.** No vitest/jest, no eslint/prettier, zero test files.
`pnpm typecheck` is the entire verification story, so lean on the type system — `tsconfig.base.json`
turns on `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, and
`verbatimModuleSyntax`. Verify behaviour by driving the app.

Two things that will waste your time if you don't know them:

- **`pnpm dev` does not watch `packages/shared`.** It builds it once, then runs `--filter "./apps/*" dev`.
  Both apps import `@dash/shared` through its built `dist/`, so a change to the cost model or types is
  invisible until you run `pnpm --filter @dash/shared build` (or `pnpm --filter @dash/shared dev` in a
  second terminal for watch mode).
- **`pnpm typecheck` fails on a fresh clone until `packages/shared` has been built**, for the same reason.

Local scripts read `.env` via node's `--env-file`; the container gets its env from compose.

## Architecture

pnpm monorepo, three workspaces, one dependency direction: `apps/api` and `apps/web` both depend on
`packages/shared`, and never on each other.

**`packages/shared` is the contract.** `CopilotSeat`, `SpendPoint`, `RefreshJob`, and the cost model
(`PLAN_PRICE`, `PREMIUM_ALLOWANCE`, `OVERAGE_RATE`, `seatPeriodCost`, `isIdle`, …). Both sides import it,
so a price change lands in exactly one file. Its const arrays (`PLANS`, `EDITORS`, `REFRESH_STATUSES`)
are also the source of the Postgres enums in `apps/api/src/db/schema.ts` — the DB's `plan` and
`refresh_status` types are generated from them.

**The API is a thin read layer over a snapshot.** `apps/api/src/copilot/` is the only place that knows
where data comes from: `mock.ts` (seeded 1,000-seat generator, fixed Lehmer seed, no credentials) and
`github.ts` (live APIs) both implement the `CopilotClient` interface, chosen by `COPILOT_SOURCE` in
`env.ts`. `services/refresh.ts` writes; `services/dashboard.ts` reads; `routes/` is HTTP only. `index.ts`
migrates on boot and, finding an empty seat table, kicks off a seeding refresh in the background.

**Refresh is a job table, not a broker.** `POST /api/refresh` inserts a row, returns `202`, and syncs in
the background; the client polls until `succeeded`/`failed`, then invalidates its queries. The
`refresh_jobs` table is simultaneously the queue, the audit log, and the UI's "synced 2h ago" source.
Two invariants live in `services/refresh.ts` — an in-flight job is returned rather than duplicated, and
seats are deleted-then-inserted inside a transaction so a failed fetch leaves existing data untouched.

**The web app fetches everything once and derives the rest.** `useCopilotData` pulls ~1,000 seats and the
full 90-day series; `useDashboardMetrics` runs a memoised pipeline over the pure functions in
`lib/metrics/` (`filter` → `spend` → `chart` / `utilization` / `table` / `idle`). All page state lives in
one reducer (`state/dashboardState.ts`). No metric is ever stored or fetched — filtering, sorting, paging,
and range re-slicing are all client-side, deliberately (see `services/dashboard.ts:listSeats`).

## Invariants

These are load-bearing decisions, not preferences. Breaking one is a real bug.

- **Money is integer cents in Postgres.** `numeric` round-trips as a string and floats drift.
  Conversion to dollars happens once, in `toSpendPoint`.
- **Null means "unknown", never zero.** GitHub exposes no per-user `premiumRequests28d`, `acceptanceRate`,
  or `language` — `/orgs/{org}/copilot/metrics` is org-aggregate only. Those three are nullable end-to-end
  and render as `—` (`EMPTY` in `lib/format.ts`). Zero-filling would assert something false. The `mock`
  source fills all three, so local dev looks like the prototype and live GitHub does not.
- **`last_activity_at` is stored as a timestamp; "days ago" is derived at read time.** Storing the day
  count would go stale overnight.
- **Every colour, radius, and font comes from `apps/web/src/styles/tokens.css`** — the Nocturne token
  layer. No hex literals in components. CSS Modules, no UI framework.
- **Charts are hand-rolled SVG** (`lib/metrics/chart.ts` + `SpendTrendChart`), not a charting library —
  the prototype's path maths ports directly and keeps the design pixel-exact with zero dependencies.
- **Nothing outside `apps/api/src/copilot/` may know which data source is active.**

## Design sources

The design files live in **`.claude/design/`** and **`.claude/design-system/`** — `README.md` and
`docs/handoff.md` refer to them as `design/` and `design-system/` at the repo root, which is stale.

- `.claude/design/GitHub Copilot Spend.dc.html` — the hi-fi prototype. Its `<script data-dc-script>` block
  holds `buildData()` and `renderVals()`, which the mock generator and `lib/metrics/` are ports of.
- `.claude/design-system/styles.css` — the Nocturne token sheet, source of truth for every value.
- `docs/handoff.md` — the spec of record, kept verbatim, with `[impl]` sections recording where reality
  diverged. Its **Data gaps** and **Open questions** sections are the ones worth reading before changing
  anything about nullability, the utilisation buckets, or the sync affordance.

The design is high-fidelity and final — colours, typography, spacing, and interactions are specified to
the pixel. Match the handoff rather than improvising.

## Gotchas

- **Don't run the `full` compose profile while `pnpm dev` is running** — both bind :4000. `docker compose
  up` starts Postgres only by design; `pnpm stack:up` is how you start the API container, and it pairs
  with `pnpm dev:web`.
- **`COPILOT_SOURCE=github` refuses to boot without `GITHUB_TOKEN` + `GITHUB_ORG`** (`env.ts` refine).
  The token needs `manage_billing:copilot`.
- **`apps/api/src/copilot/github.ts` has never been run against a live org** — it is written against the
  documented API shapes only.
- **Edit `db/schema.ts`, then run `pnpm db:generate`** to regenerate SQL migrations. The API also migrates
  on boot, so `pnpm db:migrate` is only needed standalone.
- **`graphify-out/` is a generated knowledge graph**, not source. Ignore it unless working with `/graphify`.
