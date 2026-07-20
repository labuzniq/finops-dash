# Merged Usage Charts — Design

**Date:** 2026-07-21
**Status:** Approved

## Goal

Reduce the usage page's chart sprawl by merging related single-metric charts behind a
per-chart metric toggle — always exactly one metric visible at a time (the "no mixed
data kinds in one graph" rule holds) — and expand shortened headings ("Org activity" →
"Organization activity"). Frontend-only; no API or schema changes.

## Decisions (user-confirmed)

1. Merge style: **metric toggle per chart** — segmented control in the chart header
   switches which metric the chart plots. Not multi-metric lines, not dropping metrics.
2. Merge scope: the four **By-dimension sections** and **Organization activity's
   single-metric charts**. Active users, acceptance rate, cohorts, adoption, and PR
   charts keep their current layout.

## Resulting page layout

| Section | Cards before | Cards after |
|---|---|---|
| Organization activity | 7 | 4 — Active users · **Daily activity** (toggle: Generations \| Acceptances \| Interactions) · Acceptance rate · **Lines of code** (toggle: Written \| Suggested, each two lines add/delete) |
| Engaged cohorts | 3 | 3 (unchanged) |
| By IDE / language / feature / model | 3 each (12) | 1 each (4) — toggle: Generations \| Acceptances \| Lines added \| Interactions |
| Adoption phases | 1 | 1 |
| Pull requests | 3 (or empty card) | unchanged |
| Teams | 1 | 1 |

~24 cards → ~16. Interactions becomes available for every dimension (it previously
showed only for features); lines added becomes available for features.

## Component changes

**`TrendChart`** gains an optional controlled variant toggle:

```ts
export interface TrendVariant {
  key: string;
  /** Toggle button label, e.g. 'Generations'. */
  label: string;
  /** Card title while active, e.g. 'Generations by language'. */
  title: string;
  geometry: MultiSeriesGeometry;
  subtitle?: string;
}

interface TrendChartProps {
  // single-chart form (unchanged behaviour):
  title?: string;
  geometry?: MultiSeriesGeometry;
  subtitle?: string;
  emptyMessage?: string;
  // toggle form:
  variants?: readonly TrendVariant[];
  activeVariant?: string;               // key; falls back to variants[0]
  onVariantChange?: (key: string) => void;
}
```

When `variants` is set, the header renders the segmented control (same visual
pattern as the existing Per user / Per model table toggle — `role="group"`,
`aria-pressed`, token-styled segments) and the card's title/subtitle/geometry come
from the active variant. Exactly one form must be supplied; the component treats
`variants` as authoritative when both exist.

**`UsageSections`** builds `ChartSpec`s that carry either a plain geometry or a
variant list. All variant geometries are precomputed in the existing `useMemo`
(the full derivation is ~ms at this data size), so switching is instant and pure
render — no refetch, no recompute.

## State

Repo convention: all page state lives in `dashboardState`. The reducer gains

```ts
usageMetric: Record<string, string>;   // sectionKey → variant key, sparse
// action:
{ type: 'setUsageMetric'; section: string; metric: string }
```

Section keys: `orgDailyActivity`, `orgLoc`, `ide`, `language`, `feature`, `model`.
Missing key → the chart's first variant (defaults: Generations; Written).
`App.tsx` passes `usageMetric` + a dispatch-backed callback into `UsageSections`.

## Heading and label fixes (expand shortenings)

- Section "Org activity" → **"Organization activity"**; its note "Org-wide series…"
  → "Organization-wide series…"
- PR chart "PRs created and merged" → **"Pull requests created and merged"**
- Sweep all remaining chart titles, legends, subtitles, and empty-state copy for
  abbreviations and expand them. "By IDE" and legend entries like "VS Code" stay —
  standard names, not shortenings.

## Out of scope

- API/schema/mock changes (none needed)
- Merging cohort or PR charts behind toggles
- Persisting toggle choices beyond the session

## Verification

`pnpm typecheck`; drive the app on mock data — screenshot each merged chart in at
least two toggle states, confirm heading text, confirm global date range still
re-slices toggled charts, confirm no console errors.
