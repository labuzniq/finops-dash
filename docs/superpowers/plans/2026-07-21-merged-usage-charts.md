# Merged Usage Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the usage page's related single-metric charts behind per-chart metric toggles (one metric visible at a time) and expand shortened headings.

**Architecture:** Frontend-only, per spec `docs/superpowers/specs/2026-07-21-merged-usage-charts-design.md`. `TrendChart` gains a controlled `variants` mode rendering a segmented control; `UsageSections` precomputes every variant's geometry in its existing memo; the selected metric per section lives in the page reducer (`usageMetric: Record<string, string>`), following the repo's single-reducer convention.

**Tech Stack:** React + CSS Modules (Nocturne tokens), hand-rolled SVG geometry from `lib/metrics/usage.ts`. Gate: `pnpm typecheck`; behaviour verified by driving the app (mock source) — no test framework exists.

## Global Constraints

- One metric visible at a time — toggles switch, never overlay mixed data kinds.
- Section keys: `orgDailyActivity`, `orgLoc`, `ide`, `language`, `feature`, `model`; missing state key → first variant.
- Headings: "Organization activity" (not "Org activity"), note "Organization-wide series…", "Pull requests created and merged" (not "PRs…"). "By IDE" stays.
- Every colour/font from `tokens.css`; segmented control mirrors the existing Per user / Per model toggle pattern (`role="group"`, `aria-pressed`).
- Conventional commits; `pnpm typecheck` before each commit.

---

### Task 1: Reducer state for usage metric toggles

**Files:**
- Modify: `apps/web/src/state/dashboardState.ts`

**Interfaces:**
- Produces: `DashboardState.usageMetric: Record<string, string>` (initial `{}`), action `{ type: 'setUsageMetric'; section: string; metric: string }` handled as `{ ...state, usageMetric: { ...state.usageMetric, [action.section]: action.metric } }`.

- [ ] Add field to `DashboardState` + `initialDashboardState`, add action to `DashboardAction`, add reducer case.
- [ ] `pnpm typecheck` — green.
- [ ] Commit `feat(web): usage metric toggle state in dashboard reducer`

### Task 2: TrendChart variant mode

**Files:**
- Modify: `apps/web/src/components/usage/TrendChart.tsx`, `apps/web/src/components/usage/TrendChart.module.css`

**Interfaces:**
- Produces:

```ts
export interface TrendVariant {
  key: string;
  label: string;      // toggle button text
  title: string;      // card title while active
  geometry: MultiSeriesGeometry;
  subtitle?: string;
}
```

Props become: `{ title?, geometry?, subtitle?, emptyMessage?, variants?: readonly TrendVariant[], activeVariant?: string, onVariantChange?: (key: string) => void }`. When `variants` present (authoritative): active = `variants.find(v => v.key === activeVariant) ?? variants[0]`; header gains segmented control (buttons with `aria-pressed`, click → `onVariantChange(key)`); title/subtitle/geometry from active variant. Without `variants`, behaviour unchanged. Internal render resolves to one `{ title, subtitle, geometry }` then reuses existing markup.

- [ ] Implement; CSS adds `.toggle`, `.segment`, `.segmentActive` mirroring `App.module.css`'s `.viewToggle`/`.viewSegment` (inline-flex, `--card2` track, active segment `--card` bg + `--text` colour, 11.5px, radius from tokens); header layout keeps legend + toggle stacked right.
- [ ] `pnpm typecheck` — green (UsageSections still uses single form; `title`/`geometry` now optional — keep runtime guard: render nothing if neither form given).
- [ ] Commit `feat(web): trend chart metric-variant toggle`

### Task 3: UsageSections merge + headings

**Files:**
- Modify: `apps/web/src/components/usage/UsageSections.tsx`

**Interfaces:**
- Consumes: Task 1 state + Task 2 `TrendVariant`.
- Props gain: `usageMetric: Record<string, string>`, `onMetricChange: (section: string, metric: string) => void`.

`ChartSpec` becomes `{ key: string; single?: {title, geometry, subtitle?}; variants?: TrendVariant[] }`. Build:

- **Organization activity** (heading + note expanded):
  1. Active users (single, unchanged)
  2. key `orgDailyActivity`, variants: Generations → title "Code generations"; Acceptances → "Code acceptances"; Interactions → "Interactions", subtitle "User-initiated chat and agent interactions per day"
  3. Acceptance rate (single, unchanged)
  4. key `orgLoc`, variants: Written → "Lines of code written" (Added/Deleted lines); Suggested → "Lines of code suggested" (Suggested add/delete lines)
- **Engaged cohorts** unchanged.
- **By-dimension sections** (`ide`, `language`, `feature`, `model`): one chart each, variants Generations | Acceptances | Lines added | Interactions with titles "<Metric> by <label>" (e.g. "Lines added by language", "Interactions by IDE").
- **Pull requests**: retitle "PRs created and merged" → "Pull requests created and merged"; rest unchanged.
- Render: `TrendChart` gets `variants` + `activeVariant={usageMetric[spec.key]}` + `onVariantChange={(m) => onMetricChange(spec.key, m)}` for variant specs; single form otherwise.

- [ ] Implement; `pnpm typecheck`.
- [ ] Commit `feat(web): merge usage charts behind metric toggles, full headings`

### Task 4: App wiring

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] Pass `usageMetric={state.usageMetric}` and `onMetricChange={(section, metric) => dispatch({ type: 'setUsageMetric', section, metric })}` to `<UsageSections>`.
- [ ] `pnpm typecheck`; commit `feat(web): wire usage metric toggles to dashboard state`

### Task 5: Verify + PR

- [ ] Drive app (mock source, playwright driver from scratchpad): headings read "Organization activity" / "Pull requests created and merged"; each merged chart toggles (screenshot two states of "By language" and "Organization activity" daily-activity card); range switch re-slices; `console --errors` clean; card count ~16.
- [ ] Push `feat/merged-usage-charts`; `gh pr create` to `main`, business-focused body.
