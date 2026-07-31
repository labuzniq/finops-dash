# LLM gateway integration (LiteLLM)

How the `litellm` source pulls usage and spend from the corporate LLM gateway —
the single inference endpoint in front of **Azure AI Foundry**, **Azure OpenAI**
and **AWS Bedrock**.

> **Status: draft, not yet validated against a live proxy.** Everything here is
> written against LiteLLM's published response models and docs. The two
> assumptions that need confirming the day a real endpoint and key exist are
> flagged as **[assumed]** below. Neither affects the daily totals — only the
> user/team/tag dimensions.

## Why the gateway is its own view, not a column on the Copilot page

Copilot spend is per-seat and licence-shaped: you pay $19/user/month plus AI
credits. Gateway spend is per-token and workload-shaped: an unattended batch job
can outspend the entire developer population overnight, and the interesting
question is *which backend, which model, which key* — not *which employee*. The
two never sum into one number, so they never share a table.

## What LiteLLM exposes

LiteLLM's proxy keeps two layers of spend data:

| Layer | Table | Endpoint | Use |
| --- | --- | --- | --- |
| Raw, per request | `LiteLLM_SpendLogs` | `GET /spend/logs?start_date&end_date` | Forensics. Millions of rows, pruned on a retention window. **Not used here.** |
| Pre-aggregated, per day | `LiteLLM_DailyUserSpend` and friends | `GET /{user,team,tag}/daily/activity` | What this integration reads. |

We read the **aggregate** layer only. A 90-day pull is a handful of paginated
requests instead of millions of rows, and the aggregates survive the spend-log
retention window that would otherwise silently truncate history.

### The daily-activity endpoints

```
GET /user/daily/activity?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&page=1&page_size=100
GET /team/daily/activity?…
GET /tag/daily/activity?…
Authorization: Bearer sk-…
```

All three answer the same envelope (`SpendAnalyticsPaginatedResponse`):

```jsonc
{
  "results": [
    {
      "date": "2026-07-27",
      "metrics": {
        "spend": 0.0177072,
        "prompt_tokens": 111,
        "completion_tokens": 1711,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "total_tokens": 1822,
        "successful_requests": 11,
        "failed_requests": 0,
        "api_requests": 11
      },
      "breakdown": {
        "models":      { "azure/gpt-4o": { "metrics": { … }, "metadata": {} } },
        "providers":   { "azure": { … }, "bedrock": { … } },
        "api_keys":    { "9f2b1c0a4d": { "metrics": { … }, "metadata": { "key_alias": "copilot-agents", "team_id": "team-platform" } } },
        "mcp_servers": { "github": { … } },
        "entities":    { "…": { … } }
      }
    }
  ],
  "metadata": { "total_spend": 0.72, "page": 1, "total_pages": 1, "has_more": false, … }
}
```

`entities` is the endpoint's *own* entity: users on `/user/…`, teams on
`/team/…`, tags on `/tag/…`. That is where the `user`, `team` and `tag`
dimensions come from — **[assumed]** for the user endpoint specifically.

The other **[assumed]** point: an admin (or admin-viewer) virtual key with no
`user_id` filter answers gateway-wide. LiteLLM scopes every spend route to what
the calling key may see, so a team-scoped key silently returns only that team's
usage — the numbers would look right and be wrong. Confirm the key's role before
trusting a first sync.

### The management endpoints (budgets and limits)

Usage says what the gateway *did*. Budgets say what it is *allowed* to do, and
they live on different routes — the management API, not the analytics one:

```
GET /key/list?page=1&size=100&return_full_object=true   → { keys, total_count, current_page, total_pages }
GET /team/list                                          → [ … ]   (a bare array, no envelope)
Authorization: Bearer sk-…
```

Field names come from LiteLLM's own models (`LiteLLM_VerificationToken`,
`LiteLLM_TeamTable`): `spend`, `max_budget`, `soft_budget`, `budget_duration`,
`budget_reset_at`, `tpm_limit`, `rpm_limit`, `blocked`, plus `key_alias` /
`team_alias`. Three things about them decide the whole design:

- **`size` caps at 100** (`Query(10, ge=1, le=100)`), and `/key/list` paginates
  on `total_pages` — there is no `has_more` here, unlike the activity envelope.
- **`keys` is `List[str] | List[UserAPIKeyAuth]`.** A proxy that ignores
  `return_full_object` answers bare token strings, which carry no budget at all.
  Those rows are dropped, not rejected: a proxy that only lists key names must
  not fail a usage sync.
- **The hashed `token` is the join key.** It is the same id the `api_key` usage
  dimension reports, and the same is true of `team_id` for `team`. A key row
  without a token is an orphan no spend can be read next to, so it is dropped
  and counted in the log.

`budget_duration` is LiteLLM's own duration grammar — `(\d+)(mo|[smhdw]?)`, with
the word aliases `hourly`/`daily`/`weekly`/`monthly` normalised first. Note that
`monthly` means **`30d`, not `1mo`**, per the proxy's own alias table; the two
differ by up to a day and a half, and `budgetPeriodStart` in `@dash/shared`
walks `mo` on the calendar for exactly that reason (a `1mo` budget resetting on
1 March began on 1 February, 28 days earlier).

## What the sync does

`services/gateway-sync.ts`, `refresh_jobs` kind `gateway`:

- Pulls **the whole 90-day window on every run**, not a trailing top-up. The
  endpoints are cheap enough, and a re-pull is the only path by which
  late-landing rows and retroactive price corrections ever reach us. There is no
  CSV bootstrap for this source — the window *is* the history.
- Ends at **yesterday UTC**. Today is still accruing and its aggregate would be
  revised the moment we stored it.
- Writes `gateway_daily` (one row per day) and `gateway_breakdown_daily`
  (one row per day × dimension × key), **delete-then-insert per fetched day**
  inside one transaction. Not an upsert: a re-pulled day's key set can shrink
  when a model is retired or a key rotated, and an upsert would leave the
  vanished keys standing and double-counting.
- Runs from the daily 07:00 Europe/Prague scheduler alongside the other three
  pulls, and on demand via `POST /api/refresh/gateway`.

The same job also pulls **budgets** and replaces `gateway_budget` entire, inside
the same transaction. Governance rides along with usage rather than on its own
schedule: it is two small requests, and a cap read hours apart from the spend it
is shown next to would be a worse lie than a slightly stale one. The table is a
snapshot, not a series — a rotated key or a deleted team has no row to keep, and
leaving one standing would show an owner a cap that nothing enforces any more.
Both management routes are optional in the same sense the team and tag activity
routes are: an analytics-only credential is a perfectly reasonable thing to
point this integration at, it will be refused key management, and `fetchBudgets`
answering `[]` is a supported outcome rather than a failed sync.

Only `/user/daily/activity` contributes the gateway-wide totals. `/team/…` and
`/tag/…` report the same spend re-sliced; adding their `metrics` in would
triple-count every dollar, so they are pulled purely for their `entities`
breakdown. Both are optional — a `401/403/404/405/501` on either is logged and
the dimension is skipped, because a proxy with no teams or tags configured
simply has no such route.

Requests retry on network errors, `429` and transient 5xx with a 0.5/1/2 s
backoff. `501` is pointedly **not** in the transient set even though it is a
5xx: it is a permanent statement about the route and it is also an "absent"
status, so retrying it would burn the whole backoff and then fail the sync with
*unreachable* instead of skipping the dimension it means to skip.

