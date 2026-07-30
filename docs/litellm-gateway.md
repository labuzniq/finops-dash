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

## Endpoints

| Method | Path | Answer |
| --- | --- | --- |
| `GET` | `/api/gateway?from=&to=` | `{ daily, breakdowns }` for the inclusive range — fetched once, everything derived client-side. |
| `GET` | `/api/gateway/status` | `{ source, configured }`. |
| `POST` | `/api/refresh/gateway` | `202` with the job to poll; `503` while the source is `off`. |

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
| Unusual spend | Days that ran away from their trailing 14-day median, biggest overrun first; selecting one attributes the overrun across the currently selected dimension |
| Month-end forecast | This calendar month's spend to date and where it lands, projecting each remaining day at what that weekday has been costing |
| Reliability | Failure rate per day as a strip, plus the current dimension's keys ranked by failures **above** the gateway-wide rate, with the ones that are significantly and materially worse badged |

Eight decisions worth keeping:

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
swing, while `mcp_server` can only move a subset of it. Run it the same way.

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
never double-count. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-litellm-contract.ts`.

It cannot confirm that a real proxy *sends* these shapes — that is still an open
question below. It is, though, the harness for answering it: drop a captured
response from the real gateway into a handler and the assertions become a
conformance check of the proxy rather than of the client.

The page reads `GET /api/gateway/status` first: with `GATEWAY_SOURCE=off` it
renders the configuration hint instead of empty charts, and the Sync button is
disabled. The `Data sources` page carries a matching LiteLLM row with the same
gating.

## Open questions for the day we get access

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
