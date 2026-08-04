# Metric catalogue

Every number the dashboard draws, with the arithmetic behind it and the table it comes from.
Companion to [`data-layer.md`](./data-layer.md), which describes the storage.

Notation: `Σ` sums over the rows surviving the page's filters and the selected range. "spine" means
the zero-filled list of calendar dates a chart is drawn on.

**Three different currencies of truth live on this dashboard and none of them may be added
together.** Copilot `net` is what GitHub invoiced. Gateway `spend` is what the LiteLLM proxy
recorded. Claude Code `cost` is what the client *estimated* it would have cost on the public API.
No page states this today — see finding **F14**.

---

## A. Copilot analytics page (`/api/seats` + `/api/usage`)

Everything derives from one seat fetch through `useDashboardMetrics`: `filterSeats` →
`buildUtilization` / `sortSeats`+`paginate` / `idleRoster`.

### A.1 KPI row (`KpiRow.tsx`)

| Tile | Calculation | Source |
|---|---|---|
| **SEATS** | `count(filteredSeats)` | `copilot_seats` after editor/language/search/org-scope filters |
| **SEAT UTILIZATION** | `round(activeCount ÷ total × 100)`, where `activeCount = |{seat : lastActivityDays ≤ 28}|`. Never-used seats (null) are never active. | `copilot_seats.last_activity_at` |
| **AI CREDITS USED · Nd** | `round( Σ (premiumRequests28d ?? 0) × rangeDays ÷ 28 )` | `copilot_seats.premium_requests_28d` — **an extrapolation, see F1** |
| **IDLE SEATS** | `dormant + never` = `|{lastActivityDays > 28}| + |{lastActivityDays = null}|` | subtitle says "30d+ or never" — **see F2** |

### A.2 Utilisation donut (`buildUtilization`)

Four exclusive buckets covering every filtered seat, so the fractions sum to 1 and the ring closes.
Arc geometry is `dashArray = fraction × 2πr`, `dashOffset = −consumed × 2πr` with `r = 56`.

| Bucket | Predicate |
|---|---|
| Active · 7d | `lastActivityDays ≤ 7` |
| Active · 8–28d | `7 < lastActivityDays ≤ 28` |
| Dormant · 29d+ | `lastActivityDays > 28` |
| Never used | `lastActivityDays = null` |

### A.3 Seat table (`UserTable`)

One row per filtered seat, sorted then paginated at 12 rows. Sort values: `premiumRequests28d ?? −1`,
`acceptanceRate ?? −1`, `lastActivityDays ?? +∞` (unknown numbers sort below every real one; a
never-used seat is infinitely stale). Columns are stored values rendered directly — `AI CREDITS` is
the **raw 28-day figure**, not the prorated KPI above it (**F1**). `ACCEPT` is the stored integer
percent. `LAST ACTIVE` is `lastActivityDays` derived at read time from the timestamp.

### A.4 Idle roster (`idleRoster` → `groupRoster`)

Population: `isIdle(seat)` = `lastActivityDays = null ∨ lastActivityDays ≥ 30`. Grouped by
department / B-1 / B-2, unassigned pinned last, people sorted by staleness descending
(`lastActivityDays ?? +∞`). Carries **no money** — group `amount` is always 0, so groups rank by
headcount. Always `measurable: true`: a null there means "never used", not "not reported".

### A.5 Usage charts (`UsageSections` + `lib/metrics/usage.ts`)

All series are drawn on the **shared date axis of the org rows in range** (`dateAxis(sliceByRange(orgDaily))`).
Range slicing: a custom range is an inclusive calendar window; a preset takes the **trailing N
distinct dates present in the data**, not the last N calendar days (**F3**).

Geometry (`buildMultiSeriesGeometry`): fixed 900×240 viewbox, `peak = max(values) × 1.12`,
`y = 234 − (value ÷ peak) × 220`, gridlines at 25/50/75/100% of peak, 5 x-labels. A `null` day
**breaks the line** (`gappedPath`) rather than drawing zero; a run of one day gets no area fill.

