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

`POST /api/refresh/gateway?from=&to=` is the same job with a narrower window — a
**backfill**, for repairing the gaps `GET /api/gateway/coverage` reports without
re-pulling a quarter to do it. Both bounds are optional and default
independently to the nightly window's own, and `resolveGatewaySyncWindow` is the
one place the rules live:

- Bounds outside the window are **clamped**, not refused. A request reaching
  further back than the proxy holds gets what the proxy holds, and one running
  through today stops at yesterday — the same answer a full sync would give, so
  a gap straddling the retention floor is half-repairable rather than hopeless.
- An **inverted** window and one lying **entirely** outside retention are `400`.
  The second is the one worth arguing for: those days are pruned upstream, so a
  sync of them would succeed, write nothing, and leave the gap exactly where it
  was — a button going quiet and green while fixing nothing is worse than a
  refusal that says why.
- A ranged sync **writes only the days it fetched**, `gateway_budget` included:
  governance is a snapshot of the whole proxy, not of a date range, so a repair
  of six days in May has no business replacing it. The full sync still replaces
  it every night.
- Single-flight is per *kind*, so a backfill asked for while the nightly sync is
  already running gets that job back instead. Benign — the full window is a
  superset of any range it would have covered — but it does mean the job that
  answers can be wider than the one requested.

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

The same fetch is also **appended** to `gateway_budget_history`, which is the
opposite kind of write from the snapshot beside it: one row per governed object
per **UTC day**, upserted, so a second sync the same afternoon updates that day's
row instead of adding one. The day key is the whole design — the table grows
with the gateway and the calendar and is indifferent to how often the scheduler
runs, so a dashboard synced hourly costs exactly what one synced nightly does.
It exists because the proxy has no history to give: `/key/list` answers with the
counter for the period *in flight* and nothing about the period before it, which
leaves three ordinary questions unanswerable — when did this team go over, what
did its last period come to, who moved the cap. None of them can be recovered
from `gateway_daily`, because the enforced counter runs on the key's own
schedule and is not our sum of days. Two consequences:

- A **backfill records nothing here.** It does not fetch budgets at all, so it
  has no governance state to file; inventing an observation for a repaired day
  in May would be recording something nobody saw.
- **There is no bootstrap and never will be.** History starts when recording
  started, which is why `GET /api/gateway/budgets/history` answers
  `recordingSince` outside its own window: "this key was never over its cap in
  the last 30 days" and "we started watching yesterday" are otherwise identical.

After a **full** sync (never a backfill) the job takes a **month seal**: any
calendar month that has now ended with every one of its days stored, and that
carries no seal yet, is recorded in `gateway_month` and `gateway_month_line`.
That is the moment the answer changes — the run that stores a month's last day
is the run that makes it sealable — and it rides along for the same reason
governance does, one fewer schedule to reason about. Three rules:

- **Never implicitly re-sealed.** A month that already carries a seal is skipped
  even when the daily rows have since moved, because that divergence is the
  whole point of having a seal. Re-issuing is
  `POST /api/gateway/months/:month/seal?force=true`, by hand.
- **A re-seal adds a revision; it never overwrites one.** Every statement a
  month has carried stays in `gateway_month`, the replaced ones stamped with
  `superseded_at` and a partial unique index keeping exactly one of them
  current. A corrected bill is only auditable next to the bill it corrected,
  and the recipient of the first one needs it to still exist under a number
  they can quote.
- **A backfill does not seal.** It repairs days inside a month that may already
  be sealed; taking the first seal of a month the moment its gap is filled would
  mean a repair silently issues a statement. That decision belongs to whoever
  ran the repair.
- **Never fails the sync.** The usage has already landed by then, and a
  bookkeeping step that could not run today runs tomorrow.

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
- **A budget observation is a sample, not a series.** `gateway_budget_history`
  holds one reading per governed object per day the sync ran. A day with no row
  is a day nobody looked — not zero, and not "unchanged" — so nothing derived
  from it may be interpolated, and a period total read from it (`observedTotal`)
  is a **floor**: the counter is read once a day and the reset is on the proxy's
  clock, so whatever landed in between is not in it. The same rule as
  `gateway_daily`'s coverage gaps, one table over.