## Invariants

- **Money is bigint nano-dollars** (1e-9 USD) in Postgres, dollars at the API
  edge — the same rule `billing_daily` follows. LiteLLM reports per-model spend
  as low as `1.095e-05` USD, so cents cannot hold it and float sums drift.
  Values below 5e-10 USD round to zero, deliberately.
- **Token counters are bigint.** A corporate gateway clears int32's 2.1 billion
  ceiling in a single busy day.
- **Dimensions overlap by construction — never sum across them.** Each of
  `model`, `provider`, `api_key`, `team`, `tag` and `user` sums to the same
  daily total; they are six slices of one number. `mcp_server` is the exception
  and sums to *less* than the day: MCP traffic is a subset of the same requests.
- **Zero is a fact, not a gap.** Unlike the Copilot metrics, every counter here
  is non-null: the proxy omits counters it has no rows for, and a missing
  counter genuinely means none happened. The one nullable field is `label` (a
  key alias or team name the proxy may not have resolved), which renders `—`.
- **Budgets invert both of those, deliberately.** On `gateway_budget` a null
  limit means *no such limit*, and `max_budget = 0` means *budgeted at nothing,
  reject everything* — opposite states of one field, so nothing there is
  zero-filled. It is the one place in the gateway contract where absence is
  unknown-shaped rather than zero-shaped, and it is why the budget columns are
  nullable while every usage counter is `NOT NULL`.
- **A budget's `spend` is the proxy's counter, never our sum.** It covers the
  period in flight, which resets on the key's own schedule — possibly mid-day,
  possibly on a duration nothing else in the dashboard uses. Re-deriving it from
  `gateway_daily` would silently disagree with the number the proxy actually
  enforces, and the enforced one is what an owner needs. `blocked` is likewise
  carried, not inferred: an admin can disable a key nowhere near its cap.
- **Nothing outside `apps/api/src/gateway/` knows which source is active** —
  the same rule `copilot/` follows.

## Configuration

```bash
GATEWAY_SOURCE=off        # off (default) | mock | litellm
LITELLM_BASE_URL=         # https://llm-gateway.corp.example
LITELLM_API_KEY=          # admin / admin-viewer virtual key
```

`off` keeps the feature dormant: `POST /api/refresh/gateway` answers 503, the
scheduler logs the skip, `GET /api/gateway` returns empty ranges, and
`GET /api/gateway/status` reports `configured: false` so the UI can hide the
view. `GATEWAY_SOURCE=litellm` refuses to boot without both variables.

`mock` is the seeded generator in `gateway/mock.ts` — six long-lived virtual
keys across eight models on the three backends, with weekday seasonality, a
growth trend, ~2% failures and realistic prompt-cache ratios. Fixed Lehmer seed,
so the numbers are identical across restarts. Every breakdown is folded from the
same atomic rows, so the dimension invariant above holds in local development
too, and a UI that shows model spend ≠ provider spend is a bug in the UI.