| Section | Chart | Calculation |
|---|---|---|
| Organization activity | Active users | `org_daily.{daily,weekly,monthly}ActiveUsers` — GitHub's own DAU/WAU/MAU, not derived |
| | Generations / Acceptances / Interactions | `org_daily` fields, one line each |
| | Acceptance rate | `acceptances ÷ generations × 100` per day; **null (line breaks) on a day with 0 generations** |
| | Lines of code | `locAdded`/`locDeleted`, toggled with `locSuggestedAdd`/`locSuggestedDelete` |
| Filtered activity *(with a seat filter on)* | all of the above | `filteredActivity`: Σ `user_daily` rows of the filtered logins per day. `activeUsers` = **count of rows present that day**, so a stored all-zero row counts as active (**F4**) |
| Engaged cohorts | Chat/agent, code review, cloud agent users | `org_daily.*Mau/Wau/Dau` — org-wide, never filtered |
| By IDE / language / feature / model | 4 metrics × 4 dimensions | `pivotBreakdown`: Σ metric per (key, date), keys ranked by range total, **top 8 kept and the rest folded into `Other`**. A day with no row for a key is 0. |
| Adoption phases | Engaged users per phase | `adoption_phase_daily.engagedUsers`, one line per `phase_number` |
| Pull requests | created/merged, Copilot involvement, suggestions | `org_daily.pr_*`. The whole section is hidden when every PR field is 0 across the window. |
| Teams | seats + active % per team | `teamStats`: group filtered seats by `team ?? 'No team'`, `activePercent = round(active ÷ seats × 100)` with active = `lastActivityDays ≤ 28` |

### A.6 Per-model table (`/api/models` → `listModels`)

The one server-side aggregation on this page: Σ `model_daily` over the window grouped by model,
`acceptanceRate = round(acceptances ÷ generations × 100)` or null, sorted by generations desc.
**This is a different "by model" number from the `model` breakdown chart** — the table reads
`totals_by_language_model` (code only), the chart reads `totals_by_model_feature` (all features).
See **F5**.

---

## B. Spend section (`/api/spend`)

Filters restrict the **login set** (`filterLogins` → `applySpendFilter`); every derivation
recomputes from the surviving rows. Nothing is pre-aggregated.

### B.1 KPI row — four answers, never summed with each other

| Tile | Calculation |
|---|---|
| GROSS | `Σ billingRows.gross` — all skus, licences included |
| DISCOUNT | `Σ billingRows.discount` — absorbed by the enterprise pool |
| NET | `Σ billingRows.net` — the real charged total |
| LICENCES | `Σ gross where sku = copilot_for_business` — **gross, not net** (**F6**); already inside Gross and Net |

### B.2 Spend trend (`spendTrend` + `buildChartGeometry`)

Daily `gross`/`discount`/`net`, **zero-filled across every calendar day** from `from` to `to`. Same
900×240 geometry as the usage charts, `peak = max(total) × 1.12`. The tail is **not** trimmed, so
days the billing sync has not reached yet plot as $0 (**F7**).

### B.3 Model spend chart (`modelBreakdown`)

Σ Report-1 rows by model: `credits`, `gross`, and `share = gross ÷ Σ gross across models`. Ranked by
gross. **This is a statistic, not money** — Report 1 overlaps Report 2's AI-credit money.

### B.4 Per-user table (`spendUserRows`)

One row per login appearing in *either* report, joined to identity. Dollars all come from Report 2;
`credits` comes from Report 1; `licence` is the login's `copilot_for_business` gross. Sorted by gross
desc, ties broken by login. A login with no `SpendPerson` renders as itself, unmapped, and still
counts in every total.

### B.5 Wasted licence spend (`wastedSpend` + `wasteCohortSummary`)

Test: **`licence > 0 ∧ credits = 0`** over the filtered rows.

