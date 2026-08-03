# Seat rosters — putting names on idle seats and wasted spend

**Date:** 2026-08-03
**Status:** approved

## Problem

Both waste surfaces report a number and no people.

`WastedSpendCard` says `$4,218.00 · 212 seats licensed · 0 credits used`. The KPI row says
`IDLE SEATS 212`. Neither says *who*, so neither can be acted on — the next step after seeing the
number is always "which 212, and who do I mail about them".

The data is already in the browser. `SpendUserRow` carries `displayName`, `department`, `b1Manager`,
`b2Manager` and `licence`; `CopilotSeat` carries the same identity fields plus `lastActivityDays`
and `plan`. `reclaimCandidates()` in `lib/metrics/idle.ts` already ranks the worst idle seats by
name and **nothing renders it** — a dead derivation.

No API route, no query, no table changes. This is a rendering gap.

## Scope

Two populations, deliberately kept apart:

| | Wasted (Spend page) | Idle (Analytics page) |
|---|---|---|
| Test | `licence > 0 && credits === 0` in range | `isIdle(seat)` — 30d+ or never used |
| Source | `SpendUserRow[]` (billing reports) | `CopilotSeat[]` (seats endpoint) |
| Roll-up metric | wasted licence dollars | seat count |
| Person columns | dept · licence $ | dept · plan · last active |

They are not the same set. A seat can be used daily and burn no AI credits (wasted, not idle); a
seat idle for 60 days can still carry credit spend from earlier in the range (idle, not wasted).
Merging them into one list would produce a population no single sentence describes.

**Money stays on the spend page.** `KpiRow` states the rule — *"Usage KPIs only — money lives in the
spend section"* — and `idle.ts` states it again — *"Activity semantics, no money."* The idle roster
carries no dollar column, even though `PLAN_PRICE` would make one easy.

## Architecture

One shared presentational component, two pure derivation modules over a shared grouping, one CSV
builder.

```
lib/metrics/roster.ts         shared types + groupRoster()
lib/metrics/wastedRoster.ts   SpendUserRow[]  → Roster   (dollars)
lib/metrics/idleRoster.ts     CopilotSeat[]   → Roster   (no dollars)
components/RosterTable.tsx    Roster          → expandable table
lib/exportCsv.ts              +buildRosterCsv, flat, one row per person
```

The two pages render `RosterTable` directly rather than through per-page wrapper components: the
only thing that differs is `showAmount` and the copy, both of which are props.

`RosterGroup` is the shared shape both modules produce and the component renders:

```ts
interface RosterPerson {
  login: string;
  displayName: string;
  department: string | null;
  /** Right-hand fact: licence dollars (wasted) or last-active label (idle). */
  detail: string;
  /** Sort weight within the group — licence money, or staleness in days. */
  weight: number;
}

interface RosterGroup {
  /** Dimension value; null is the unassigned bucket and never drills. */
  key: string | null;
  label: string;
  people: RosterPerson[];
  /** Dollars for the wasted roster, 0 for the idle one. */
  amount: number;
}
```

Grouping reuses `CostCentreDimension` (`department` | `b1Manager` | `b2Manager`) from
`costCentre.ts` rather than inventing a parallel type, and the unassigned bucket reuses that
module's `UNASSIGNED` label so the two cards name the same bucket the same way.

### State

One new reducer field, `rosterGroupBy: CostCentreDimension`, default `'b1Manager'` — the roster's
whole purpose is finding someone to mail, and a manager is that someone. It is deliberately *not*
`state.spendGroupBy`: that one drives the cost-centre ranking and defaults to `department`, and
coupling them would silently regroup the roster when somebody re-ranks the chargeback view.

One field serves both rosters because they never appear on the same page.

Group expansion is local `useState<ReadonlySet<string>>` in `RosterTable`, matching
`Sidebar`'s `collapsed` and `GatewayBudgetCard`'s `openKey`. It is ephemeral per-render UI, not
page state.