It also runs a **twice-monthly re-embedding batch** on the `data-platform-etl`
key (the 9th and the 23rd, six times that key's normal traffic), because a
gateway that never bursts cannot exercise the unusual-spend card, and a
corporate one always bursts. Keyed off the calendar day rather than an index
into the pulled window, so the same date bursts whatever range is requested.
Only the *production* keys now touch every model every day — the sandbox key
still jumps between them, which is what makes the per-model drill-down worth
having, but at ~40k requests a day a production key dropping a model wholesale
swung the daily total further than the batch job does, and generator noise that
large is indistinguishable from the anomalies the page is meant to surface.

Failures are not uniform either, and for the same reason: a gateway where every
deployment fails at the same rate cannot exercise a reliability view, and no
real one does. Two sources sit on top of the ~2% baseline. `azure/o4-mini` is a
**capacity-constrained deployment** that rate-limits a steady ~7.6% of its
traffic, every day — a structural problem, and the one the reliability card's
key ranking is meant to name. `bedrock` runs a **two-day regional incident** on
the 17th and 18th of each month at ~16%, keyed off the calendar day like the
spend burst so a re-sync reproduces it. The incident is deliberately invisible
to every spend-shaped card on the page: a rejected call bills no tokens, so
those two days come in slightly *cheaper* than usual. That is the whole argument
for the reliability card being separate from the unusual-spend one.

**Budgets** are generated too, one per key and one per team, and their period
spend is not invented: it is this generator's own usage summed over the period
in flight, so a key sitting at 96% of its cap is at 96% of the spend the trend
chart draws. The caps are placed to cover the states a budget view exists to
distinguish — `copilot-agents` uncapped and rate-limited instead (the biggest
consumer is the one nobody dares cap, and its counter never resets, so it is
summed over the whole window rather than reported as zero); `data-platform-etl`
sized for ordinary ETL and walked into overrun by its own re-embedding batch;
`customer-support-bot` past its soft budget but inside its cap;
`sandbox-experiments` over a *weekly* budget and `blocked`, which is a separate
state from an exhausted one and is carried separately. The spend will not match
the same key's total in a 90-day pull to the cent — the Lehmer stream is
consumed from the start of whatever window is asked for — and that mismatch is
itself faithful: on a real proxy the enforced counter and the daily aggregates
are two different systems of record, which is precisely why the field is carried
rather than re-derived.

MCP traffic is the third planted shape. It is a subset of the same requests on
the two agent-shaped keys (`copilot-agents`, `customer-support-bot`), and two
things about it are deliberate. Its share of those keys' traffic **climbs ~3
points a month**, keyed off the calendar month rather than an index into the
window (so a 30-day pull and a 90-day pull agree about a given day) and
interpolated within the month, so a short range still shows movement — a gateway
sitting at a fixed agent share cannot exercise an adoption trend, and no real one
in 2026 is. And an MCP-routed call is **1.55× the weight** of the same key's
ordinary calls: calls scale by the share, while tokens and the dollars they
drive scale by the share times the weight, because a tool turn ships the
server's schemas, the tool results and the conversation so far. That asymmetry
is what the agent card's unit-economics contrast reads; scaling spend without
scaling tokens (which is what the generator originally did) makes
tokens-per-call a pure artefact of the scaling.

**People** are the fourth planted shape, and they carry two dials rather than
one, because neither alone produces a usable population. Each key has a roster
(fourteen names on `copilot-agents`, three service identities on
`data-platform-etl`), and which name carries a row is drawn as
`index = ⌊n · u^p⌋` over a uniform draw — a **skew** dial where `p = 1` is a
uniform pick and `p = 2.6` gives the first name on a twelve-person roster ~35% of
that key's rows. Real gateway usage is heavily skewed and a uniform pick would
have made the concentration card report a property of `Math.random`. The skew
**flattens** ~0.115 a month and the onboarded share of each roster **grows** ~7
points a month, both keyed off the calendar month like the burst and the MCP
ramp. Both are needed: broadening alone never produces a user who was not there
last month, and a growing roster alone leaves the newcomers invisible, because
the number of rows a key emits per day is bounded by the models it routes to,
not by how many people it has. The batch key is exempt from both — a batch
platform runs under the same few service identities however big its bill gets,
which is why the mock's heaviest per-user row is `etl-service@corp.example` and
the card's footnote about shared service keys reads as a live example rather than
a caveat. The roster ramp clamps at fully-onboarded in late 2026, after which
`new users` reads zero: a horizon of the generator, fixed by lengthening the
rosters rather than by changing the derivation.

**Prompt-cache behaviour** is the fifth planted shape, and the only one that
costs money continuously rather than in an incident. It is a per-workload
profile (`CACHE_PROFILES`), because on a real gateway caching is a property of
how a workload builds its prompts and not of the proxy: a long-lived system
prompt re-read all day reads back ~11 tokens per token written, short chat turns
have little worth caching, `risk-doc-analysis` **churns** — every document is a
different prompt, so it commits a fresh cache entry on nearly every call and
reads back ~0.19 per write, below the ~0.28 break-even, which makes it *more*
expensive than not caching at all — and `sandbox-experiments` never enables
caching. The churn is deliberately invisible everywhere else on the page: that
key simply reads as busy, and it takes the two token counters to tell "expensive
because it does a lot" from "expensive because it re-sends the same input". The
payload settles the claim rather than asserting it — the churning key runs
$3.26 per million input tokens against $2.18 gateway-wide, which
`verify-gateway-cache.ts` checks.

## Endpoints

| Method | Path | Answer |
| --- | --- | --- |
| `GET` | `/api/gateway?from=&to=` | `{ daily, breakdowns }` for the inclusive range — fetched once, everything derived client-side. |
| `GET` | `/api/gateway/budgets` | `{ budgets }` — current caps, rate limits and period spend per key and team, keys first, each scope ranked by share of cap consumed with the uncapped rows last. No parameters: it is state, not a range. |
| `GET` | `/api/gateway/probe` | A live connection check — see below. Reads no table, writes nothing, and always answers `200`: a dead proxy is a result, not an error. |
| `GET` | `/api/gateway/status` | `{ source, configured }`. |
| `POST` | `/api/refresh/gateway` | `202` with the job to poll; `503` while the source is `off`. |

## The connection check

`GET /api/gateway/probe`, behind **Test connection** on the `Data sources`
page (`apps/web/src/components/sources/GatewayProbePanel.tsx`). It calls every
route the sync depends on — the three activity routes for a single day, then
`/key/list` and `/team/list` — and reports what each one answered.

It exists because everything else on this page is a draft written against
published documentation. The day a real proxy and a real credential appear, the
first questions are the open ones at the bottom of this file, and until now the
only way to ask them was to start a 90-day sync and read the failed job's error
string. One round trip per route answers most of them in a couple of seconds,
before anything is written to Postgres.

Six statuses, and the distinctions between them are the whole point:

| Status | Means |
| --- | --- |
| `ok` | Answered, parsed, carried rows. |
| `empty` | Answered and parsed, reported nothing for the probed day. |
| `denied` | `401`/`403` — the route exists and this credential may not have it. |
| `absent` | `404`/`405`/`501` — this proxy does not offer the route at all. |
| `malformed` | `2xx` with a body this client cannot read. |
| `unreachable` | Network error, timeout, or any other status. |

`denied` and `absent` are deliberately separate here even though
`ABSENT_STATUSES` folds them together in the sync: the sync's only choice is to
skip, so it does not need to care, but one of them is fixed by granting the key
a permission and the other cannot be fixed at all. Collapsing them makes a
misconfigured credential look like a proxy without teams.

Three further deliberate differences from a sync. The probe **does not retry** —
retrying a `503` three times would turn a flaky gateway into a green tick and
make the button take eight seconds to say so. It **does not throw** — a refused
route and a dead host are results with statuses on them. And it counts **keys
per dimension**, because a route can answer `200`, carry rows, and still leave a
breakdown card blank; the panel shows those counts so the missing dimension is
visible before someone goes looking for it on the gateway page.

The two summaries — can this sync, and what will be missing if it does — come
from `summarizeGatewayProbe` in `@dash/shared`, so the API, the panel and the
contract harness all read one implementation. Two of its rules are worth
stating:

- An `empty` **required** route is not a failure and is still a warning. A
  gateway that genuinely saw no traffic yesterday and a credential scoped to one
  team that saw none are indistinguishable from here — which is open question 1,
  put in front of someone rather than guessed at.
- An empty `mcp_server` count is not a gap. It is a strict subset of the
  traffic, so a gateway with no MCP servers legitimately reports none; every
  other dimension is on every call, and a zero there means the breakdown did not
  arrive.

What it cannot answer: whether the numbers it got back are the *whole* gateway.
A team-scoped key answers `200` with plausible rows. The probe surfaces the
counts (six API keys, twenty-six users) so a reader can tell whether they look
like the corporation or like one team, and that judgement is a person's.

Under `GATEWAY_SOURCE=mock` the mock client answers a healthy probe derived from
its own generated day, so the panel has something to render before anyone has a
proxy. It cannot be made to fail: every interesting failure is wire-level and
belongs to the live client, where the contract harness drives them against a
server that really answers `403`.

## The view

`LLM gateway` in the sidebar (`apps/web/src/components/gateway/`). It follows
the Copilot spend section's contract exactly: **one fetch per range, everything
else derived client-side** by pure functions — `lib/metrics/gateway.ts` for the
totals and the ranked breakdowns, `lib/metrics/gatewayChart.ts` for the SVG
path maths. Changing dimension, or re-slicing the range within what is already
loaded, never touches the network.

What it shows, and why each one is there:

| Element | Reads |
| --- | --- |
| KPI row 1 | Gateway spend · requests (with success rate) · tokens (in / out) · blended $/1M tokens |
| KPI row 2 | Prompt-cache hit rate · cost per request · failed requests |
| Trends | Daily spend, daily tokens, daily requests — the same hand-rolled 900×240 SVG as every other chart in the console |
| Breakdown | One dimension at a time, ranked by spend, with each row's share **of the gateway-wide total** |
| Drill-down | Selecting a breakdown row opens that key's own daily trend (spend / tokens / requests) and its unit economics: $/1M, $/request, cache-hit and success rate |
| Period-over-period | Every KPI carries its change against the immediately preceding window of the same length; `Biggest movers` ranks the current dimension's keys by how many dollars they moved |
| Why spend moved | The same two windows split three ways — volume (more tokens at the prices already being paid), mix (the same tokens routed somewhere dearer), rate (the same slice costing more per token) — with the current dimension's keys ranked by what volume does *not* explain |
| Unusual spend | Days that ran away from their trailing 14-day median, biggest overrun first; selecting one attributes the overrun across the currently selected dimension |
| Month-end forecast | This calendar month's spend to date and where it lands, projecting each remaining day at what that weekday has been costing |
| Reliability | Failure rate per day as a strip, plus the current dimension's keys ranked by failures **above** the gateway-wide rate, with the ones that are significantly and materially worse badged |
| Agent traffic | MCP-attributed spend against everything else — the split, its unit economics ($/call and tokens/call vs the remainder), the daily share strip, half-over-half adoption, and the MCP servers ranked by share **of agent spend** |
| Budgets and limits | Every governed key or team (a switcher, one scope at a time): its state, the proxy's own counter against its cap with the owner's soft budget marked on the bar, what remains, where the current pace lands by the period's end, and its TPM/RPM ceilings |
| People on the gateway | How many users the proxy attributed calls to and what share of spend carries a user id at all, distinct actives per day, spend and calls per user, how many of the population call on an average day, users first seen in the second half of the window, and the concentration read — how few users are half the attributed bill, and 80% of it |
| Chargeback statement | One calendar month's spend, split across the units that will be billed for it (team / tag / API key / user, one at a time) — each line with its share of the month, its tokens, its blended $/1M and the same line in the month before, plus an explicit **unallocated** line and a CSV export |
| Prompt cache | Input tokens the backends served from cache against the ones we paid to send again — the split, the daily hit rate, reads per token written against the break-even, the share of the input bill the cache is keeping off it, the headroom, and the current dimension's keys ranked by uncached input with the two fault states badged |

Fourteen decisions worth keeping:

- **The breakdown is a switcher, not seven cards.** Seven cards side by side
  invite reading the dimensions as parts of a whole and adding them up, which
  the overlap invariant forbids. One at a time, with the share column always
  measured against the gateway-wide daily total, keeps the arithmetic honest —
  and makes `mcp_server` visibly sum to less than 100%, as it should.
- **Rows rank by spend, not by request count.** This is a FinOps console: the
  model that ran twice at $4 outranks the one that ran 4,000 times at a
  thousandth of a cent.
- **The unsynced tail is trimmed, not zero-filled.** The sync ends at yesterday
  UTC and a preset range anchors on today, so the last day or two of the spine
  are days the proxy was never asked about. Interior gaps stay zero-filled (a
  quiet weekend is a real dip); the tail is dropped, or every chart would end
  in a cliff to the floor every single day.

- **The drill-down is one dimension deep, and stays that way.** A selected key
  gets its own series on the *same* spine as the totals above it — same first
  day, same last day, same trimmed tail — so "is gpt-4o climbing?" is answered
  by comparing two charts with one axis. What it deliberately does **not** show
  is a cross-dimension mix (this team's models, this model's teams): LiteLLM's
  daily aggregates report each dimension independently, with no joint key, so
  that number does not exist in the payload and could only be invented. If it
  is ever wanted, it needs a new pull — `LiteLLM_SpendLogs`, or a
  `/spend/logs`-derived aggregate — not a new derivation.

- **The comparison window is measured off the trimmed spine, not off the
  requested range.** A "30d" range holds 29 reported days; comparing those
  against a full 30 would book a day of missing traffic as a decline, every
  day. The prior window is therefore exactly as long as what is on screen, ends
  the day before it starts, and is fetched separately (`lib/metrics/
  gatewayCompare.ts` + `useGatewayComparisonData`) because its bounds are not
  known until the current payload has answered. If the prior window falls
  outside the proxy's 90-day retention it is not requested at all and no
  comparison renders — an empty payload there would mean "never synced", and
  drawing it as −100% would be a lie. Rates are compared in percentage
  *points*, counts and dollars in percent, and a key with no prior spend reads
  `new this period` rather than an infinite ratio.

- **Unusual days are detected on a median and attributed on a mean.** The two
  baselines in `lib/metrics/gatewayAnomaly.ts` are different on purpose. A
  *median* over the preceding fortnight is what the day is judged against,
  because a mean is dragged upward by the very spike being looked for and one
  bad Tuesday would then mask the next one; the baseline also never includes
  the candidate day itself. A *mean* is what the overrun is attributed with,
  because means add up — the sum of the per-key means is the mean of the total,
  so the contributor rows reconcile to the day's overrun exactly, and the share
  column is a reconciliation rather than a decoration. The card names which
  baseline it is measuring against rather than letting the reader assume they
  are the same number. Two gates must both pass (≥25% above baseline *and*
  ≥3.5 robust deviations), and only overruns are flagged: a quiet Saturday is
  already visible on the trend chart, and a card that fires every weekend is a
  card nobody reads. Attribution follows the breakdown's dimension, so the two
  cards never disagree about which slice is under discussion.

- **The month-end forecast prices each remaining day by its weekday, and
  fetches its own window.** `lib/metrics/gatewayForecast.ts` projects the
  *calendar month*, not the selected range — a projection is only meaningful
  against the period a budget is set in, and nobody budgets in "last 7 days".
  Its window is the month to date plus the 28 days before the month started, so
  the weekday profile is the same size on the 2nd as on the 28th; at 58 days
  worst case it is always inside retention, so it needs no guard. Each
  remaining day is priced at that weekday's trailing mean rather than at a flat
  daily rate, because gateway traffic is workload-shaped: in the mock's own
  profile a Saturday runs at $78/day against a Tuesday's $483, so a flat rate
  prices the last weekend of a month like a working week. The card shows the
  flat answer alongside, and the weekday strip beneath it, so the correction is
  evidence rather than assertion. Two things it deliberately does not do:
  extrapolate growth (the trailing means already carry whatever trend is
  there — fitting a curve on 90 days of daily aggregates would dress a guess up
  as a model, and the consequence, that a ramping gateway reads low, is stated
  on the card), and count today as spent (the sync ends at yesterday, so the
  projection starts after the last *reported* day). A month with no reported day
  yet — the 1st, or the 2nd before a sync — renders no card at all rather than
  a projection built entirely out of last month.

- **Reliability is read two ways at once, because one view cannot find both
  kinds of failure.** `lib/metrics/gatewayReliability.ts` derives a per-day
  failure *rate* strip and a per-key ranking, and the mock's two planted faults
  show why both are needed: a permanently rate-limited deployment is invisible
  in the day strip (it is 8% bad every day, so no day stands out) and tops the
  key ranking; a two-day regional incident is invisible in the key ranking (two
  bad days in sixty average away to nothing) and lights up two bars in the
  strip. A card with only one of the two views would miss one of the two
  faults. Keys rank by failures *above* the gateway-wide rate rather than by
  count — ranking by count re-answers "who gets the most traffic", which the
  breakdown card above already answers, and would crown a healthy busy model
  every day. That excess is signed and sums to zero across a full-coverage
  dimension, which makes the column a redistribution of the same failures
  rather than an opinion, and is asserted as such. The `elevated` badge needs
  **two** gates to pass, and they guard opposite regimes: a Wilson score
  interval against the gateway-wide rate (thin evidence — a key that failed 3 of
  4 requests has no case to answer) *and* a minimum ratio of 1.5× (significant
  but trivial — across half a million requests a 3.39% rate is *certainly*
  worse than a 3.31% one, and nobody can act on that). With only the interval,
  the badge lands on roughly every key above the mean, which is half of them.

- **`mcp_server` is the one dimension the totals can be split *by*, and the
  agent card is the only place that does it.** Every other card ranks *within* a
  dimension, because the six full-coverage dimensions are re-slices of the same
  dollar and subtracting one from the totals would be meaningless. `mcp_server`
  is different in kind: it is a strict subset of the same requests, so
  `remainder = totals − attributed` is a real quantity, and
  `lib/metrics/gatewayAgents.ts` is built on exactly that one legal subtraction
  (clamped at zero, with any day that violated the invariant *reported* rather
  than swallowed — an over-attributing proxy is a fault to raise, not a negative
  to hide). It is deliberately **not** wired to the dimension switcher: reading
  it through the switcher would put it back among the peers it is not one of.
  The wording is "MCP-attributed", never "agents", and the footnote says why —
  LiteLLM tags a call only when it routed through an MCP server, so an agent
  driving its own tool loop over `/chat/completions` lands in the remainder next
  to the human chat turns. The number is a **floor** on agent traffic. What the
  card is actually for is the two things the floor still answers: the *contrast*
  (a tool turn ships schemas, tool results and the conversation so far, so it is
  usually a heavier and dearer call — the card measures that ratio instead of
  asserting it, because a gateway whose MCP traffic is short lookups runs the
  other way) and the *direction* (share half-over-half, weighted by dollars
  rather than averaged over daily shares, so a quiet weekend of batch agent work
  cannot carry the trend). The server rows take their share from **attributed**
  spend rather than gateway spend — the breakdown card already answers "how much
  of the bill is this server", and "how much of the agent bill" is the different
  question that ranks tool usage.

- **The budget card is the one card that totals nothing.** Every other surface
  on the page adds dollars freely, because every row it adds shares one 90-day
  spine. A budget does not: each row's `spend` is the proxy's counter over *that
  row's own period*, and a real proxy mixes them — the mock alone has five
  monthly budgets, one weekly one, and one key with no period at all whose
  counter simply never resets. `$30 per week + $1,800 per month` is a number
  with no unit, so `lib/metrics/gatewayBudgets.ts` aggregates **counts of
  objects** and nothing else, and the card's headline is "4 of 6 keys need
  attention" rather than any share of any dollar. The same reasoning forbids one
  tempting metric outright: "what share of gateway spend is uncapped" cannot be
  derived here, because the uncapped rows' counters cover an unbounded period
  while the capped ones cover a month or a week. Coverage is reported in objects.
  Scopes are a switcher for the breakdown card's reason — a key's cap and its
  team's cap govern the *same* dollars, and the live mock shows it plainly
  (`data-platform-etl` at 144.8% of its own $3,000 cap is `Data Platform` at
  120.7% of the team's $3,600), so merging the two scopes would count that
  overrun twice. Beyond the states LiteLLM reports, the card derives one thing:
  **pace** — `spend ÷ share of the period elapsed`, which is what turns "96% of
  cap" into "96% of cap on day 12 of 30". It is deliberately linear, deliberately
  null before a sixth of the period has passed (one batch job on the first
  morning of a month projects thirty times itself), and deliberately null for a
  counter with no period, which has no end to project to. Overrun is never
  clamped — a proxy bills past a cap on in-flight requests, and hiding it would
  make the one state nobody can undo the least visible one on the card. And null
  stays the opposite of zero all the way to the pixel: an uncapped row draws no
  bar at all (a full one reads as spent-through, an empty one as untouched, and
  it is neither), while a `max_budget` of `0` renders as **blocked**, next to the
  administratively disabled keys it behaves like.

- **The adoption card reads the gateway as a population, and says how much of
  the bill that population accounts for before it says anything else.**
  `lib/metrics/gatewayAdoption.ts` is pinned to the `user` dimension the way the
  agent card is pinned to `mcp_server`, and for a related reason: `user` is the
  only slice that is a *population* rather than a workload, and "how many people
  and how evenly" has no meaning read through `model` or `provider`. Its
  headline constraint is **coverage**. LiteLLM carries a user on a call only if
  the caller passed one, so unlike `model` and `provider` the user rows are not
  obliged to reconstitute the gateway total — a service key acting on nobody's
  behalf carries no user at all. The card therefore leads with attributed spend
  over gateway spend, because a per-user table at 40% coverage is describing a
  minority of the money and reading it as the whole is the single mistake this
  card is most able to cause. That is also why it uses **two denominators**: a
  row's `share` stays gateway-wide, comparable with the breakdown table, while
  concentration is measured *within* the attributed spend, since "how unevenly
  is usage spread" is a question about a distribution and unattributed dollars
  would flatten it artificially. Concentration is reported as **counts of
  users** — "5 users are half the attributed spend, 15 are 80% of it" — rather
  than as a Gini coefficient, for the same reason the budget card counts objects:
  a number someone can act on beats an index that needs a paragraph first. The
  two readings it produces are genuinely different arguments — a gateway whose
  top decile carries half the bill is a chargeback conversation with three
  teams; one where the spend is spread broadly is a per-seat economics
  conversation with finance. Two limits are stated on the card rather than
  hidden: a row is whatever the caller passed as an end-user id, so a shared
  service key reads as one very heavy "user" (in the mock it is the top row by
  design), and **"new" is bounded by the window on screen** — someone who last
  called the week before the range starts is indistinguishable here from someone
  who never has, so no churn number is derived at all.

- **The prompt-cache card reports tokens and refuses to report dollars.**
  `lib/metrics/gatewayCache.ts` reads the two counters LiteLLM carries beside
  spend — `cache_read_input_tokens` and `cache_creation_input_tokens` — and
  answers the one question on this page with a cheap fix attached: of everything
  we fed the models, how much had we fed them before. It is the page's second
  non-money derivation and it exists for the same reason the reliability card
  does — a workload re-posting a 6,000-token system prompt on every call has no
  owner to escalate to and produces no anomaly to flag. It just reads as *busy*
  on every spend-shaped surface here.

  It cannot report dollars, and the reason is structural rather than fastidious:
  the proxy's daily aggregate carries one `spend` per row covering input, output,
  cache reads and cache writes together, with no per-model price anywhere in the
  payload. Splitting that back apart means assuming a price list, and this
  gateway fronts three backends whose lists differ. The single weighted figure
  the card does show — the share of the input bill the cache is keeping off it —
  is labelled as the pricing **convention** it is (0.1× to read, 1.25× to write,
  which is what Anthropic publishes and Bedrock mirrors; Azure OpenAI's cached
  discount is shallower, so the figure is the optimistic end).

  Those same two multipliers give the card its only real threshold. Writing `W`
  tokens costs `0.25·W` over sending them plain; reading `R` back saves `0.9·R`;
  so a cache is ahead of not caching at all above `R/W = 0.278` reads per write.
  A row below that line is **churning** — paying the write premium and
  collecting almost none of the discount — and that is a fault under any of the
  three backends' price lists, which is what makes it worth a badge when "below
  the gateway average" is not. Only two states are badged, `churning` and a
  material workload with no cache activity at all; everything else is
  unremarkable by design. Iteration 10's reliability badge is the precedent:
  flagging every row under the mean flags half of them by construction.

  Rows rank by **uncached input tokens**, the size of the opportunity, not by
  hit rate — ranking by rate puts a 0%-cached key that sent nine thousand tokens
  above the workload re-sending millions a day. Headroom levels each row up to
  the gateway's *own* rate rather than to the best row's or to 100%, so it is a
  floor rather than a target nobody hits. The card follows the dimension
  switcher, and reading it through two dimensions is itself informative: on the
  mock, headroom by `api_key` is ~277M tokens and by `model` it is ~6M, because
  every model serves every workload — cache behaviour is a property of how a
  workload builds its prompts, not of the deployment it routes to.

- **The movement is decomposed by an identity, and the identity is what limits
  where the card may be read.** `lib/metrics/gatewayMix.ts` splits the spend
  delta between the two comparison windows into three effects, per key `i`,
  with `t` for tokens, `p` for dollars per token and `s` for share of the
  window's tokens:

      volume_i = (T₁ − T₀)·s_i₀·p_i₀     more tokens at the old prices
      mix_i    = T₁·(s_i₁ − s_i₀)·p_i₀   the same tokens routed elsewhere
      rate_i   = t_i₁·(p_i₁ − p_i₀)      the same slice costing more per token

  Those sum to `t_i₁p_i₁ − t_i₀p_i₀` — the key's own spend delta — with no
  interaction term left over, and summed across a dimension that reconstitutes
  the totals they reproduce the gateway-wide movement exactly. That exactness is
  the card's whole claim: three *reasons*, not three opinions, which is why the
  rows can be read as contributions and why the verify script asserts the
  identity per key as well as in total. It is also the constraint on where the
  card is allowed to appear — `mcp_server` is a strict subset and `user` may be
  partially attributed, so for those the three effects explain only part of the
  movement. The derivation measures its own coverage and marks itself
  **unusable** rather than reporting a short sum that looks like a full one.

  Three consequences worth stating. **Volume is counted in tokens**, because a
  token is what the gateway is billed for; the cost is that a workload holding
  its request count and doubling its prompt length reads as volume rather than
  as a price change, and that a key's `p` is a blended input+output rate, so an
  output-heavy shift inside one model lands in rate. Both are on the card.
  **It follows the dimension switcher**, and unlike every other card that does,
  the switcher changes the *answer*: traffic moving from a cheap model to a dear
  one inside one provider is mix by `model` and rate by `provider`. The mock
  shows it plainly — the same $73.74 movement reads as `mix $55.06 / rate
  −$4.08` by model and `mix −$2.53 / rate $53.50` by provider. Neither is wrong,
  and seeing a movement change character between two slices is the finding.
  Volume is a gateway-wide quantity and is identical in every dimension, which
  the verify script asserts. **The render gate is on the gross effect, not on
  the net delta**: a gateway whose bill held flat while it processed 20% fewer
  tokens at a 25% dearer blended price has not had a quiet month, and it is the
  one case every other card on the page reports as nothing at all.

  A key present in only one window is handled by the identity rather than by a
  special case. An arrival has no prior price, so it is priced at the
  *gateway's* prior blended rate: it then reads as mix (traffic moved to it)
  plus rate (it is dearer, or cheaper, than what the gateway used to pay), and
  the sum is still exactly its spend. A departure's rate term is zero by
  construction and its mix term gives back exactly what it used to cost.

- **The chargeback statement is the one surface that has to add up, and every
  rule on it follows from that.** `lib/metrics/gatewayChargeback.ts` +
  `GatewayChargebackCard` are not an analysis of the gateway's spend but a
  *bill* for it, and a bill leaves the dashboard — it is exported, pasted into
  a finance thread, and argued with by the department on the line. Four
  consequences:

  **The lines plus an explicit `unallocated` row equal the month's gateway
  spend exactly.** No top-N cap (a department missing from its own statement is
  a different kind of bug from a key missing from a ranked table), and the
  remainder is *never* spread pro-rata across the other lines. LiteLLM carries
  a user or a tag only when the caller passed one, so a service key acting on
  nobody's behalf legitimately falls outside every row; distributing those
  dollars would invent an attribution the proxy never made and put an
  unauditable number on someone's line. It is shown, labelled, and left there.
  The mock reconciles at 100% coverage on all four payer dimensions, which
  makes the remainder row a live check rather than a decoration.

  **Only payer-shaped dimensions are offered** — `team`, `tag`, `api_key`,
  `user`. `model` and `provider` are the supply side (a statement charging AWS
  Bedrock $4,000 bills nobody) and `mcp_server` is a strict subset rather than
  a slice. And because the dimensions overlap, a month is billed by exactly one
  of them: the card says so, and the exported file repeats it in its own
  preamble, since the recipient cannot see the card.

  **The period is a calendar month, picked on the card, independent of the
  range picker** — the same reason the forecast fetches its own month. Only
  months whose *first* day is still inside the proxy's 90-day retention are
  offered; a month missing its opening days would bill short. The month in
  flight is offered as a preview and labelled as one.

  **A month still running is compared against the same number of days of the
  month before it**, cut by day-of-month and clamped (a run through the 31st
  compared with February stops at the 28th and says `partial`). Comparing
  twelve days against a whole month would report every statement as a collapse
  until the month ended — the same failure mode the comparison window avoids by
  measuring off the trimmed spine rather than the requested range.

  The export (`buildChargebackCsv` in `lib/exportCsv.ts`) carries a preamble
  naming the period, its status, the dimension, the gateway total, the
  allocated sum, the remainder and the overlap warning, then the rows and the
  remainder as a row of the table — so a recipient who sums the spend column
  lands on the gateway total, which is the first thing anyone does with the
  file.

`apps/api/scripts/verify-gateway-drilldown.ts` checks the derivations against a
freshly generated mock payload — series align to the spine, sum back to the
ranked row they were opened from, and never exceed the gateway-wide day they
slice. Run it with
`DATABASE_URL=… node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-drilldown.ts`.
It sits outside `apps/api/tsconfig.json`'s `include` on purpose: it imports the
web app's metrics modules, which do not belong in the API's build.

`apps/api/scripts/verify-gateway-compare.ts` does the same for the
period-over-period layer: the prior window is adjacent and equal-length, the
deltas are arithmetic over the two payloads, and — the load-bearing one — each
full-coverage dimension's signed movements add back up to the gateway-wide
swing, while `mcp_server` — being a subset — is bounded in *level* in each
window rather than in movement. (It was bounded in movement until the mock grew
an adoption ramp, at which point the assertion failed for the right reason: a
subset that is growing while the gateway holds flat legitimately swings more
than the gateway does.) Run it the same way.

`apps/api/scripts/verify-gateway-anomaly.ts` covers the unusual-spend layer: the
mock's twice-monthly batch bursts are the only days flagged (no weekday burst
missed, no ordinary day flagged, no weekend ever), a flat series produces
nothing while an injected quadrupling produces exactly one hit, traffic starting
from zero is new rather than anomalous, and — the load-bearing one — each
full-coverage dimension's per-key overruns sum to the gateway's overrun exactly,
with `batch` correctly named as the culprit the generator actually burst.

`apps/api/scripts/verify-gateway-forecast.ts` **backtests** the month-end
forecast: a completed calendar month is pulled once, replayed day by day as if
it were still running, and each day's projection scored against the total that
actually happened. One pull, sliced — never two, because the mock's Lehmer
stream is consumed from the window start, so the same date carries different
numbers in a 30-day pull and a 59-day one and comparing across windows would
measure the generator rather than the maths. Averaged over the whole month the
weekday-aware and flat projections land within a fraction of a percent of each
other (both ~7% low, which is the mock's compound growth neither extrapolates);
in the **final week**, where the remaining days are two weekend days or three
midweek ones, the weekday profile is measurably closer — that is the assertion
the script makes, alongside the structural ones (the projection never falls
below month-to-date, a completed month projects exactly what it spent, an
unsynced tail does not change the answer, an empty payload projects nothing at
all, and February 2024 ends on the 29th).

`apps/api/scripts/verify-gateway-reliability.ts` covers the reliability layer.
The reconciliation checks first: every full-coverage dimension's failure counts
sum to the gateway's, its shares sum to 1, and its signed excess sums to zero,
while `mcp_server` stays a strict subset. Then the two planted faults, each
found by the view it belongs to — the rate-limited deployment tops the key
ranking and carries the badge, the regional incident produces exactly the
flagged days it ran on (and no others) plus that provider's worst day, and is
explicitly **not** badged as a key. Then the gates in the regimes they exist
for: 1 failure of 2 requests is real evidence and still immaterial, while every
above-baseline key that goes unbadged is one the interval would have passed and
the ratio rejected — so a passing run means the materiality gate is doing the
work, not a lucky interval. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-reliability.ts`.

`apps/api/scripts/verify-gateway-agents.ts` covers the agent split. The
load-bearing check is that it really is a partition: attributed + remainder
reproduces the gateway totals on *every* counter, and no single day attributes
more than the gateway saw, which is the only licence for subtracting a dimension
from the totals at all. Then the server rows reconcile to the attributed total
and their two share columns use the two denominators they claim to; then the
unit economics, where the mock's planted asymmetry has to survive — MCP traffic
carries a larger share of tokens than of calls, tokens-per-call lands in the
range a tool turn plausibly occupies rather than the artefact that scaling spend
without scaling tokens would manufacture, and dollars-per-token stays within 5%
of the rest (an MCP tag changes what a call carries, not what a token costs).
Then the adoption ramp, checked through a second, shorter pull, because a ramp
keyed on the window rather than on the date would read differently in a 30-day
range than in a 60-day one. Then the edges: no MCP rows stands the card down
rather than claiming 0% agents, a 4-day spine reports no trend, an empty range
reports nulls not zeros, and a deliberately over-attributed day clamps *and* is
named. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-agents.ts`.

`apps/api/scripts/verify-gateway-budgets.ts` covers the governance layer. It
classifies a real mock snapshot and checks each state against the shape the
generator planted it as — the uncapped key that carries the gateway's largest
counter, the key past its soft budget, the key its own batch burst drove into
overrun, and the blocked one — so the badges are checked against intent rather
than against themselves. Then the rule the whole table rests on: null and zero
are opposite ends. An uncapped row has no utilization, no remaining and no soft
mark; a `maxBudget: 0` row is *blocked*, with the reason carried separately from
the admin flag. Then the ordering (blocked first, then descending share of cap,
uncapped last ranked by dollars), the scope separation (key ids and team ids
never collide, so the two scopes can never merge), and the pace projection in
both regimes — a month one day in projects nothing, half a month at $600 against
a $1,000 cap projects $1,200 and is flagged as pacing over, and every projection
that does answer is exactly `spend ÷ elapsed`. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-budgets.ts`.

`apps/api/scripts/verify-gateway-adoption.ts` covers the population layer. The
reconciliation first: the ranked user rows sum to the attributed totals, the
attributed totals never exceed the gateway's (the bound that makes `coverage` a
share rather than a ratio of two unrelated numbers), the shares of attributed
spend sum to 1 while the gateway-wide shares sum to coverage, and the cumulative
column is monotone and ends at 100%. Then the claim the card makes in words:
every concentration count is checked to be the *smallest* count reaching its
mark, read off the same cumulative column the table renders, so the sentence and
the rows under it cannot disagree. Daily actives are checked against the
payload's own distinct user keys per day, and a user with a row but no request
does not count as active. The planted shapes are checked as shapes — the
heaviest user carries more than twice an even split (the skew is real, not a
property of `Math.random`), and an equal-length window later in the range holds a
larger population than one earlier in it, which is the onboarding ramp and
nothing else. That comparison is deliberately made **within one pull**: the
mock's Lehmer stream is consumed from the window start, so the same calendar day
draws a different user in a 20-day pull than in a 60-day one, and only the
date-keyed *structure* — how much of each roster is onboarded, how skewed the
pick is — is stable across windows. Finally the edges: a payload with no user
rows stands the card down instead of reporting zero users of a real bill, a
4-day spine reports no trend and flags nobody as new, and an empty spine derives
nulls rather than dividing by zero. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-adoption.ts`.

`apps/api/scripts/verify-gateway-cache.ts` covers the prompt-cache layer. The
split first, since every other number rests on it: cached + uncached equals
input on every day and every row, the days sum to the range totals, every
full-coverage dimension reconstitutes the gateway-wide split while `mcp_server`
stays a strict subset, and the shares of uncached input sum to 1 so the column
is a decomposition of the opportunity rather than a decoration. Then the
break-even is re-derived from the two published multipliers and checked to
separate the mock's three cache regimes — the churning document workload badged,
the sandbox read as untouched headroom, and the workloads whose caches pay for
themselves badged as neither. The badge is a claim about money, so the script
settles it in dollars the payload actually carries: the churning key's spend per
input token must exceed the gateway's, which is the whole argument for the card
(on a spend-shaped surface that key is indistinguishable from a busy one).
Headroom is checked to be the row-by-row levelling it claims — never negative,
never larger than the uncached tokens it comes out of, and exactly zero when
every row already sits at the gateway rate. The edges cover an empty spine, a
gateway with no prompt cache at all (both counters zero: a real 0%, not an
unknown, and the card stands down), a key too small to badge, and a write-only
key, which must read as `churning` on a zero reuse rather than falling through
to `unused` on the strength of its zero hit rate. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-cache.ts`.

`apps/api/scripts/verify-gateway-chargeback.ts` covers the chargeback
statement, and what it checks is what a bill has to survive. The lines plus the
remainder must reproduce the month's gateway spend to the cent on every payer
dimension the proxy answered — and not only the dollars: requests and tokens
reconcile the same way, because a department that cannot dispute a line's money
will dispute the tokens behind it. Line shares must sum to the statement's own
coverage figure (they take the gateway-wide denominator, like every share on
the page), and `api_key` must leave nothing unallocated, since every call is
made with a key. The month is proven to be the *only* window that contributes,
checked within one pull rather than against a second one: the mock's Lehmer
stream is consumed from the window start, so re-fetching a different range
redraws the same calendar day and the comparison would measure the generator
instead of the derivation — trimming the payload to the two months, and padding
it with a day six months away, must both leave the bill unchanged. The period
arithmetic is pinned where it is easy to get wrong (2024-02 ends on the 29th,
2023-02 on the 28th, January's prior month is the previous December, a prior
month outside retention is refused rather than fetched short), and the partial
comparison is exercised on a constructed payload where the two answers differ
by construction: a July reported through the 10th compares against the first
ten days of June ($100, flat) and the same July once finished compares against
all $300 of it. The export is parsed back and its spend column summed, which
must land on the gateway total, with the remainder as its last row and RFC 4180
escaping checked on a key carrying a comma and a quote. The edges cover an
unreported month (which must not read as complete), a month with one day and no
breakdown rows (everything falls into the remainder), and a dimension
attributing *more* than the gateway saw — clamped so no negative remainder is
drawn, and surfaced as `reconciles: false` rather than hidden. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-chargeback.ts`.

`apps/api/scripts/verify-gateway-mix.ts` covers the volume/mix/rate
decomposition, and it is the one layer where the checks *are* the design: the
split has to be an identity or the card is three opinions. So the script asserts
it twice over — per key (`volume + mix + rate` equals that key's own spend
delta) and gateway-wide (nothing unexplained across every full-coverage
dimension, while `mcp_server` at ~18% coverage is refused rather than reported
short). The headline effects are checked to be the sum of the rows that make
them up, not a second derivation of the same quantity, and the volume effect is
checked to be identical in every dimension, since it is a gateway-wide number
that no slicing can change. Then each effect is isolated on a constructed
payload where only one thing moved: doubling every key's tokens at fixed prices
is pure volume, re-weighting a fixed token count toward a dearer key is pure
mix, and re-pricing a fixed mix is pure rate — a failure there means an effect
is absorbing movement that belongs to another. The arrival/departure convention
is pinned in dollars (a new model at $9/M against a $6/M gateway splits as $6 of
mix and $3 of rate), and the edges cover no prior traffic, no tokens, a
70%-covered dimension, a 0.2% movement that reconciles but is not worth a card,
and the case the gate exists for — a flat bill hiding $20 of volume against $20
of rate, which must still render. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-mix.ts`.

`apps/api/scripts/verify-litellm-contract.ts` is the odd one out: it is the only
script that exercises the **live** client rather than the mock. It stands up a
throwaway HTTP server answering the envelope documented above and points
`LiteLlmGatewayClient` at it, so the wire-level behaviour is checked against a
server instead of against a reading of the docs — bearer auth and query
parameters, two-page pagination merging into one day and one bucket, the three
ways a proxy can leave `has_more` lying, `1.095e-05` reaching Postgres as
`10950` nano and a sub-nanodollar rounding to zero, labels resolved from
`key_alias`/`team_alias`/`user_email`, empty keys dropped, omitted counters and
whole absent breakdown groups defaulting to zero rather than throwing, a
malformed envelope failing loudly instead of syncing silently empty, `429` and
`503` retried while `401/403/404/405/501` are answered once and skipped, and the
load-bearing one — the `/team` endpoint's `metrics` **and** its own
`models` breakdown staying out of the totals, so the same dollars re-sliced
never double-count.

It also covers the **management** routes, where the load-bearing rule is the
null one: an uncapped key keeps `null` limits (zero-filling them would render
the gateway's least constrained key as its strictest), while a `max_budget` of
`0` stays `0`. Alongside it: `/key/list` asked for full objects 100 to a page
and paginated on `total_pages`, bare-string and tokenless key rows dropped, a
token repeated across pages yielding one row rather than a primary-key
collision, `/team/list` read from a bare array, aliases trimmed and empty ones
nulled, a six-fractional-digit reset timestamp parsed and an unparseable one
nulled rather than reaching Postgres as an Invalid Date, a refused `/key/list`
yielding no budgets instead of failing the sync while `/team/list` still
answers, and a mistyped budget field throwing rather than syncing a silently
wrong cap. A final section checks the pure budget arithmetic in `@dash/shared`,
because it interprets LiteLLM's own duration grammar: `monthly` is 30d and not
`1mo`, a `1mo` period is walked on the calendar (a 31st resetting monthly clamps
to 28 February rather than rolling into March), an overrun reads above 100%
rather than clamped, and a zero cap has no percentage at all. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-litellm-contract.ts`.

A final section covers the **probe**: one attempt per route and no retries (a
`403` and a `501` are each answered exactly once), the activity routes asked
about exactly one day, `401/403` classified apart from `404/405/501`, the
proxy's own refusal message carried through instead of swallowed, a non-JSON
body and a contract-violating one both landing as `malformed` rather than
`unreachable`, distinct keys counted per dimension, a proxy answering bare token
strings reported rather than silently dropped, and the two summary rules — an
analytics-only credential that can still sync, and an empty `mcp_server` count
that is not a fault.

It cannot confirm that a real proxy *sends* these shapes — that is still an open
question below. It is, though, the harness for answering it: drop a captured
response from the real gateway into a handler and the assertions become a
conformance check of the proxy rather than of the client.

The page reads `GET /api/gateway/status` first: with `GATEWAY_SOURCE=off` it
renders the configuration hint instead of empty charts, and the Sync button is
disabled. The `Data sources` page carries a matching LiteLLM row with the same
gating.

## Open questions for the day we get access

**Start with the connection check.** `Test connection` on the `Data sources`
page answers 3, 5 (partly — it probes one day, but an `absent` or `empty`
activity route is the same signal) and 6 outright, shows the *shape* of the ids
question 2 is about, and gives question 1 the only evidence available without a
second credential to compare against. It runs before anything is written, which
is the point: the alternative is starting a 90-day sync and reading the failed
job's error string.

1. Does the admin key really answer gateway-wide, or does the proxy scope it?
2. Is `breakdown.entities` on `/user/daily/activity` keyed by user id, and is
   that id an email, an SSO id, or a LiteLLM-internal id? The `user` dimension
   is only joinable to `jira_people` (and thus to cost centres) if it carries
   something an identity system recognises.
3. Which LiteLLM version is deployed? `cache_creation_input_tokens`,
   `mcp_servers` and the `/tag/daily/activity` route are all recent additions;
   older proxies answer 404 or omit the fields (both handled, both silent).
4. Is there a per-request tag convention in place (`metadata.tags`) that would
   let the tag dimension carry cost centres directly?
5. Retention: how far back do the daily aggregate tables actually go? The
   90-day window assumes at least that much.
6. Will the credential we are given be allowed `/key/list` and `/team/list` at
   all? An analytics-scoped key is refused management routes, in which case
   budgets simply never appear (handled, logged, and not fatal). If it *is*
   allowed, does `/key/list` return the same hashed `token` the `api_key` usage
   breakdown is keyed by? Everything about reading a budget next to the spend it
   governs rests on those two ids being the same string.
7. Are budgets actually configured on the corporate proxy, and at which level —
   per key, per team, or per tag? `/tag/list`-style tag budgets exist in newer
   LiteLLM versions and are not read here; whether they are worth adding depends
   entirely on which level the gateway's owners actually govern at.

## Not yet built

Governance is now rendered end to end (`GatewayBudgetCard`, on
`lib/metrics/gatewayBudgets.ts` over `GET /api/gateway/budgets`). What is still
missing on this side of the gateway:

- **Tag budgets.** LiteLLM's newer versions can budget per tag as well as per
  key and per team; only the latter two are read. Open question 7 above is what
  decides whether it is worth adding.
- **Budget history.** `gateway_budget` is a snapshot replaced wholesale by every
  sync, so "was this key already over last week" has no answer here. Keeping one
  row per sync would give it one, at the cost of a table that grows with the
  scheduler rather than with the gateway — worth doing only if someone asks the
  question.
- **Acting on a budget.** The card is read-only, deliberately: raising a cap is
  a `POST /key/update` against production inference for the whole corporation,
  and it needs a different authorisation story than a dashboard cookie.
- **Chargeback beyond 90 days.** The statement can only bill months whose first
  day is still inside the proxy's retention window, so the third month back
  disappears partway through every month. `gateway_daily` already holds
  everything the sync has ever seen, but the read route serves the requested
  range from the table without distinguishing "the proxy no longer has this"
  from "we never asked" — a month sealed at close (a `gateway_month` snapshot,
  or simply trusting the stored days) is what would make a statement issuable a
  year later. Worth doing the first time someone asks for last quarter.
- **Cost centres on a gateway line.** A statement bills a team id, a tag or an
  email, not a department: joining those to the org taxonomy the Copilot side
  already has (`lib/metrics/costCentre.ts`) needs the `user`/`team` ids to be
  something an identity system recognises, which is open question 2 and 4 and
  cannot be settled from here. Until then the statement is billed against the
  proxy's own identifiers, which is what the export carries.