```
wasted  = Σ licence of failing rows        seats = |failing rows|
licence = Σ licence of every licensed row  share = wasted ÷ licence
measurable = (Σ credits over all rows) > 0
```

`measurable = false` means the range carries no Report 1 at all and the card must render the unknown
rather than declare every seat wasted. The guard is deliberately coarse — **partial** Report 1
coverage is undetectable (**F8**).

The pile is then split on the **last credit day strictly before the range** (`creditHistory`,
Report 1 only):

| Cohort | Predicate | Reading |
|---|---|---|
| `never` | no credit day in the imported history | labelled *"No credits since {floor}"* — never claims "never", because the floor is the first imported day |
| `dormant` | `rangeStart − lastCredit ≥ 30 days` | reclaim conversation |
| `lapsed` | `rangeStart − lastCredit < 30 days` | "what changed" conversation |

The gap is measured from the **range start**, not today, so a window re-opened months later reads as
it did. The split is withheld entirely (`priorHistory = false`) when the report floor is not older
than the range start. Cohort seats sum to `wastedSpend.seats` and cohort dollars to `wasted` — any
drift is a bug in one of the two.

### B.6 Cost-centre rollup (`costCentreRollup`)

Group the same filtered user rows by one org dimension:

```
people       = |rows|
activePeople = |{credits > 0}|
idlePeople   = |{credits = 0 ∧ licence > 0}|      wasted = Σ licence of those
netPerPerson = net ÷ people                        share  = net ÷ Σ net
idleMeasurable = (Σ credits) > 0
```

Unassigned sorts **last regardless of size** — it is a data-quality remainder, not a cost centre, and
no filter can select it. `topShare(n)` = Σ net of the first *n* displayed rows ÷ total net.
Note `activePeople + idlePeople ≤ people`: a person with neither credits nor a licence is in
neither bucket (**F9**).

### B.7 Wasted roster (`wastedRoster`)

Character-for-character the same `licence > 0 ∧ credits = 0` test, grouped by department / B-1 / B-2
/ **cohort**, weight = licence dollars (dearest first), `detail` = licence money, `note` = the
last-credit label. The cohort chip narrows the population **before** grouping, so bars, dollars, chip
and CSV export always describe the same people.

---

## C. Claude Code page (`/api/telemetry/rollup`)

One rollup fetch of 90 days, re-sliced client-side. Range: `[today − (days−1), today]` for presets.
The model filter constrains only model-dimensioned rows; sessions, lines and commits carry no model
and pass through.

| Tile / chart | Calculation | Metric |
|---|---|---|
| TOTAL COST | `Σ value` | `claude_code.cost.usage` — the **client's own estimate**, not an invoice |
| TOKENS | `Σ value` across all `type`s | `claude_code.token.usage` (input + output + cache) |
| SESSIONS | `Σ value` | `claude_code.session.count` |
| ACTIVE USERS | distinct `userEmail ?? userId` on any row in range | — (**F10**) |
| LINES OF CODE | `Σ` split on `type = 'removed'` vs anything else | `claude_code.lines_of_code.count`; **null-start** — a metric that never appeared renders `—`, not 0 |
| COMMITS / PULL REQUESTS | `Σ value`, null-start | `claude_code.commit.count` / `.pull_request.count` |
| Daily cost | `Σ cost` per day, zero-filled across the whole range spine | |
| Daily tokens (total/input/output/cache) | `Σ` per day per kind, zero-filled | `type = input` / `output` / everything else = cache |
| Token leaderboard | top 8 users by total tokens in range | |
| Per-user table | per-identity Σ of every metric; `topModel` = model with most tokens; `lastActiveDate` = max date on any row | sorted by cost desc |

Because values are delta-normalised at ingest, every one of these is a plain `SUM` — no windowing or
rate maths anywhere.

---

## D. Gateway page (`/api/gateway` + 12 more endpoints)

