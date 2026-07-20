# Dashboard calendar date-range picker — design

Date: 2026-07-20
Status: approved (brainstormed with user)

## Goal

Let dashboard users pick an arbitrary calendar date range (start + end) in addition to the
existing 28/56/90-day presets, on both the Copilot dashboard and the Claude Code page, while
respecting GitHub Copilot's reporting semantics: daily (1d) granularity for time series, and
fixed 28-day windows for the metrics GitHub only reports that way.

## Decisions (from brainstorming)

- **Picker model:** free start + end date range at 1-day granularity, max 90 days back.
  Daily series slice to exact dates. Fixed 28d-window metrics keep their window with an
  explicit label.
- **Scope:** both dashboards — Copilot (`FilterBar`) and Claude Code (`ClaudeCodePage`).
- **Presets:** keep segmented 28d/56d/90d buttons; add a "Custom" segment that opens the
  calendar popover.
- **Widget:** two native `<input type="date">` fields in a token-styled popover. No date
  library, no UI framework (repo invariant).

## State model

New type in `packages/shared/src/types.ts` next to `RANGE_DAYS`:

```ts
export type DateRange =
  | { kind: 'preset'; days: RangeDays }          // 28 | 56 | 90
  | { kind: 'custom'; from: string; to: string } // ISO dates (YYYY-MM-DD), inclusive
```

`dashboardState.range` (Copilot) and the Claude page's `range` state change from `RangeDays`
to `DateRange`. Default remains `{ kind: 'preset', days: 28 }`.

## Slicing

Series points carry ISO dates already.

- `lib/metrics/spend.ts`: add date-based slicing alongside the existing tail-slice.
  Preset path keeps the current `sliceRange` tail behaviour (no regression); custom path
  filters points where `from <= point.date <= to`.
- `lib/metrics/telemetry.ts` (`deriveTelemetry`): same treatment for the Claude daily rollup.
- Everything stays client-side. No API change — the existing 90-day fetch covers any
  pickable range.

## Bounds & validation

- Calendar inputs clamped: `min` = oldest fetched series date (~90 days back), `max` =
  latest data date.
- `from <= to` enforced; Apply disabled while invalid.

## Delta ("vs previous period")

A custom range spanning N days compares against the preceding N days when the series
contains them (generalising the existing `rangeDays * 2 <= series.length` guard); otherwise
the delta is hidden — same as today's behaviour for presets.

## Fixed 28d-window metrics

`premiumRequests28d` and the seat-period cost are GitHub-reported fixed 28-day rolling
windows and cannot be re-sliced. They keep their values under any selected range. While a
custom range is active, their labels state "last 28d" explicitly instead of implying the
selected range.

## UI

- Shared `DateRangePicker` component in `apps/web/src/components/`, used by `FilterBar`
  and `ClaudeCodePage`.
- Segmented control gains a fourth segment, "Custom". Clicking it opens a small popover
  containing the two date inputs and an Apply button. Popover closes on Apply, Escape, or
  outside click.
- While a custom range is active the segment shows a compact label, e.g. "Jun 3 – Jul 1".
- KPI kickers show the day count of the selected range (e.g. `14d`) for custom ranges.
- All styling from `styles/tokens.css`; CSS Modules; no new dependencies.

## Verification

No test framework exists. Verification is `pnpm typecheck` (after rebuilding
`packages/shared`) plus driving the app with the mock source (`pnpm dev`).
