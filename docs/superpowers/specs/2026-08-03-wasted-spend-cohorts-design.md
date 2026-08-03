# Wasted-spend cohorts — never, dormant, lapsed

The wasted-licence roster names every person the org paid a seat for who recorded no AI
credits in the range. It is one pile. A seat nobody has ever spent a credit on and a seat
whose owner was spending until three weeks ago are the same row on that screen, and they are
not the same conversation: one is a reclaim, the other is a question about what changed.

This splits the pile on the one signal that shares the waste test's own currency — the last
day the login recorded credits — and puts that split on all three surfaces that report the
waste: the KPI card, the roster's filter, and the roster's grouping.

## Why credits rather than seat activity

`CopilotSeat.lastActivityDays` is already on the dashboard and would have needed no API work.
It is the wrong signal here. It reports IDE activity, not credit spend, and the two
populations deliberately differ — the idle roster and the wasted roster exist as separate
modules for exactly that reason (`roster.ts`). Splitting a credits-shaped population on an
activity-shaped field would produce a cohort called "never used" that means "never opened
Copilot", which is a different claim about a different person. Worse, a login with no seat row
would read `null`, and null there is *unknown*, not never.

The last credit day is derived from Report 1, which is where `credits` comes from in the first
place, so the split cannot disagree with the population it splits.

## What the API adds

`getSpend(from, to)` gains two reads over `model_spend_daily`, both scoped to credits:

- `SELECT login, MAX(date) WHERE date < from AND credits_nano > 0 GROUP BY login` — the last
  credit day **before** the window. In-range credits are zero for this whole population by
  construction, so "before the range" is the entire answer and the query need not consider the
  range itself.
- `SELECT MIN(date)` over the table — the first day the per-model report covers.

`SpendPayload` gains:

```ts
export interface CreditHistory {
  /** First day the per-model report covers. Null when nothing is imported. */
  floor: string | null;
  /** login -> last day before the range that recorded credits. Absent = none found. */
  lastCreditBefore: Record<string, string>;
}
```

Report 2 contributes nothing here. It knows licence money and no credits at all, so it cannot
witness the absence this feature is about.

## The cohorts

Gap is measured in days from `lastCreditBefore[login]` to the **range start** — the first day
of the zero-credit window. The cohort is therefore a property of the window on screen: a range
from March re-opened in August reads the same as it did in March, and no number drifts as days
pass. The alternative anchor, today, is what `lastActivityDays` uses on the idle roster, and it
is right there because that roster describes a live snapshot rather than a window.

| cohort | test | rendered as |
| --- | --- | --- |
| `never` | no entry in `lastCreditBefore` | `No credits since {floor}` |
| `dormant` | gap ≥ `IDLE_THRESHOLD_DAYS` (30) | `Dormant · last credit {date}` |
| `lapsed` | gap < `IDLE_THRESHOLD_DAYS` | `Lapsed · last credit {date}` |

The boundary is `>=`, reused from `isIdle` rather than restated, so the two waste surfaces cut
staleness at the same place. Three cohorts is the fewest that separates "reclaim it" from "ask
what changed".

### "Never" is never asserted

A login with no credit row has none *in the imported history*. Someone who last spent a credit
a week before the first imported day is indistinguishable from someone who never spent one at
all, and asserting "never" about them is the claim that gets a person's seat pulled wrongly.
The cohort is therefore labelled with the floor — `No credits since 2026-05-01` — and the floor
is stated once on the card. This is the same shape as the gateway's `coverage.floor` and the
same rule as null-means-unknown.

### The no-prior-history guard

When `floor >= rangeStart` there is no imported history before the window at all, so every
wasted seat lands in `never` for a reason that is arithmetic rather than a finding. The split
is withheld in that case and the card says why. It is a separate state from the existing
`measurable: false` guard, which fires when the *range itself* carries no per-model report:
that one means "we cannot tell who used it", this one means "we can tell, but not for how long".

## Roster changes

- `RosterPerson` gains `cohort?: WasteCohort` and `note?: string` — a second right-hand fact
  carrying the last-credit label. Both optional: the idle roster passes neither and
  `RosterTable` renders the column only when the roster carries it. `detail` stays the licence
  money, since money is what this page ranks by.
- `wastedRoster` takes the credit history, the range start and an optional cohort filter, and
  filters **before** grouping — so a group's dollars, the chip's count and the export all
  describe the same people. Filtering after grouping would leave the group bars sized to a
  population the table is no longer showing.
- `RosterGroupBy = CostCentreDimension | 'cohort'`. `groupRoster` gains an optional `labelOf`
  so a group key of `never` can render as prose, and `RosterTable` takes the offered dimensions
  as a prop — the spend roster passes four, the idle roster three. Cohort is never null on the
  wasted roster, so the unassigned-last rule is untouched.

## Surfaces

- **`WastedSpendCard`** — headline unchanged; three cohort lines beneath it with dollars,
  seats and share of the wasted total. The floor is named on the `never` line. The card is the
  reason the split exists at all: "$4,750 wasted" and "$3,100 of it on people who have never
  spent a credit" are different budget conversations.
- **`RosterTable`** — cohort chips (`All / Never / Dormant / Lapsed`, each with its count) above
  the table, a `Last credit` column per person, and `Cohort` as a fourth group-by. Grouping by
  cohort while a chip is active is legal and collapses to one group; it is not worth
  prohibiting.
- **CSV** — `buildRosterCsv` gains an optional note header; the wasted roster passes
  `last_credit_date` and the file also carries a `cohort` column. Flat and complete as before:
  both fields ride on every row whichever way the screen is grouped, so the recipient can pivot
  without re-exporting.
- **State** — `wasteCohort: WasteCohort | null` in `dashboardState`, and `rosterGroupBy`
  retyped to `RosterGroupBy`.

## Verification

`pnpm typecheck` is the repo's only automated gate; the rest is driving the app against the
mock source with billing reports imported.

- Cohort dollars sum to `waste.wasted` and cohort seats to `waste.seats` — the card cannot
  disagree with itself.
- A chip-filtered roster's person count equals that chip's count, and its amount equals that
  cohort's amount.
- Grouping by cohort produces exactly the cohorts the chips list, with the same totals.
- The no-prior-history guard fires on a range starting on the first imported day.
- The existing `measurable: false` path still renders its refusal and no cohorts.
- The CSV carries cohort and last-credit date on every row, including for `never` rows where
  the date column is empty rather than zero-filled.