24 cards in 8 sections (`lib/gatewaySections.ts`); more than half stand themselves down when their
source is unavailable. The base derivation is `deriveGateway`:

```
daily   = zeroFillDaily(payload.daily, from, to)    # interior gaps → $0; unsynced TAIL trimmed
totals  = Σ daily
rows[d] = for each key of dimension d: Σ its points, share = spend ÷ totals.spend
available dimensions = those with ≥1 row
```

### D.1 Overview

| Card | Calculation |
|---|---|
| **KPI row** (6 tiles) | `GATEWAY SPEND` = `totals.spend`; `REQUESTS` = `totals.requests` with `successRate = successful ÷ requests × 100` (null when requests = 0); `TOKENS` = `totals.totalTokens`; `COST PER 1M TOKENS` = `spend ÷ totalTokens × 1e6`; `PROMPT CACHE HIT RATE` = `cacheReadTokens ÷ promptTokens × 100` (null when no input); `COST PER REQUEST` = `spend ÷ requests`. Each carries a delta against the comparison window when it is inside retention. |
| **Attention digest** (`gatewayAlerts`) | A derivation *of derivations*: repeats findings already made by budgets, budget history, anomalies, reliability, cache, coverage and health, **with those sources' own numbers and no threshold of its own**. Severity is editorial (`critical` = calls rejected or money past a line; `warning` = a decision owed; `info` = standing inefficiency). Carries **no total** — the findings share no denominator. An unreadable input is named as a *blind spot*; only "nothing to report and nothing unread" renders no card. |
| **Coverage note** | `summarizeGatewayCoverage`: `floor` = first stored day, else `today − 90`. Gaps are reported as **runs** of dates carrying no rows, split at the retention floor (`today − retentionDays`) into repairable and gone-for-good. |

### D.2 Spend

| Card | Calculation |
|---|---|
| **Trend** | `daily.spend` on the trimmed spine, same 900×240 geometry |
| **Breakdown** | ranked rows of the selected dimension; share is always of **gateway-wide** spend |
| **Movers** (`gatewayCompare`) | `comparisonWindow` = exactly `spine.length` days ending the day before the spine's first day — never a calendar month, which would compare 31 days to 28 and call the difference growth. Per key `Δ = now − before`; the whole comparison is skipped when `window.from` falls before the coverage floor. |
| **Anomalies** (`gatewayAnomaly`) | Detection: trailing **median** of 14 days (min 7 of history), `excess = spend − median`, flagged when `excess/median ≥ 0.25` **and** robust z `= excess ÷ (1.4826 × MAD) ≥ 3.5` (or MAD = 0, where the relative gate alone decides). Attribution: trailing **mean** of the same window, per key `excess = spend − mean`, `share = excess ÷ day excess`. Mean because it is additive — the contributor rows reconcile to the day's overrun exactly. Only overruns are flagged. |
| **Mix** (`gatewayMix`) | Three-factor split per key, tokens as volume: `volume = (T₁−T₀)·s₀·p₀`, `mix = T₁·(s₁−s₀)·p₀`, `rate = t₁·(p₁−p₀)`. Sums to the key's spend delta exactly, no interaction term. A key new this window is priced at the gateway's prior blended rate. Refuses to render unless per-window coverage ≥ 99% **and** `|unexplained| ÷ scale ≤ 1%`, and unless gross effect ≥ 0.5% of prior spend. |
| **Forecast** (`gatewayForecast`) | Calendar month only. `projected = monthToDate + Σ over remaining days of that weekday's mean spend over the trailing 28 days`; unobserved weekdays fall back to the mixed run rate. `flatProjected` kept alongside for contrast. Starts after the last **reported** day, not today. No growth extrapolation — a ramping gateway reads low, and the card says so. |

### D.3 Governance