- **A sealed month is a record, not a cache.** `gateway_month` is written once,
  at close, and is never refreshed to agree with `gateway_daily` again. Every
  read on the page still derives from the daily rows; the seal exists to be
  compared against them, so a re-seal is always explicit and always replaces a
  statement that was issued.
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
| `GET` | `/api/gateway/budgets/history?days=` | What those same budgets read on each of the last `days` days (default 60, max 365) — the dashboard's own recording, since the proxy serves current state only. Nothing is filled in for a day no sync ran. `recordingSince` is answered *outside* the window, because "never over its cap" and "we started watching yesterday" are otherwise the same answer. |
| `GET` | `/api/gateway/coverage` | Which days `gateway_daily` actually holds: first and last stored day, how many are stored, which are missing and in what runs, how many predate the proxy's retention window, and the `floor` every picker on the page clamps to. No parameters — it is the answer to *what may I ask for*. |
| `GET` | `/api/gateway/months` | `{ seals }` — every calendar month that has been sealed, newest first, with the totals as recorded. Headers only; no parameters. |
| `GET` | `/api/gateway/months/:month` | One sealed month with its per-payer lines — the statement as issued. `?revision=` quotes a *replaced* statement by number; omitted, it answers with the current one. `404` when the month was never sealed (or has no such revision), carrying the `check` that says why (still running, or missing days to backfill). |
| `GET` | `/api/gateway/months/:month/revisions` | Every statement the month has carried, newest first, with a pure diff for each re-seal: what the month moved by, and which payer lines moved with it. `404` for a month that was never sealed. |
| `POST` | `/api/gateway/months/:month/seal` | Seal a closed month by hand. `400` for a month still in flight or with holes in it, `409` for one already sealed — `?force=true` re-seals and replaces the statement that was issued. |
| `GET` | `/api/gateway/probe` | A live connection check — see below. Reads no table, writes nothing, and always answers `200`: a dead proxy is a result, not an error. |
| `GET` | `/api/gateway/status` | `{ source, configured }`. |
| `POST` | `/api/refresh/gateway` | `202` with the job to poll; `503` while the source is `off`. |
| `POST` | `/api/refresh/gateway?from=&to=` | The same job narrowed to a backfill of those days — how a coverage gap is repaired. Bounds are optional and clamped to the sync's own window; `400` for an inverted range or one the proxy has pruned entirely. |

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
| Needs attention | Every finding the cards below have already made, in one list at the top: severity, what it is, the numbers the source card carries, and a button that scrolls to it — plus a **Not checked** footer naming the inputs that could not be read. Renders nothing when there is nothing to report *and* nothing unread |
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
| Budget history (per row) | Opening a budget row shows what that key or team read on previous days: a strip of the recorded share of cap with a **hole** on every day nobody synced, the changes we caught (period resets, cap and soft-budget moves, rate-limit changes, renames, blocks, and the day it crossed its cap), and the periods that closed inside the record — each labelled *at least*, because the counter is read once a day |
| People on the gateway | How many users the proxy attributed calls to and what share of spend carries a user id at all, distinct actives per day, spend and calls per user, how many of the population call on an average day, users first seen in the second half of the window, and the concentration read — how few users are half the attributed bill, and 80% of it |
| Chargeback statement | One calendar month's spend, split across the units that will be billed for it (team / tag / API key / user, one at a time) — each line with its share of the month, its tokens, its blended $/1M and the same line in the month before, plus an explicit **unallocated** line and a CSV export |
| Prompt cache | Input tokens the backends served from cache against the ones we paid to send again — the split, the daily hit rate, reads per token written against the break-even, the share of the input bill the cache is keeping off it, the headroom, and the current dimension's keys ranked by uncached input with the two fault states badged |
| Seal badge on the statement | Whether the month on screen is *final* — recorded at close and quotable — and, when the daily rows have moved since, by how much. Nothing renders for a month still in flight |
| Revision history on the statement | For a month that has been billed more than once: every statement it has carried with its own total and what it moved by, and — for the payer dimension on screen — which lines moved into the current revision, with dollars the proxy attributed to nobody in one revision or the other named rather than spread. Fetched only for a month that has one, so the ordinary month costs no extra request |
| Coverage note | Days inside the stored span that carry no row at all (and the runs they form), and how much history predates the proxy's retention window. Each run still inside the window carries a **Fill** button that backfills exactly it; a run the proxy has pruned reads *pruned upstream* and offers nothing. Renders nothing when there is nothing to say, which is the normal state |

Nineteen decisions worth keeping:

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
  months whose *first* day is still covered are offered; a month missing its
  opening days would bill short. "Covered" means the stored history rather than
  the proxy's window — see the coverage decision below — so a statement stays
  issuable after LiteLLM has pruned the month it bills. The month in flight is
  offered as a preview and labelled as one.

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

