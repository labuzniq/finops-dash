# Copilot Usage Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chart every dimension the Copilot metrics reports API provides — per-IDE/language/feature/model daily activity, org cohorts, adoption phases, PR stats, seats-by-team — on the existing Copilot page, all sliced by the existing global date range.

**Architecture:** Approach A from the spec (`docs/superpowers/specs/2026-07-20-copilot-usage-views-design.md`): one generic `usage_breakdown_daily` table + `adoption_phase_daily` + widened `org_daily`/`copilot_seats`; one `GET /api/usage` endpoint returning full 90d history; client slices by the FilterBar range; one generic `TrendChart` SVG component instantiated ~24 times in grouped sections.

**Tech Stack:** Fastify + Drizzle + Postgres, React + TanStack Query, hand-rolled SVG, CSS Modules with Nocturne tokens. No test framework — `pnpm typecheck` is the gate; behaviour verified by driving the app (mock + live).

## Global Constraints

- Verification: `pnpm typecheck` after every task; `pnpm --filter @dash/shared build` after any `packages/shared` change (apps consume its `dist/`).
- Integer counts in Postgres; no floats for money (unchanged here — no new money columns).
- Null means unknown, never zero, for seat-level fields; report counts are true zeros and stay non-null.
- Every colour/radius/font from `apps/web/src/styles/tokens.css`; no hex literals in components; CSS Modules.
- Charts are hand-rolled SVG in the fixed 900×240 viewbox pattern (`lib/metrics/chart.ts`).
- Nothing outside `apps/api/src/copilot/` knows the data source.
- Conventional commits; commit per task.
- Noise labels (`others`, `unknown`, `none`, ``) excluded from breakdowns, matching `NOISE_LABELS` in `github.ts`.

---

### Task 1: Shared types

**Files:**
- Modify: `packages/shared/src/types.ts`

**Produces (exact):**

```ts
export const USAGE_DIMENSIONS = ['ide', 'language', 'feature', 'model'] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

/** One day of one category's activity within a breakdown dimension. */
export interface BreakdownPoint {
  date: string;            // ISO YYYY-MM-DD
  dimension: UsageDimension;
  key: string;             // e.g. 'vscode', 'python', 'chat_panel_agent_mode', 'claude-sonnet-5'
  interactions: number;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
  locSuggestedAdd: number;
  locSuggestedDelete: number;
}

/** One day of one AI-adoption phase (org report `totals_by_ai_adoption_phase`). */
export interface AdoptionPhasePoint {
  date: string;
  phaseNumber: number;
  phase: string;           // e.g. 'Phase 1'
  engagedUsers: number;
  avgInteractions: number;
  avgGenerations: number;
  avgAcceptances: number;
  avgLocAdded: number;
  avgLocDeleted: number;
  avgPrCreated: number;
  avgPrReviewed: number;
}

/** Everything /api/usage returns — full stored history, sliced client-side. */
export interface UsageHistory {
  orgDaily: OrgDailyPoint[];
  breakdowns: BreakdownPoint[];
  adoption: AdoptionPhasePoint[];
}
```

`OrgDailyPoint` gains (all `number`): `locSuggestedAdd`, `locSuggestedDelete`, `chatMau`, `agentMau`, `codeReviewDau`, `codeReviewWau`, `codeReviewMau`, `codeReviewPassiveMau`, `cloudAgentDau`, `cloudAgentWau`, `cloudAgentMau`, `prCreated`, `prMerged`, `prCreatedByCopilot`, `prMergedCreatedByCopilot`, `prReviewedByCopilot`, `prCopilotSuggestions`, `prCopilotAppliedSuggestions`.

`CopilotSeat` gains `team: string | null` (assigning team name; null when GitHub reports none).

**Steps:**
- [ ] Edit types; `pnpm --filter @dash/shared build && pnpm typecheck` — expect failures only where consumers construct these types (fix in later tasks; if any current construction breaks now — `mock.ts`, `github.ts`, `dashboard.ts` `toSeat` — stub the new fields with 0/null in this task so typecheck passes).
- [ ] Commit `feat(shared): usage breakdown, adoption phase, extended org daily types`

### Task 2: DB schema + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Generated: `apps/api/drizzle/****_*.sql` via `pnpm db:generate`