| Card | Calculation |
|---|---|
| **Budgets** (`assessBudget`) | `utilization = spend ÷ maxBudget × 100`. States, in precedence order: `blocked` (explicitly disabled, or `maxBudget = 0`) → `uncapped` (null cap) → `over` (≥100) → `soft` (`spend ≥ softBudget`) → `warn` (≥80% of cap, a *derived* threshold, worded differently) → `ok`. `periodStart = resetAt − duration`; `projectedSpend = spend ÷ elapsedFraction`, **null** before ⅙ of the period, null with no period, and null for every `tag` row (its counter never resets). The card **totals nothing** — each row's spend is over its own period — and reports coverage in *objects*. |
| **Budget history** (`gatewayBudgetHistory`) | Consecutive readings read as changes: a fallen counter = a period roll, a moved cap = somebody moved it, a crossing measured against the **previous** reading's cap. An unobserved day is unknown, never interpolated; a closed period's total is a floor. |

### D.4 Statements

| Card | Calculation |
|---|---|
| **Chargeback** (`gatewayChargeback`) | The one surface that must **add up**: lines + an explicit `unallocated` row = the month's gateway spend exactly. No top-N cap, no pro-rata spreading. Payer dimensions only, one at a time. Scoped to a calendar month picked on the card. A month in flight is a *preview*, compared against the same number of days of the previous month, cut by day-of-month and clamped. Badge reads `Sealed` / `Sealed — revised since` via `sealDrift`. |
| **History** (`gatewayHistory`) | Sums over months carrying a **current** seal only. A closed-but-unsealed month is drawn as a **hole**, and the month-over-month change is against the previous *calendar* month or nothing. Spine ends at the last closed month, not the newest seal. |

### D.5 Operations

| Card | Calculation |
|---|---|
| **Reliability** (`gatewayReliability`) | Per day and per key: failures. Keys rank by failures **above the gateway-wide rate** (signed, summing to zero on a full-coverage dimension). The `elevated` badge needs **both** a Wilson lower bound above the gateway rate **and** a 1.5× materiality ratio — at gateway volumes significance alone flags everything above the mean. |
| **Health** (`summarizeDeploymentHealth`) | Per alias: `down` = every deployment failing, `degraded` = some failing, `up` = none. Leads with the reading's **age**; stale past 36h still reports every finding it holds and adds a blind spot; never taken at all stands the card down. No refresh button — pressing `/health` bills a token per deployment. |
| **Health history** (`summarizeDeploymentHistory`) | Counts of **readings**, never durations or uptime. A run of failing readings is broken only by an *observed* recovery; an unobserved day inside a run is `unobservedDays`, never a split. `STANDING_OUTAGE_READINGS = 3`. Spine clamped forward to `recordingSince`; a night with no reading is a hole. |
| **Exceptions** (live) | `/model/metrics/exceptions` swept per alias (cap 12 by spend). Classified by `classifyGatewayException` into rate-limit / auth / budget / timeout / backend / request / content. Every share is of **recorded exceptions** — the layer has no denominator. The ledger's failure count sits beside the total as an *unclamped* disagreement between two tables, never as coverage. |
| **Exception history** | Nightly counts + a **receipt**. Its only statement beyond roll-ups is a **mix shift**: each class's share of exceptions, swept nights split in half, **pooled not averaged**, in percentage points, withheld under 6 days. A mix is the one reading a missing denominator cannot corrupt. |
| **Latency** (live) | `AVG(seconds ÷ completion_tokens)` per deployment — **a rate, never a duration**. The only claim-free transform is its reciprocal (`tokensPerSecond`). Badge = 1.5× the gateway median gated on 3 days observed; no significance test is possible (the proxy discarded the counts). A day's reading is a **median across keys**, never a sum. |
| **Latency history** | Every figure is a median of nightly readings — of pairs on a night, of a pair's nights, of pair medians gateway-wide. Trend is a **ratio** (not percentage points), withheld under 6 days. |
| **Slow responses** (live) | `slowCount ÷ total_count` against the proxy's own `alerting_threshold` (300s unless configured) — **the threshold is not in the response**, so no figure carries a duration and two proxies' counts are not comparable. The only live read with its own denominator, hence the only one whose badge may use both gates (Wilson + 1.5× ratio, min 5 hangs). Rows rank by hangs; bars scale to the worst hang *share*. |
| **Slow-response history** | Pooled counts across nights (they add), trend = observed nights split in half, each half **pooled**, in percentage points, withheld under 6 days. Window ends **yesterday**, unlike the sibling history routes. |