## Rules

These are the load-bearing ones. Breaking any of them makes the table lie.

1. **`measurable === false` renders no rows.** When the range carries no per-model report, every
   login reads as zero-credit for two indistinguishable reasons — unused, or Report 1 never
   imported. `wastedSpend()` already refuses to answer there; a roster of 1,000 names would turn
   that refusal into a confident accusation. The card renders the same "cannot tell them apart"
   note the KPI card does, and no table.

2. **The roster and the card share one definition.** `wastedRoster()` applies the same
   `licence > 0 && credits === 0` test as `wastedSpend()`, over the same filtered rows, so the
   card's seat count and the roster's person count cannot disagree. Same for `idleRoster()` and
   `isIdle`.

3. **Unassigned sorts last and never drills.** A null dimension value means either an unmapped
   identity (no SAML, ~31 seats) or a mapped person with no manager on record. It is a
   data-quality remainder, not a cost centre — ranking it among real managers invites reading it
   as one, and no filter can select "people with no manager". Same convention as
   `costCentreRollup`.

4. **Groups rank by what is inside them** — wasted dollars descending on the spend page, headcount
   descending on the analytics page — so the first row is the person to mail first. Ties break on
   label for a deterministic order.

5. **People inside a group rank worst-first.** Wasted: licence money descending, then display name.
   Idle: staleness descending with never-used first, reusing `idle.ts`'s existing rule that
   never-used beats long-dormant, then login.

6. **Filters apply.** Both rosters derive from the already-filtered row sets, so scoping the page
   to a department scopes the roster. Same one-fetch-then-derive contract as everything else.

7. **CSV is flat and complete.** The screen is grouped; the export is one row per person with a
   `b1_manager` column, every group, ignoring paging and expansion — a grouped CSV cannot be
   pivoted, and a paged one is a trap.

8. **`reclaimCandidates()` goes.** The roster supersedes it: same population, same ordering, now
   rendered and with names. `idle.ts` keeps `idleSeats()` as the one definition of the population
   and its ordering, so nothing can rank these seats two ways. Keeping a top-6 slice nothing
   renders would leave the dead derivation dead.

## Layout

**Spend page** — the roster sits directly under the `SpendTrendCard` / `WastedSpendCard` split and
above `CostCentreCard`. It reads as the drill-down of the card immediately above it.

**Analytics page** — the roster sits between `KpiRow` and the view toggle, so the idle KPI and the
names it stands for are adjacent.

Both are collapsed by default. Two hundred people is not an opening screen; the group rows are the
summary and expansion is the drill-down. Paging is over **groups**, not people, at the existing
`ROWS_PER_PAGE` of 12 via the existing `paginate()` — an expanded manager shows all their reports,
since a manager with more than a couple of dozen idle reports is itself the finding.

Styling comes from `tokens.css` through a CSS Module, like every other component. No hex literals.

## Verification

`pnpm typecheck` is the repo's only automated gate, and the derivations are pure functions over
existing types, so the type system carries most of the weight. Beyond that, drive the app with
`COPILOT_SOURCE=mock` and check the four things the types cannot:

- the roster's person count equals the card's seat count (`$4,750.00 / 250` on both);
- the idle roster's group counts equal the counts taken straight off `/api/seats`, and the
  unassigned bucket sorts last even when it is larger than the group above it;
- an empty-Report-1 range renders the refusal rather than a full roster (`measurable: false`);
- the CSV escapes embedded quotes, leaves nulls empty, and puts never-used seats first.

## Out of scope

- Email addresses. None exist anywhere in the schema — `github_users` carries a SAML name id and
  `jira_people` carries names and managers. The contact handle is login + display name + manager.
- Mailing anybody from the dashboard. The export is the handoff.
- A "barely used" tier between active and wasted. Zero credits is the test; a threshold is a new
  policy decision, not a rendering gap.