**Produces:** tables `usage_breakdown_daily` (PK `(date, dimension, key)`; `dimension` varchar(20), `key` varchar(80), 7 integer metric columns, `synced_at`), `adoption_phase_daily` (PK `(date, phase_number)`; `phase` varchar(40), `engaged_users` integer, 7 `doublePrecision` avg columns, `synced_at`); `org_daily` + 18 integer columns `.notNull().default(0)`; `copilot_seats` + `team` varchar(120) nullable. Export row/insert types: `UsageBreakdownRow/Insert`, `AdoptionPhaseRow/Insert`.

**Steps:**
- [ ] Edit schema, run `pnpm db:generate`, inspect generated SQL.
- [ ] `pnpm typecheck`
- [ ] Commit `feat(api): schema for usage breakdowns, adoption phases, org cohorts, seat team`

### Task 3: Snapshot contract + github client

**Files:**
- Modify: `apps/api/src/copilot/types.ts`, `apps/api/src/copilot/github.ts`

**Produces:**
- `SeatSnapshot` + `team: string | null`; `OrgDailySnapshot` + the 18 new fields; new `BreakdownDailySnapshot` and `AdoptionPhaseDailySnapshot` (mirror shared types minus nothing); `CopilotSnapshot` + `breakdownDaily: BreakdownDailySnapshot[]`, `adoptionDaily: AdoptionPhaseDailySnapshot[]`.
- `github.ts`:
  - `GithubSeat` + `assigning_team?: { name?: string | null } | null`; `fetchRoster` fills `team`.
  - `OrgReportRow` widened with the cohort/user-count fields, `loc_suggested_*`, `totals_by_ide`, `totals_by_feature`, `totals_by_model_feature`, `totals_by_ai_adoption_phase` (`{ phase, phase_number, total_engaged_users, avg_* }`), `pull_requests` (`{ total_created, total_merged, total_created_by_copilot, total_merged_created_by_copilot, total_reviewed_by_copilot, total_copilot_suggestions, total_copilot_applied_suggestions }`).
  - `orgSnapshot(row)` maps the new fields (`?? 0`).
  - New `breakdownSnapshots(row): BreakdownDailySnapshot[]` — `ide` ← `totals_by_ide`, `feature` ← `totals_by_feature`, `language` ← `totals_by_language_model` summed over models, `model` ← `totals_by_model_feature` summed over features; noise labels skipped; missing counts 0.
  - New `adoptionSnapshots(row): AdoptionPhaseDailySnapshot[]`.
  - `fetchDailyHistory` accumulates both new arrays into the returned snapshot.
  - **Bug fix** `fetchUserMetrics`: users-28-day rows are per-user-per-day. Group rows by `user_login`, merge each group (sum `ai_credits_used`/counts, OR `used_agent`/`used_chat`, concat the `totals_by_*` arrays), then call `metricsFromUserRow` once on the merged row.

**Steps:**
- [ ] Edit both files; `pnpm typecheck`
- [ ] Commit `feat(api): parse breakdown, adoption, cohort and team data from reports; fix per-day user metrics aggregation`

### Task 4: Mock client parity

**Files:**
- Modify: `apps/api/src/copilot/mock.ts`

**Produces:** mock snapshot fills every new field with the seeded generator:
- `TEAM_WEIGHTS` (~6 names, e.g. `platform`, `payments`, `mobile`, `data`, `web`, `infra`); active seats get a team, `never` seats 30% null.
- `buildOrgDaily` fills cohorts as fractions of DAU/MAU (chatMau ≈ 0.7·mau, agentMau ≈ 0.45·mau, codeReview* small, cloudAgent* smaller), `locSuggested*` ≈ 1.3×locAdded, and modest non-zero PR numbers (a few per day, Copilot-created a fraction of created).
- New `buildBreakdownDaily(org, random)` distributing each day's interactions/generations/acceptances/LOC across `IDE_KEYS` (`vscode`, `jetbrains`, `visual_studio`, `neovim`), `LANGUAGE_WEIGHTS` keys, `FEATURE_WEIGHTS` (`code_completion` 0.4, `chat_panel_agent_mode` 0.25, `chat_panel_ask_mode` 0.12, `agent_edit` 0.1, `copilot_cli` 0.08, `chat_inline` 0.05), `MODEL_WEIGHTS` keys — one `BreakdownDailySnapshot` per (day, dimension, key), jittered like `buildModelDaily`.
- New `buildAdoptionDaily(org, random)`: 3 phases splitting ~engaged users 0.5/0.3/0.2 with plausible avgs.