- **How far back the page may look is a property of the table, not of the
  clock.** Everything above reads *usage*; `GET /api/gateway/coverage` reads the
  shape of `gateway_daily` itself, and it exists because the two answers
  diverge the longer the scheduler runs.

  The sync deletes only the dates it re-fetched, so the table is not a rolling
  window — it accumulates every day it has ever pulled while LiteLLM prunes its
  own rollup at 90. A floor computed in the browser as *today − 90* therefore
  hides data the API is holding, and it gets steadily worse the longer the
  dashboard runs. `coverage.floor` — the first stored day, or the retention
  floor when nothing is stored — is now the single number the range picker, the
  comparison window and the chargeback month list all clamp to. The retention
  floor stays the fallback until coverage answers, deliberately: it is the
  narrower of the two, so the picker can lag behind the stored history for a
  moment but can never offer a range with nothing behind it.

  Lifting that clamp is what makes the other half necessary. `deriveGateway`
  zero-fills interior days on purpose — a quiet weekend is a real dip, and
  dropping it would misdraw every chart — but a stretch when the scheduler was
  down zero-fills *identically* and reads as a fortnight when the corporation
  stopped using the gateway. From inside a usage payload the two are the same
  bytes. The only place they can be told apart is against the list of dates that
  actually carry rows, which is why gaps are reported as runs (`2026-06-10 –
  2026-06-16`, seven days) rather than as a count, and why the note says which
  of them a future sync can still fill: anything newer than the retention floor
  will come back, anything older is gone from the proxy for good.

  `daysBeyondRetention` is the same fact read the other way — history that
  exists here and nowhere else, and therefore the part of the range no sync can
  ever correct. It is stated on the note rather than left implicit, because it
  is also the licence for the widened floor.

  Two arithmetic details, both easy to get wrong by one: the retention floor is
  `today − retentionDays`, matching the first day the sync actually asks the
  proxy for (its window is 90 days *ending yesterday*), not `today − 89` — the
  other reading reports the first day of every ordinary sync as unrepeatable
  archive. And `storedDays + missingDays == spanDays` is asserted, because
  without it "eleven days missing" is a number nobody can act on.

