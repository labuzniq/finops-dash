# Copilot Usage Views — Design

**Date:** 2026-07-20
**Status:** Approved (approach A)

## Goal

Surface everything the GitHub Copilot metrics reports API provides as charts on the
existing Copilot dashboard page: per-IDE, per-language, per-feature, per-model daily
activity, org activity/cohort trends, AI adoption phases, pull-request stats, and a
seats-by-team view. Many small single-purpose graphs, not combined ones. The existing
FilterBar date range is the single global range for every chart; no per-chart date
filters.

## Verified source data (org `RBCZ-copilots`, live)

- Legacy `/orgs/{org}/copilot/metrics` and `/copilot/usage` endpoints **404** — the
  metrics **reports** API (presigned NDJSON) is the only live source, and the app
  already uses it (`apps/api/src/copilot/reports.ts`).
- `organization-1-day?day=YYYY-MM-DD` (backfillable, one row per day) carries:
  - `daily/weekly/monthly_active_users`, `monthly_active_chat_users`,
    `monthly_active_agent_users`, `*_active_copilot_code_review_users`,
    `*_passive_copilot_code_review_users`, `*_active_copilot_cloud_agent_users`
  - `user_initiated_interaction_count`, `code_generation_activity_count`,
    `code_acceptance_activity_count`, `loc_added_sum`, `loc_deleted_sum`,
    `loc_suggested_to_add_sum`, `loc_suggested_to_delete_sum`
  - `totals_by_ide`, `totals_by_feature`, `totals_by_language_model`,
    `totals_by_language_feature`, `totals_by_model_feature`,
    `totals_by_ai_adoption_phase`
  - `pull_requests` (all counters zero for this org today)
- `users-28-day/latest` is **per-user-per-day** (28 rows per active user), not one
  row per user.
- Seats endpoint additionally provides `assigning_team` and
  `pending_cancellation_date` (currently unused; this design uses the team name).

## Decisions (user-confirmed)

1. New charts extend the existing Copilot page (below the current dashboard), no new
   sidebar page.
2. PR stats chart included with an empty state ("No PR activity yet") while all-zero.
3. Seats-by-team view included.
4. "All metrics, many charts": each dimension gets separate charts for generations,
   acceptances, and LOC — no mixed-kind graphs.
5. Storage approach A: one generic breakdown table (see below), one `/api/usage`
   endpoint, one generic `TrendChart` component.

## Data model (Drizzle, `apps/api/src/db/schema.ts`)

New table `usage_breakdown_daily`, PK `(date, dimension, key)`:

| column | type | notes |
|---|---|---|
| date | date | report day |
| dimension | varchar(20) | `ide` \| `language` \| `feature` \| `model` |
| key | varchar(80) | e.g. `vscode`, `python`, `chat_panel_agent_mode`, `claude-4.5-haiku` |
| interactions | integer | `user_initiated_interaction_count` (0 where the source array lacks it) |
| generations | integer | |
| acceptances | integer | |
| locAdded / locDeleted | integer | |
| locSuggestedAdd / locSuggestedDelete | integer | |
| syncedAt | timestamptz | |

Fill rules per dimension (from `organization-1-day` rows):
- `ide` ← `totals_by_ide` (drop the `last_known_*_version` objects)
- `feature` ← `totals_by_feature`
- `language` ← `totals_by_language_model` summed over models
- `model` ← `totals_by_model_feature` summed over features
- GitHub noise labels (`others`, `unknown`, `none`, empty) are excluded, matching the
  existing `NOISE_LABELS` convention.

New table `adoption_phase_daily`, PK `(date, phaseNumber)`: `phase` (varchar),
`engagedUsers` (integer), plus the report's per-phase averages
(`avgInteractions`, `avgGenerations`, `avgAcceptances`, `avgLocAdded`,
`avgLocDeleted`, `avgPrCreated`, `avgPrReviewed`) as `doublePrecision`.

`org_daily` gains columns (all integer, not null, default 0 for migration of
existing rows): `locSuggestedAdd`, `locSuggestedDelete`, `chatMau`, `agentMau`,
`codeReviewDau`, `codeReviewWau`, `codeReviewMau`, `codeReviewPassiveMau`,
`cloudAgentDau`, `cloudAgentWau`, `cloudAgentMau`, `prCreated`, `prMerged`,
`prCreatedByCopilot`, `prMergedCreatedByCopilot`, `prReviewedByCopilot`,
`prCopilotSuggestions`, `prCopilotAppliedSuggestions`.

`copilot_seats` gains nullable `team` varchar(120) (from `assigning_team.name`;
null when GitHub reports none).

`model_daily` and the existing ModelTable stay untouched. The `model` dimension in
`usage_breakdown_daily` overlaps it but carries richer metrics; consolidating
ModelTable onto it is deliberately out of scope.

Migrations generated with `pnpm db:generate`.

## Snapshot contract (`apps/api/src/copilot/types.ts`)