**Steps:**
- [ ] Edit; `pnpm typecheck`
- [ ] Commit `feat(api): mock source generates usage breakdowns, adoption phases, cohorts, teams`

### Task 5: Persist + serve

**Files:**
- Modify: `apps/api/src/services/refresh.ts`, `apps/api/src/services/dashboard.ts`, `apps/api/src/routes/dashboard.ts`

**Produces:**
- `persistSnapshot`: inside the existing transaction, `delete` + bulk `insert` `usageBreakdownDaily` and `adoptionPhaseDaily` (delete-then-insert; day set may shrink), seats insert includes `team`, orgDaily upsert `set` includes the 18 new columns.
- `services/dashboard.ts`: `toSeat` maps `team`; new `getUsageHistory(days: number): Promise<UsageHistory>` reading the three tables with `gte(date, earliestDate(days))`, ordered by date.
- `routes/dashboard.ts`: `app.get('/api/usage', …)` using existing `daysQuery` (default 90) → `{ usage: await getUsageHistory(days) }`.

**Steps:**
- [ ] Edit; `pnpm typecheck`
- [ ] `docker compose up -d db` (if not running); `pnpm --filter @dash/api dev` briefly with `COPILOT_SOURCE=mock`: boot migrates, seeds; `curl localhost:4000/api/usage | head -c 400` returns rows.
- [ ] Commit `feat(api): persist and serve usage history via /api/usage`

### Task 6: Web data plumbing

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/hooks/useCopilotData.ts`

**Produces:**
- `client.ts`: `fetchUsage(days: number): Promise<UsageHistory>` (`GET /usage?days=…`, unwraps `{ usage }`).
- `useCopilotData.ts`: `export function useUsage()` — `useQuery<UsageHistory>({ queryKey: ['usage', SERIES_DAYS], queryFn: () => fetchUsage(SERIES_DAYS) })`; `['usage']` added to both invalidation sites (refresh success, import success).

**Steps:**
- [ ] Edit; `pnpm typecheck`
- [ ] Commit `feat(web): fetch usage history`

### Task 7: Usage metric derivations

**Files:**
- Create: `apps/web/src/lib/metrics/usage.ts`

**Produces (exact signatures):**

```ts
/** Rows within the global range. Same slicing rule as summariseSpend. */
export function sliceByRange<T extends { date: string }>(rows: readonly T[], range: DateRange): T[];

export interface SeriesChartInput { name: string; points: ReadonlyArray<{ date: string; value: number | null }>; }

/** Pivot breakdown rows of one dimension into per-key day series over the date axis.
 *  Keys ranked by total desc; beyond `maxSeries` folded into 'Other'. Missing (day,key) = 0. */
export function pivotBreakdown(
  rows: readonly BreakdownPoint[],
  dimension: UsageDimension,
  metric: 'interactions' | 'generations' | 'acceptances' | 'locAdded' | 'locDeleted' | 'locSuggestedAdd' | 'locSuggestedDelete',
  dates: readonly string[],
  maxSeries?: number, // default 8
): SeriesChartInput[];

/** The sorted distinct date axis of a sliced orgDaily window. */
export function dateAxis(rows: ReadonlyArray<{ date: string }>): string[];

/** Org series pickers: each returns SeriesChartInput[] for one chart. */
export function orgSeries(rows: readonly OrgDailyPoint[], fields: ReadonlyArray<{ field: keyof OrgDailyPoint & string; name: string }>): SeriesChartInput[];

/** acceptances/generations per day as %; null where generations = 0. */
export function acceptanceRateSeries(rows: readonly OrgDailyPoint[]): SeriesChartInput[];

/** Adoption rows pivoted to one series per phase (engagedUsers). */
export function adoptionSeries(rows: readonly AdoptionPhasePoint[]): SeriesChartInput[];

/** True when every PR-related value in the window is zero. */
export function prAllZero(rows: readonly OrgDailyPoint[]): boolean;