### D.6 Efficiency

| Card | Calculation |
|---|---|
| **Cache** (`gatewayCache`) | Tokens only, **refuses to report dollars**: the daily row carries one `spend` covering input, output and both cache operations with no per-model price. `uncachedInput = promptTokens − cacheRead − cacheWrite` (clamped ≥ 0). The one weighted figure is labelled a *convention* — 0.1× read, 1.25× write — which gives the only threshold: below `0.25/0.9 ≈ 0.28` reads per token written, the cache costs more than not caching (`churning`). Only `churning` and a material workload (≥1M input tokens) with no cache activity are badged, never "below average". Rows rank by **uncached** input tokens. Leads with `detectCacheTokenConvention`'s verdict, because a violation makes the denominators wrong, not the rates approximate. |
| **Cache value** (`gatewayCacheValue`) | The refusal lifted, **pinned to `model`** because a team's cached tokens span every model it touched. Reads valued at (input rate − read rate), writes at (write rate − input rate), output cancelled, net measured against a no-cache-at-all bill. A missing cache rate is **unknown, never zero**; a `priceVaries` alias is a floor reported apart from the headline; nothing is subtracted from `spend`. |
| **Catalogue** (`gatewayCatalog`) | Joins the configured price list to the ranked breakdown rows. Re-prices tokens across all four rates and compares with the bill as a blended $/1M over the same token count, so mix cancels and only rate is under discussion. Leads with **coverage** (priced spend ÷ gateway spend). Flags a single-deployment model >5% from list; never flags or aggregates a `priceVaries` row. |

### D.7 Adoption

| Card | Calculation |
|---|---|
| **Agents** (`gatewayAgents`) | The one module that *splits* the totals, legal only because `mcp_server` is a strict subset: `remainder = totals − attributed` is the single permitted subtraction. Compares agent traffic against everything else on $/call and tokens/call, half-over-half. Wired to the constant `mcp_server`, and says "MCP-attributed" rather than "agents" — the proxy only tags calls that routed through a server, so the number is a **floor**. |
| **Adoption** (`gatewayAdoption`) | Pinned to `user`. Leads with **coverage** (attributed ÷ gateway spend) because a service key acting on nobody's behalf carries no user. Two denominators on purpose: a row's share is gateway-wide, while concentration (how few users are half the bill, and 80% of it) is measured **within** attributed spend. "New" means first seen in the window on screen and nothing more — no churn is derived. |

### D.8 Requests

