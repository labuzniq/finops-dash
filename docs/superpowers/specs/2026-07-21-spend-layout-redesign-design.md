# Spend page layout redesign — design

**Date:** 2026-07-21
**Status:** approved

## Problem

The spend page opens with two competing panels of equal weight: the spend trend chart
and a per-model breakdown table, side by side on a `1fr 380px` grid. The per-model
table is detail, not headline — putting it beside the trend makes the top of the page
read as two stories rather than one. Meanwhile nothing on the page answers the question
the money view exists to answer: *how much are we paying for seats nobody uses?*

Separately, the Usage page's table and Seat-utilization donut sit in the same grid row
but their card tops do not align, because the view toggle is nested inside the left
column and pushes the table down by its own height.

## Goals

1. The trend chart is the page's headline, with a narrow rail beside it that quantifies
   wasted spend on inactive users. The two are exactly the same height.
2. Per-model spend moves to the bottom of the page and becomes a graph, not a table.
3. Card pairs in a grid row align top and bottom, on both the Spend and Usage pages.

## Non-goals

- No new API endpoints or queries. Everything derives from the payload `useSpendData`
  already fetches.
- No change to the cost model, the money invariants, or which report is authoritative.
- No change to filtering, sorting, or paging behaviour.

## Page order

```
Spend header
Filter bar
KPI row  (Gross | Discount | Net | Licences)      — unchanged
┌──────────────────────────────────┬──────────┐
│ Spend trend (chart)              │ Wasted   │   ← equal height
│                                  │ spend    │
└──────────────────────────────────┴──────────┘
Per-user spend table                              — unchanged
Spend by model (horizontal bar graph)             — new, replaces the table
```

### Equal height

The rail is a fixed `240px` column (~15% of a 1600px viewport, inside the 10–20% the
design calls for). Below `1100px` the grid collapses to a single column and the rail
renders under the chart, matching the existing breakpoint.

CSS grid stretches row items by default, so both cards already receive the row height.
The rule is that **the chart sets the height and the rail stretches to match** — the
rail must never force the chart taller. Concretely: the rail card is
`display: flex; flex-direction: column` with a flexible spacer between its headline
figure and its footer, so its content distributes down the available height instead of
bunching at the top. The rail declares no `min-height` of its own.

## Wasted spend rail

New component `components/spend/WastedSpendCard.tsx` + module CSS, fed by a new pure
function in `lib/metrics/spend.ts`:

```ts
export interface WastedSpend {
  /** Summed licence money of inactive logins. */
  wasted: number;
  /** Count of inactive logins. */
  seats: number;
  /** Licence money of every login with a licence, inactive or not. */
  licence: number;
  /** wasted / licence, 0..1. Zero when there is no licence money. */
  share: number;
  /** False when the range carries no per-model report at all — see below. */
  measurable: boolean;
}

export function wastedSpend(rows: readonly SpendUserRow[]): WastedSpend;
```

**Inactive** means `licence > 0 && credits === 0`: the org paid for the seat over the
range and the per-model report recorded no AI credits against that login.

The card renders the wasted dollar figure large, the seat count and share beneath it,
and a two-segment bar showing wasted licence against used licence.

### The measurability guard

`credits` comes from Report 1 (the per-model report); licence money comes only from
Report 2. A login that appears in Report 2 but not Report 1 has `credits === 0` for two
indistinguishable reasons: it genuinely used nothing, or Report 1 was never imported for
that range. If a range has no Report 1 data at all, a naive reading reports 100% waste,
which is a lie of exactly the kind the repo's "null means unknown, never zero" invariant
exists to prevent.

Guard: `wastedSpend` sets `measurable: false` when the total credits across all rows is
zero. The card then renders an explanatory empty state — "No per-model report in this
range" — instead of a dollar figure. This is deliberately coarse: it catches the total
absence of Report 1, not partial coverage, because partial coverage is not detectable
from the data.

The function takes the already-filtered `SpendUserRow[]` the user table is built from,
so the rail recomputes under the same filters as every other panel and never disagrees
with the KPI row about who is being counted.

## Spend by model graph

New component `components/spend/ModelSpendChart.tsx` + module CSS, consuming the
existing `modelBreakdown(models): ModelBreakdownRow[]` unchanged.

Hand-rolled CSS bars (per the repo's no-charting-library invariant), one row per model,
sorted biggest gross first as `modelBreakdown` already returns them. Each row shows the
model name, a bar whose width is `gross / maxGross`, and the gross dollars and credit
count as right-aligned labels. Bars use `--accent`, the same treatment as the share bar
being retired. Empty state: "No model spend in this range."

Scaling by `maxGross` rather than by total is deliberate — the largest model always
fills the track, so differences between the smaller models stay visible. Share of total
is dropped; it was the least informative column of the old table and the bar lengths
already communicate relative size.

`ModelBreakdownTable.tsx` and `ModelBreakdownTable.module.css` are deleted. Nothing else
imports them.

## Usage page alignment fix

In `App.tsx`, the Per user / Per model toggle is hoisted out of `.tableColumn` to sit
above the `.split` grid as its own row. `.tableColumn` is then an empty wrapper and is
removed along with its CSS rule; the table becomes a direct grid child beside the donut.
Both cards then share the grid row and align at top and bottom.

## Files

| File | Change |
|---|---|
| `apps/web/src/lib/metrics/spend.ts` | add `WastedSpend` + `wastedSpend()` |
| `apps/web/src/components/spend/WastedSpendCard.tsx` | new |
| `apps/web/src/components/spend/WastedSpendCard.module.css` | new |
| `apps/web/src/components/spend/ModelSpendChart.tsx` | new |
| `apps/web/src/components/spend/ModelSpendChart.module.css` | new |
| `apps/web/src/components/spend/SpendSection.tsx` | reorder; swap breakdown table for rail + chart |
| `apps/web/src/components/spend/SpendSection.module.css` | rail column width, bottom row |
| `apps/web/src/components/spend/ModelBreakdownTable.tsx` | delete |
| `apps/web/src/components/spend/ModelBreakdownTable.module.css` | delete |
| `apps/web/src/App.tsx` | hoist the view toggle out of the grid column |
| `apps/web/src/App.module.css` | drop `.tableColumn` |

## Verification

`pnpm typecheck` is the repo's only automated gate and must pass. Beyond it, drive the
app: confirm the chart and rail are pixel-equal in height at wide and narrow widths,
that the rail's figure moves when a filter narrows the login set, that a range with no
per-model report shows the explanatory state rather than 100%, and that the Usage page's
table and donut now align at both edges.