export interface TeamStat { team: string; seats: number; activePercent: number; }
/** Seats grouped by team (null → 'No team'), sorted by seats desc. Active = activity ≤ 28 days. */
export function teamStats(seats: readonly CopilotSeat[]): TeamStat[];
```

Plus the geometry builder in the same file (or `multiChart.ts` if >150 lines):

```ts
export interface MultiSeriesGeometry {
  series: Array<{ name: string; linePath: string; colorVar: string }>;
  gridLines: GridLine[];   // reuse GridLine from chart.ts
  xLabels: string[];
  hoverPoints: ChartHoverPoint[];
  empty: boolean;          // true when <2 dates or all values null/0-only-empty
}
export function buildMultiSeriesGeometry(
  input: readonly SeriesChartInput[],
  format: (value: number) => string,   // axis + tooltip formatter (count/percent)
): MultiSeriesGeometry;
```

Same 900×240 viewbox constants as `chart.ts`; shared peak across series (headroom 1.12); null points break the line into `M`-restarted segments; colours cycle `['var(--accent)', 'var(--pos)', 'var(--warn)', 'var(--neg)', …]` — pick the actual categorical token names from `apps/web/src/styles/tokens.css` at implementation time (no hex).

**Steps:**
- [ ] Implement; `pnpm typecheck`
- [ ] Commit `feat(web): usage series derivation and multi-series chart geometry`

### Task 8: TrendChart + TeamsPanel components

**Files:**
- Create: `apps/web/src/components/usage/TrendChart.tsx`, `TrendChart.module.css`, `TeamsPanel.tsx`, `TeamsPanel.module.css`

**Produces:**

```tsx
interface TrendChartProps {
  title: string;
  geometry: MultiSeriesGeometry;
  emptyMessage?: string;   // rendered when geometry.empty
  subtitle?: string;
}
export function TrendChart(props: TrendChartProps): JSX.Element;

interface TeamsPanelProps { stats: readonly TeamStat[]; }
export function TeamsPanel(props: TeamsPanelProps): JSX.Element;
```

TrendChart mirrors `SpendTrendChart` markup: `Card` → header (title + legend from `geometry.series` names/colours) → plot (gridLines, SVG paths with `vectorEffect="non-scaling-stroke"`, `ChartHoverLayer`, xLabels). No area fill (multi-line). Empty state: centered muted message in the plot box. CSS copies `SpendTrendChart.module.css` patterns, tokens only.
TeamsPanel: Card with rows — team name, seat count, thin bar (width = seats/maxSeats), active-% figure.

**Steps:**
- [ ] Implement; `pnpm typecheck`
- [ ] Commit `feat(web): generic trend chart and teams panel components`

### Task 9: Page sections + wiring

**Files:**
- Create: `apps/web/src/components/usage/UsageSections.tsx`, `UsageSections.module.css`
- Modify: `apps/web/src/App.tsx` (render `<UsageSections seats={metrics.filteredSeats} usage={usageQuery.data} range={state.range} />` below the second `styles.split` block), `apps/web/src/App.module.css` if a grid class is needed

**Produces:** `UsageSections({ usage, seats, range })` — memoises `sliceByRange` once per section input, then renders the spec's section list (spec §Web/Page sections, ~24 `TrendChart`s in a 2-col grid + PR empty-state card + `TeamsPanel`). Section header notes "Org-wide activity — date range applies; seat filters don't." Charts render nothing-crashing on `usage === undefined` (loading: skip sections).

**Steps:**
- [ ] Implement; `pnpm typecheck`
- [ ] Commit `feat(web): usage chart sections on copilot dashboard`

### Task 10: Verify end-to-end

- [ ] `pnpm --filter @dash/shared build && pnpm typecheck`
- [ ] Mock run: `COPILOT_SOURCE=mock` API + web, trigger refresh, eyeball every section (charts populated, PR non-zero, teams listed, range switch re-slices all charts, editor filter changes teams but not org charts).
- [ ] Live run: `COPILOT_SOURCE=github` against `RBCZ-copilots`, refresh, check: real IDE/language/model/feature charts, PR section shows empty state, teams from `assigning_team`, seat metrics now aggregate 28 days (acceptance rates change vs before).
- [ ] Commit any fixes `fix(...)`; update `docs/handoff.md`? No — handoff is spec-of-record for the original design; instead add `[impl]`-style note only if nullability story changed (it didn't).

### Task 11: PR

- [ ] Push branch `feat/copilot-usage-views`; PR to `main` via `gh` (GitHub MCP unavailable → CLI), business-focused description.