| Card | Calculation |
|---|---|
| **Request log** (live, on press) | The only **joint-keyed** source. Capped at 7 days and 5,000 rows; a total over it is a **floor**. Completeness is reported in *requests* (`sampledShare` = sample requests ÷ the ledger's count, clamped at 100%) — never as a share of spend. Matrix capped at 8×6 **in the view** (the cross-tab itself may not truncate, or axis totals would disagree with the cells). Deployment table joins to health through `model_id` — the only join between usage and deployment health; under 20 requests no rate is shown; a request naming no deployment is *unjoinable*, never filed under a shared null. |

---

## E. Findings — where the numbers are currently misleading

Ranked by how likely a reader is to act on a wrong number.

### F1 — "AI credits used" is an extrapolation, and the page shows two different values for it
`premiumRequestsUsed = Σ premiumRequests28d × rangeDays ÷ 28`. On a 90-day range that multiplies a
measured 28-day figure by **3.21** and presents the product as a range total. It also cannot respond
to the range at all: picking a *different* 28 days returns the identical number, because the source
column is a fixed trailing-28-day aggregate. Seats whose credits are unknown (`null`) are counted as
0, which drags the total down on a live org where the users report is thin.
Meanwhile the seat table two cards below shows the **un**-prorated value in its `AI CREDITS` column,
so the same metric reads two ways on one screen.
*Also cosmetic but confusing internally:* the field is still called `premiumRequests28d` and the sort
key `premiumRequests`, while the value is `ai_credits_used` and the UI (correctly) says AI credits.
**Fix:** either report the raw 28-day figure with a `· 28d` kicker, or derive a real range figure from
`billing_daily` / `model_spend_daily` credits, which *are* per day.

### F2 — Two different definitions of "idle" on one page
`IDLE SEATS` = dormant + never = `lastActivityDays > 28 ∨ null`. The subtitle and the roster below it
use `isIdle` = `lastActivityDays ≥ 30 ∨ null`. A seat last active exactly 29 days ago is counted in
the KPI and **absent from the roster that claims to name the people behind it**. The donut has the
same 28/30 split.
**Fix:** make the dormant bucket `≥ IDLE_THRESHOLD_DAYS`, or relabel the bucket "29d+" and compute
`idleCount` from `idleSeats().length`.

### F3 — "Last 28 days" means four different windows across four pages
- Usage page: the trailing 28 **distinct dates that carry data** (`sliceByRange`) — with report
  holes (a 204 day, a WAF-blocked shard) this silently spans more than 28 calendar days.
- Spend page: an inclusive calendar window.
- Claude Code: `[today − 27, today]`, calendar.
- Gateway: calendar, with the unsynced tail **trimmed**.

A reader comparing "28d" totals across pages is comparing different periods. The usage page is the
odd one out and also the only one where the window silently stretches.

### F4 — A zero-activity day can count as an active user
`filteredActivity` increments `activeUsers` for **every `user_daily` row present**, not for rows with
activity. Live GitHub only emits rows for users who did something, so this is currently harmless; the
mock fills the whole history, so on mock data the "Active users" line under a seat filter is
effectively the seat count. Any future source that emits zero rows would break it live.
**Fix:** `if (row.interactions + row.generations + row.acceptances > 0)`.

### F5 — Two "by model" charts on one page, built from different arrays
`model_daily` (per-model table) comes from `totals_by_language_model` — code completions only. The
`model` dimension of `usage_breakdown_daily` (the "By model" chart) comes from
`totals_by_model_feature`, which also covers chat and agent. They will not match, and nothing on the
page says so. Related: **every** breakdown dimension drops GitHub's noise buckets (`others`,
`unknown`, `none`) at parse time, so a dimension's series sum sits below the org total in the card
above it.

### F6 — Licence money is summed on `gross`, not `net`
`spendKpis.licence`, `SpendUserRow.licence`, `wastedSpend`, the cohort split, the roster's dollar
column and `costCentreRollup.{licence,wasted}` all read `row.gross` for the licence sku. The comment
asserts licence rows accrue with `discount = 0`, but nothing validates it. If a licence row ever
carries a discount, every wasted-spend figure on the page overstates by exactly that discount, while
the NET KPI beside it does not.
**Fix:** use `net`, or assert `discount = 0` on licence rows at import.

### F7 — The spend trend always ends in a $0 cliff
`spendTrend` zero-fills every calendar day of the range, and the billing sync only ever covers
**yesterday and the day before**. So today (and often yesterday, before 07:00) plots as $0 and drags
the line to the floor. The gateway page solves exactly this by trimming the unsynced tail
(`zeroFillDaily`); the spend page does not.
**Fix:** trim to the last day carrying a billing row, the way `zeroFillDaily` does.

### F8 — `measurable` cannot see *partial* Report 1 coverage
`wastedSpend.measurable` / `costCentreRollup.idleMeasurable` are true as soon as **any** credit
appears in range. A Report 1 import covering half the range, or one department, therefore produces a
confident list of "wasted" seats made entirely of people whose credit rows were never imported. The
guard is documented as coarse; the risk is that it names people.
**Fix:** compare the range against `creditHistory.floor` and the report's own max date, and degrade
to unmeasurable when the range is not fully covered.