- `SeatSnapshot` + `team: string | null`
- `OrgDailySnapshot` + the new org_daily fields above
- New `BreakdownDailySnapshot { date, dimension, key, ...metrics }`
- New `AdoptionPhaseDailySnapshot { date, phaseNumber, phase, engagedUsers, ...avgs }`
- `CopilotSnapshot` + `breakdownDaily: BreakdownDailySnapshot[]` and
  `adoptionDaily: AdoptionPhaseDailySnapshot[]`

Both clients must satisfy the widened contract:
- **github.ts** parses the extra fields out of the same `organization-1-day` rows it
  already downloads (no new report fetches for the daily history) and reads
  `assigning_team` in `fetchRoster`.
- **mock.ts** generates all new fields with the existing seeded Lehmer generator:
  plausible per-day breakdowns for ~8 languages / 4 IDEs / 6 features / 4 models,
  3 adoption phases, cohort counts consistent with DAU, a handful of teams assigned
  to seats, and modest non-zero PR numbers (so the PR chart is demonstrable in dev;
  the live org exercises the empty state).

### Bug fix folded in: users-28-day aggregation

`github.ts:fetchUserMetrics` currently keys rows by login into a `Map`, so each
per-day row overwrites the previous one and every per-user metric (acceptance rate,
`premiumRequests28d`, editor, language, topModel, usedAgent/usedChat) reflects only
the user's **last active day**. Fix: aggregate all rows per login — sum counts and
`ai_credits_used`, OR the booleans, and run the `dominant()` picks over the
concatenated breakdown arrays — then derive metrics once from the aggregate.

## Refresh (`apps/api/src/services/refresh.ts`)

The existing delete-then-insert transaction grows two more tables
(`usage_breakdown_daily`, `adoption_phase_daily`) with the same semantics: a failed
fetch leaves all existing data untouched.

## API (`routes/dashboard.ts`, `services/dashboard.ts`)

One new endpoint, `GET /api/usage`, returning the full stored history (90 days) in
one payload — the client slices by range, matching the "fetch once, derive the rest"
philosophy:

```ts
{
  orgDaily: OrgDailyPoint[];        // extended org_daily rows
  breakdowns: BreakdownPoint[];     // usage_breakdown_daily rows
  adoption: AdoptionPhasePoint[];   // adoption_phase_daily rows
}
```

Shared response types live in `packages/shared` next to `SpendPoint`. Payload is
tens of KB — no pagination.

## Web (`apps/web`)

### Data flow

- New `useUsage()` query in `useCopilotData.ts` fetches `/api/usage` once.
- New pure helpers in `lib/metrics/usage.ts`: slice rows to the global range
  (`state.range` / custom range from the existing reducer — same slicing rule
  `summariseSpend` uses), pivot breakdown rows into per-key series, rank keys by
  total and fold the tail into "Other" (top 8), and compute the org acceptance-rate
  series (`acceptances / generations`, null on zero-generation days).
- The FilterBar's editor/language/search filters keep applying to seat-derived
  views only (tables, donut, wasted spend, teams). Report breakdowns are
  org-aggregate and cannot be seat-filtered — they respond to the date range only.
  A short caption on the section header states this.

### Components

- `TrendChart` — generic multi-series line chart generalised from
  `lib/metrics/chart.ts` + `SpendTrendChart` + `ChartHoverLayer`: hand-rolled SVG,
  Card wrapper, Nocturne tokens only, legend, hover crosshair + tooltip, empty-state
  message prop. Series colours from the existing categorical token ramp.
- `TeamsPanel` — Card with a bar list: seats per team, active-% per team (active =
  activity within 28d, same rule as utilization). Derived from `filteredSeats`, so
  the seat filters apply. Range-independent (roster data, no history).
- Existing components untouched.

### Page sections (Copilot page, below current content)

Section headers group the charts; every chart is single-metric:

1. **Org activity** — DAU/WAU/MAU · interactions · generations · acceptances ·
   acceptance-rate % · LOC added/deleted · LOC suggested add/delete
2. **Engaged cohorts** — chat vs agent MAU · code-review users (active/passive) ·
   cloud-agent users
3. **By IDE** — generations · acceptances · LOC added (one line per IDE)
4. **By language** — generations · acceptances · LOC added (top 8 + Other)
5. **By feature** — generations · acceptances · interactions
6. **By model** — generations · acceptances · LOC added
7. **Adoption phases** — engaged users per phase over time
8. **Pull requests** — created/merged · Copilot-created/-reviewed · suggestions
   applied; whole section renders one empty-state card when every value is zero
9. **Teams** — TeamsPanel

(LOC deleted / suggested-delete ride as second lines in the LOC charts — same unit,
same kind. Feature charts use interactions instead of LOC because chat features
suggest little code.)

~24 charts. Layout: two-column grid (`App.module.css` split pattern), stacking to
one column on narrow viewports, consistent with the existing page.

## Out of scope

- Consolidating `model_daily` / ModelTable onto the new table
- Team as a FilterBar filter
- Per-user per-day history (users report day rows beyond the aggregation fix)
- CSV export of usage series

## Verification

`pnpm typecheck`; drive the app with `COPILOT_SOURCE=mock` (all charts populated,
PR chart non-zero); then a live refresh against `RBCZ-copilots` (PR section shows
empty state, teams populated from real `assigning_team`).