- **A closed month is sealed, and the seal is never read in place of the daily
  rows.** Every number on this page is derived on the fly from `gateway_daily`,
  which is right for an analysis and wrong for a bill. A statement leaves the
  dashboard and is argued with months later, and the rows behind it are ordinary
  daily rows that any sync may rewrite: LiteLLM revises late-landing usage, a
  backfill re-fetches a repaired day, and the aggregate the bill was cut from
  can move under it. `gateway_month` and `gateway_month_line` record the month's
  totals and its per-payer lines once, at close, with the instant it was taken.

  Two conditions, and both are about the month being *finished* rather than
  old: it has ended (a month in flight is a preview, and sealing one records a
  partial bill as final), and every one of its days is stored (a sum over 29 of
  30 days is not the month's cost). The second refusal names the missing days
  rather than counting them, because the fix is a backfill and the caller needs
  a range to ask for — and `force` re-issues a statement but does **not** waive
  it, or a re-seal during an outage would quietly book a short month.

  The seal is deliberately not a second source of truth. The chargeback card
  still derives what it shows from the daily rows; the seal is what it is
  *compared against*, which is the only way "June's bill has moved since we
  issued it" becomes a question with an answer. That is also why the sync never
  re-seals implicitly: a month that quietly re-agreed with the daily rows has
  destroyed the evidence that it was revised. Only the payer dimensions are
  recorded (`team`, `tag`, `api_key`, `user`) — `model` and `provider` bill
  nobody and `mcp_server` is a subset — and they are stored side by side and
  never summed, the same overlap rule the daily breakdowns carry.

- **A re-seal issues a revision beside the statement it replaced, and the diff
  between them is pure.** A seal alone is enough to *notice* that a month has
  moved — `sealDrift` compares it against the live rows — and not enough to
  settle an argument about it: a department disputing a corrected invoice needs
  its own line before and after, not the gateway's total. So
  `gateway_month`/`gateway_month_line` are keyed by `(month, revision)`, a
  re-seal stamps `superseded_at` on the statement it replaces rather than
  deleting it, and a partial unique index guarantees exactly one revision of a
  month is current. Revision numbers count every statement the month has ever
  carried, so a number a recipient quotes always means the same document, and
  `GET /api/gateway/months/:month?revision=` serves the replaced one.

  `diffSeals` in `@dash/shared` is what makes the chain readable, and it is
  pure in a way `sealDrift` is not: both sides are *records*, so the answer
  cannot move again once the two revisions exist. Lines are matched on
  `dimension + key` and never on the label — an alias resolved between two
  seals is the same payer, not an arrival plus a departure. A line that moved
  by less than a cent is not shown (nano-dollar rows settle their last digits
  on any re-fetch, and a list of those is unactionable), while an appearance or
  a disappearance always is, however small: a payer gone from the re-issued
  bill is a fact about the bill rather than about the amount. Each dimension
  carries `unattributedDelta` — the month's movement its lines do not account
  for, measured over *every* line including the suppressed ones — reported
  rather than spread, for exactly the reason the statement's `unallocated` row
  is.

- **The budget card grew a history, and the history is a sample.** Everything
  above the fold on that card is current state, because that is all
  `/key/list` has. The disclosure under each row is the dashboard's own
  recording (`gateway_budget_history`, one reading per object per day, written
  by the full sync), read by `lib/metrics/gatewayBudgetHistory.ts` as *changes*:
  a counter that fell rolled its period, a cap that moved was moved by somebody,
  a utilisation that crossed 100 crossed it on the day we saw it. Three
  properties of the input decide the rest of the design.

  A **day nobody observed is unknown** — not zero and not "unchanged" — so the
  strip draws a hole, `daysMissing` is counted over the object's own span, and a
  gap is itself an event, because a cap could have been raised and lowered again
  inside it and this module would never know. A **closed period is a floor**:
  `observedTotal` is the last counter seen before the roll, and whatever landed
  between that reading and the proxy's own reset is not in it, so the card says
  *at least*. And the **window is clamped forward to `recordingSince`** rather
  than padded with empty days, because there is no backfill for this table and
  never will be — the proxy does not serve past budget state.

  Two consequences worth stating. A **lowered cap produces a crossing with no
  spend at all**, which is why the crossing is measured against the previous
  reading's own cap and the cap change sits on the same day as its explanation.
  And the sub-cent guard is load-bearing: nano→dollars is a float division, and
  reading a hair's fall as a period boundary would invent a one-day period every
  time it happened.

- **The digest at the top owns no threshold, and never reads silence as
  health.** `lib/metrics/gatewayAlerts.ts` is the page's only derivation *of
  derivations*: it takes the already-derived summaries — budgets, budget
  history, anomalies, reliability, cache, coverage — and puts their findings in
  one list, because thirteen cards each flagging their own faults means every
  fault is below the fold. It never re-reads the payload and never decides
  anything is interesting: it can only surface a state a source module already
  flagged, with that module's own numbers. A digest that could disagree with the
  card it points at would leave the reader with two answers and no way to
  choose, and it is also what makes the list checkable in both directions —
  every row must trace to a flagged row, and every flagged row must produce a
  row.

  Severity is an editorial mapping from a state to an urgency, not a second
  test: `critical` is calls being rejected or money already past a line
  (nothing improves by waiting), `warning` is something a person has to decide
  about, `info` is a standing inefficiency with no deadline — a churning cache
  costs the same tomorrow. Within a band the source's own ranking survives
  untouched, since those rankings were chosen for their own cards.

  Three things it deliberately does not do. It **carries no total**: the dollars
  on these rows come from different denominators — a budget counter covers that
  row's own period, an anomaly's excess covers one day, a cache row is not
  dollars at all — so there is nothing to sum, exactly as on the budget card,
  and it counts findings instead. It **does not merge findings about one key**,
  because a key over its budget that is also failing is two problems with two
  fixes. And it **does not read an empty list as an all-clear**: every input it
  could not read (a proxy that refused the management routes, a history too
  short to show a crossing, coverage that has not answered) is named in a
  *Not checked* footer, because "nothing to report" and "nothing was read" look
  identical from a list and mean opposite things. `allClear` — nothing to report
  *and* nothing unread — is the only state that renders no card at all; an
  all-clear banner on a healthy proxy is furniture people learn to scroll past,
  including the week it matters.

  Two consequences of the sources. Reliability and cache follow the page's
  breakdown switcher, so the digest does too and says so — switching the
  dimension can legitimately rename those findings while every other row stays
  put. And a row currently over its cap is not *also* reported as a historical
  crossing: the state finding already says so, and saying it twice would be the
  digest disagreeing with itself about how many problems there are.

`apps/api/scripts/verify-gateway-seal-history.ts` covers both halves of that.
The pure half is `diffSeals`: the sub-cent settle that is not a change, the
alias that does not make a new payer, an arrival and a departure, the sample
cap that never loses the count, and the reconciliation identity per payer
dimension. The Postgres half is the chain: seal a complete month, move one day
of one API key's rows under it, re-seal, and require revision 1 to still be
readable, still carry its original total and lines, and be stamped superseded,
while exactly one revision claims to be current, the seal list shows only that
one, and the diff names the one key that moved by the $12 it moved. It restores
the day through a ranged sync before it finishes. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-seal-history.ts`.

`apps/api/scripts/verify-gateway-seal.ts` covers both halves. The pure half is
`resolveMonthSeal`: a complete month, a month in flight on its own last day and
on the day after, the sync's one-day lag reading as `incomplete` rather than as
`in_flight`, holes named and counted, the sample cap that never loses the count,
both Februaries and a December sealed in January. The Postgres half seals the
newest complete stored month and requires the header to reproduce the daily
rows, every payer dimension's sealed lines to reproduce what `deriveChargeback`
derives from the same payload key by key, a re-seal without `force` to be
refused `409`, and then — the actual claim — deletes a day and requires the seal
to *stay put* while the derivation moves, with `sealClosedMonths` declining to
repair it. It restores the day through a ranged sync and re-seals before it
finishes. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-seal.ts`.

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

`apps/api/scripts/verify-gateway-budget-history.ts` covers the recording and
what is read off it, and its two halves fail differently. The pure half drives
`deriveBudgetHistory` over constructed readings, and the assertions that matter
are the negative ones: a fall of two tenths of a cent is *not* a period
boundary, a day nobody observed carries no numbers at all and is not filled in,
a roll seen across a sampling gap does not claim to be contiguous, a soft breach
is reported once rather than on every day it stays breached, and a day that goes
over the hard cap is not also filed as a soft breach. The positive ones pin the
rest: a closed period carries the last counter seen *before* the roll rather
than the first of the next, a cap lowered under a standing spend produces a
crossing dated to the day it was seen with the utilisation it came from, an
uncapped row has no utilisation anywhere, and a window reaching before recording
started is three days long rather than ten empty ones.

The Postgres half asserts the two rules the write has to obey. A full sync
appends exactly one row per governed object for today, agreeing with the
snapshot it came from to the nano and keeping an uncapped cap `null` rather than
`0` — and a *second* sync the same day updates that row instead of adding one,
which is the day key doing its job. A ranged backfill appends nothing at all.
Then it plants six days of readings for one really-stored capped key (a climb
into an overrun, a roll, and one day nobody looked), reads them back through
`getGatewayBudgetHistory`, runs the web derivation over the result, and requires
the overrun, the reset, the one-day gap and the closed period's floor to all
come out the other side — then deletes exactly what it planted and checks that
it did. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-budget-history.ts`.

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

`apps/api/scripts/verify-gateway-coverage.ts` covers the coverage read. Nothing
here is a metric, so there is nothing to reconcile — what there is, is
arithmetic that is easy to get subtly wrong and impossible to notice on screen.
The span identity (`storedDays + missingDays == spanDays`) is asserted on every
constructed table, including one whose gap list has been truncated, since the
count must stay complete while the list becomes a sample. Gaps are checked as
runs with the right bounds and lengths, newest first, with a one-day run
carrying `from === to` (or the label reads as a range) and a February-crossing
gap pinning the day arithmetic where a naive month count is off by 28.
`daysBeyondRetention` is checked against a six-month table and against one that
is entirely pruned. Two cases are the load-bearing ones: an empty table must
floor at the retention floor, so a fresh install clamps exactly as it did before
this route existed; and a gateway synced once must report *no* archive at all,
which is what pinned the retention floor to the sync's own window rather than to
`today − 89`. The consequence is asserted directly by importing the web app's
`chargebackMonths` — six billable months on a stored floor against two on a
retention floor, and never a month starting before the first stored day. The
mock client is driven at the end to confirm the ordinary case is silent: a
normal 90-day sync writes one row per day, no gaps, no archive, and the note
renders nothing. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-coverage.ts`.

`apps/api/scripts/verify-gateway-range-sync.ts` covers the backfill, and it is
the only gateway script that checks two unrelated kinds of thing because the
feature fails in two unrelated ways. The window arithmetic is pure and is where
the off-by-ones live: the default must still be 90 days ending yesterday, each
bound must default independently, a window straddling the retention floor must
clamp to it, one running through today must stop at yesterday, and the two
refusals (inverted, entirely pruned) must fire — with the boundary cases pinned
on both sides, since a window *ending* on the floor is fetchable and one ending
the day before is not. The blast radius is not pure and cannot be reasoned
about, so it is asserted against Postgres: a run of five stored days is deleted,
backfilled by exactly that range, and then every *other* stored day's spend must
be byte-identical, the backfilled days must carry both totals and breakdown
rows, and a sentinel row planted in `gateway_budget` must survive — a full sync
empties that table, so the sentinel is the assertion that a ranged one left
governance alone. What the script deliberately does *not* assert is that a
backfilled day comes back to the same cent: the mock consumes its Lehmer stream
from the start of the requested window, so a five-day pull and a ninety-day pull
disagree about the same date, and equality there would be a property of the
generator rather than of the sync. The database section is skipped loudly when
the gateway has never synced locally. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-range-sync.ts`.

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

`apps/api/scripts/verify-gateway-alerts.ts` covers the attention digest, and
what it has to prove is different from every other script here: not that a
number is right, but that the list says exactly what the cards below it say —
which is two assertions in opposite directions. **Nothing invented**: every
alert traces back to a row of the summary it claims to come from, in the state
it claims — a budget row that really is blocked, over, past its soft budget or
projected over, an anomaly date the detector really flagged, a reliability key
the two gates really badged, a churning cache row, a gap that really is on the
coverage report. **Nothing dropped**: the count of each kind equals the number of
flagged rows that source holds, so the digest cannot quietly stop reporting a
category. Then the two self-consistency rules — a key that is over its cap now
does not also appear as a historical crossing, while a state finding and a pace
finding about one row are two different claims and both belong — the documented
ordering (severity, then editorial kind order, then each source's own ranking
untouched, which is `Array.sort` being stable), the cap costing visibility and
never accuracy (identical counts capped and uncapped, with `truncated` closing
the gap), ids unique and stable across two derivations, and the completeness of
the kind tables, since a kind missing from the order table would silently sort
to the front of its band. Finally the honesty checks: an unread gateway reports
no findings, is **not** all clear and names its blind spots; a gateway that was
read and is healthy is all clear; a one-reading history says the crossing
question is unanswerable rather than answering it; and switching the breakdown
dimension moves the reliability and cache rows and nothing else. The budget
history it needs cannot come from the mock (that table accrues from real sync
runs on distinct days), so the crossing case is planted the way earlier syncs
would have written it. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-alerts.ts`.

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
- **Budget history beyond what we recorded.** `gateway_budget_history` now
  answers "was this key already over last week" — but only back to the first
  sync that wrote it, and only at daily resolution. Neither limit can be lifted
  from here: the proxy serves current state and has nothing older to give, and a
  finer sample would mean syncing more often for no other reason. A crossing no
  longer has to be found by opening a row — the attention digest at the top of
  the page carries it — but it is still only *on the page*: nothing leaves the
  dashboard. Sending it somewhere (mail, Slack, a webhook) needs a scheduler
  hook, a delivery target and a de-duplication story, none of which the console
  has today.
- **Acting on a budget.** The card is read-only, deliberately: raising a cap is
  a `POST /key/update` against production inference for the whole corporation,
  and it needs a different authorisation story than a dashboard cookie.
- **Withdrawing a seal, and a reason for a revision.** A month's statements are
  now a chain — every revision is kept, superseded rather than deleted, and the
  diff between two of them says who moved — but a seal still cannot be
  *withdrawn* (a month sealed in error stays sealed until it is re-sealed), and
  a revision carries no note saying why it was issued. Both are small columns;
  neither is worth adding before someone has an actual correction to record.
- **Backfilling beyond the window.** A gap inside the proxy's 90 days is now a
  **Fill** button on the coverage note (`POST /api/refresh/gateway?from=&to=`).
  A gap older than the retention floor still has no answer and structurally
  cannot have one from the proxy: those aggregates are pruned upstream. The only
  route to them would be a second source — an export taken before they aged out,
  or the proxy's own database — which is a different integration, not a wider
  window.
- **Cost centres on a gateway line.** A statement bills a team id, a tag or an
  email, not a department: joining those to the org taxonomy the Copilot side
  already has (`lib/metrics/costCentre.ts`) needs the `user`/`team` ids to be
  something an identity system recognises, which is open question 2 and 4 and
  cannot be settled from here. Until then the statement is billed against the
  proxy's own identifiers, which is what the export carries.