### F9 — Cost-centre buckets do not partition the population
`activePeople` counts `credits > 0`; `idlePeople` counts `credits = 0 ∧ licence > 0`. A person with
no credits **and** no licence (present in Report 2 with only credit-sku rows, or in Report 1 only) is
in neither. `activePeople + idlePeople ≤ people` — fine as long as the card never renders them as a
two-way split of `people`.

### F10 — One person can appear twice in the telemetry tables
`rowUser = userEmail ?? userId`. If an exporter sends `user.email` on some batches and only
`user.id` on others (different Claude Code versions, or a config change), the same human becomes two
identities: two leaderboard rows, two table rows, and `ACTIVE USERS` counts them twice.
**Fix:** resolve id → email once per rollup and key on the resolved identity.

### F11 — The oldest day of the telemetry rollup is a partial day
`telemetryRollup(days)` filters on `time ≥ now − days × 86 400 000` — a **timestamp**, not a
calendar-day floor. The oldest bucket therefore contains only the part of that day after the current
clock time, and the client renders it as a full day. On a 90-day fetch with a 90-day range the first
bar is understated by whatever fraction of the day has elapsed. Same reason the picker's `min` is
`today − 89` while the fetch asks for 90.
**Fix:** floor `since` to UTC midnight.

### F12 — With a seat filter on, live-GitHub usage charts read as zero before the 28-day mark
`user_daily` is only populated for the users report's trailing 28-day window on a live org. Selecting
56d or 90d with a seat filter active therefore draws 28 days of real activity and 30–60 days of
genuine-looking zeros. The org-wide series covers the whole range, so the two modes disagree without
explanation.
**Fix:** clamp the filtered-activity spine to the days `user_daily` actually covers, and say so.

### F13 — A scheduler outage is indistinguishable from a quiet fortnight on the gateway charts
`zeroFillDaily` zero-fills **interior** days deliberately, so a gap where the sync never ran draws as
$0 spend. The coverage note is the only place the two can be told apart, and the anomaly card
compounds it: those $0 days lower the trailing median, so the first day *after* a gap can be flagged
as an anomaly that never happened. This is a known and documented design decision, not a bug — but it
is the single most likely source of a wrong reading on that page, and the anomaly card does not
consult the coverage gaps.
**Fix (cheap):** have `detectSpendAnomalies` skip candidate days whose trailing window overlaps a
reported coverage gap.

### F14 — Nothing says the three cost numbers may not be added
Copilot NET (invoiced), gateway spend (proxy-recorded, per token) and Claude Code cost
(client-*estimated*) sit on three pages with no statement that they are different currencies of
truth. The gateway/Copilot separation is documented in code but never on screen; Claude Code's
"API-equivalent spend reported by clients" subtitle is the only hint anywhere in the UI.

### F15 — Seat `editor` can be a stale value from an earlier sync
`fetchSnapshot` merges `{...rosterSeat, ...userMetrics}`, and `metricsFromUserRow.editor` is `null`
when the users report attributes no dominant IDE — which **overwrites** the editor the roster derived
from `last_activity_editor`. The `keepIfNull` upsert then preserves whatever was already stored, so
the column can hold a value from neither of today's two sources. Low impact (it only feeds a filter),
but the filter then hides seats that do have a current editor.
**Fix:** fall back to the roster value in the merge rather than letting `null` win.

### F16 — `quantity_nano` is filled from two different quantities
The CSV import writes the file's `quantity` column; the enterprise sync writes `grossQuantity`. If
the CSV's `quantity` is the *net* quantity, the same column means two things depending on which
writer touched the day. Nothing reads `quantity` in a money total today, so this is latent rather
than live — but it should be pinned down before anything does.
