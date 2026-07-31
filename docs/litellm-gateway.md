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
GET /tag/list                                           → [ … ]   (a bare array, limits nested)
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

**`/tag/list` is a third envelope, not a second copy of `/team/list`.** It shares
the bare-array shape and adds three differences of its own:

- **The limits are one level down.** `LiteLLM_TagTable` carries only `tag_name`
  (its primary key, and the same string the `tag` usage dimension is keyed by),
  `description`, `models`, `spend` and a `budget_id`; the caps, the duration and
  the rate limits live on the joined `LiteLLM_BudgetTable` row, which the
  endpoint includes as `litellm_budget_table`. A tag linked to a budget the
  endpoint did not expand lands with every limit null — uncapped, which is the
  honest answer from that payload rather than an invented cap.
- **The response mixes configured tags with observed ones.** The endpoint
  appends *dynamic* tags: strings that merely appeared in spend data and were
  never created, assembled from a spend aggregation, so they carry no budget
  link and no `spend` column. Those are usage, not governance — they are already
  rows of the `tag` breakdown dimension — and admitting them here would put
  objects nobody ever governed into the denominator the budget card reports
  coverage against. `isGoverned` in `litellm.ts` drops them and logs the count.
- **The counter is not reset.** See the invariant below; this is the one fact
  about tags that changes what the dashboard is allowed to derive.

`budget_duration` is LiteLLM's own duration grammar — `(\d+)(mo|[smhdw]?)`, with
the word aliases `hourly`/`daily`/`weekly`/`monthly` normalised first. Note that
`monthly` means **`30d`, not `1mo`**, per the proxy's own alias table; the two
differ by up to a day and a half, and `budgetPeriodStart` in `@dash/shared`
walks `mo` on the calendar for exactly that reason (a `1mo` budget resetting on
1 March began on 1 February, 28 days earlier).

### The model catalogue endpoint (prices)

Usage says what the gateway *did*, budgets say what it is *allowed* to do, and
the catalogue says what it is *configured to charge*:

```
GET /model/info      → { "data": [ { model_name, litellm_params, model_info } ] }
Authorization: Bearer sk-…
```

One entry per **deployment**, three nested objects each, and none of the three is
flat:

- **`model_name` is the public alias** — the string a caller puts in `"model"`,
  and the same string the `model` usage dimension is keyed by *when the proxy is
  configured with aliases*. `litellm_params.model` is the backend behind it
  (`azure/gpt-4o-eastus`, `bedrock/anthropic.claude-…`), which is what a caller
  who passed a fully qualified model gets recorded as instead. Both are stored,
  because a join has to be able to try both — `resolveModelPrice` in
  `@dash/shared` tries the alias, then the backend, then the deployment after
  the provider prefix, which is LiteLLM's own third pass in
  `_get_proxy_model_info`. A miss is `null` and never a near-match: coverage is
  the number a card leads with, and a fuzzy join would quietly destroy it.
- **`model_info` is the config's own block with LiteLLM's price map merged
  underneath it.** The proxy reads `model_prices_and_context_window.json` and
  fills in only the keys the config did not set, so a hand-priced model answers
  the override and everything else answers the list price.
  `input_cost_per_token`, `output_cost_per_token`,
  `cache_read_input_token_cost`, `cache_creation_input_token_cost`,
  `max_input_tokens`, `max_output_tokens`, `mode`, `litellm_provider`.
- **Prices are per token and absent in two different ways.** A model billed per
  *second* (`input_cost_per_second` — Bedrock provisioned throughput and the
  commitment SKUs) carries no per-token cost at all, and so does one the price
  map cannot resolve. Both are "we cannot price this", which is the opposite of
  an explicit `0`: a model configured at zero is deliberately free, and LiteLLM
  skips budget checks for it entirely. Nothing here is zero-filled, exactly as
  in `gateway_budget`.
- **Several deployments answer to one alias**, and they need not charge the
  same — reserved capacity is bought at a discount, and a fallback deployment in
  another region may not be. The daily aggregates carry no deployment id, so the
  table cannot be split by one: the row is collapsed per alias, reports the
  **cheapest** deployment's price, and sets `price_varies`. That number is a
  floor rather than a rate, and any surface reading it has to say so. A priced
  deployment sitting beside an unpriced one counts as a disagreement too, since
  that is the case where a single rate misleads most.
- **Wildcard rows are dropped.** `*` and `azure/*` are routing rules; they price
  nothing and no usage key can equal them. Admitting them would put priceless
  rows into the denominator coverage is measured against — the same reason
  `/tag/list`'s dynamic tags are dropped.

Prices are stored as nano-dollars per **million** tokens rather than per token:
LiteLLM quotes `2.5e-06`, and at the nine fractional digits the repo's nano scale
accepts, a per-token price rounds a $0.05/M model to three significant figures.

What the catalogue is *not* is a second opinion about the bill. The proxy's own
`spend` is the billed number, and a list rate times a token count is an estimate
that ignores negotiated discounts, provisioned throughput and per-key overrides —
the same rule as the budget counter, one layer up. What it *is* good for is the
one thing no usage payload can answer: the daily row carries a single `spend`
covering input, output and both cache operations together, which is precisely
why `lib/metrics/gatewayCache.ts` reports tokens and refuses dollars. Four rates
per model are what lifts that refusal.

### The health endpoints (which deployment is up)

Everything above is keyed by something a *caller* can name — an alias, a key, a
team, a tag. `/health` is keyed by a **deployment**: the individual Azure
Foundry / Azure OpenAI / Bedrock endpoint the router picked, which is a
resolution the daily aggregates simply do not have.

```
GET /health              → { "healthy_endpoints": [ … ], "unhealthy_endpoints": [ … ],
                             "healthy_count": n, "unhealthy_count": n }
GET /health/readiness    → { "status": "healthy", "db": "connected", … }   (no auth)
```

That gap is the whole argument for reading it. LiteLLM load-balances several
deployments behind one public alias and **fails over silently** between them, so
an alias with three regions and one of them dead answers every request, bills
normally, and shows nothing at all on the reliability card. It is running on a
third less capacity and no other route says so. Which makes the statement worth
storing one about the *alias*:

- **down** — every deployment behind it is failing, so there is nowhere to fail
  over to. This is the only state the usage payload would eventually see, as
  failures, tomorrow.
- **degraded** — some failing, some not. The alias still answers. Invisible in
  spend and in failures alike, and the reason this table exists.
- **up** — nothing failing.

Four things about the envelope, none of them shared with the other four:

- **It is not a table.** Two lists, and *which list an entry is in* is its
  state — there is no status field to read.
- **An entry is that deployment's `litellm_params` with the secrets removed.**
  LiteLLM's `ILLEGAL_DISPLAY_PARAMS` drops `api_key`, `messages`, the Vertex and
  AWS credentials and the raw exception object, so what survives is the routing
  string (`model`), usually `api_base`, usually `model_id`, and — on a failure —
  an `error` string and the `exception_status` copied off the upstream error.
  There is no public alias anywhere in it, which is why the alias is a **join**:
  `resolveDeploymentModel` in `@dash/shared` is `resolveModelPrice` run
  backwards, matching a routing string against the catalogue's `backend` and
  then its `model`, with **no suffix matching** — filing a deployment under an
  alias it does not serve would name the wrong model as degraded.
- **`model_id` is what makes two deployments two rows.** Without it the routing
  string is the id, which collapses a load-balanced pool into one row. That is a
  real loss of resolution, so the id is tried first — but a single row saying
  "azure/gpt-4o is failing" still beats dropping the entry.
- **A proxy may legitimately strip the detail.** `health_check_details: false`
  answers only `{"model": …}` per entry (`MINIMAL_DISPLAY_PARAMS`), which is a
  reasonable hardening choice on a widely exposed gateway: the deployment is
  still named and its state is still known, and only the URL and the error text
  go missing. An absent `api_base` is not a fault — and on Bedrock it is not even
  stripped detail, since those deployments are addressed by region rather than
  by URL.

**`/health` is the one route that does something rather than reading a table.**
Unless the proxy is configured with `background_health_checks: true`, it issues a
one-token test call to *every* deployment while answering. Three consequences,
all of them encoded rather than documented-and-hoped:

- the sync takes it **once per nightly full run** and a backfill takes it not at
  all, exactly as with governance;
- its timeout is three minutes rather than thirty seconds, because a corporate
  gateway with fifty deployments answers slowly and correctly;
- and a failure there is **swallowed** rather than propagated. It is the only
  ride-along whose error does not fail the sync, and the asymmetry is
  deliberate: a budget or catalogue read is two fast table lookups, so a failure
  says something is wrong with the proxy, while a health check is a fan-out of
  live calls that can time out on a gateway which is otherwise perfectly well.
  Failing a sync that has already fetched ninety days because an operational
  garnish was slow is the wrong trade. A skipped read leaves the last reading
  standing with its own `checked_at` on it, rather than blanking the table into
  "no deployments".

`/health/readiness` is the free one — unauthenticated, no upstream calls, and it
answers the question *upstream* of every other route: is the proxy up, and can it
reach its own database. That is why it, and not `/health`, is the eighth route on
the connection check.

### The request log (the only joint key there is)

Every endpoint above answers a *pre-aggregated* table, and all of them share one
structural hole: they report each dimension independently. `models`,
`providers`, `api_keys`, `entities` are four separate maps of the same day, so
"which models did this team spend its money on" is not a slice of the payload —
it is a question the payload cannot express at all. There is no joint key
anywhere in `LiteLLM_DailyUserSpend`.

`LiteLLM_SpendLogs` is where the joint key lives: one row per request, carrying
every dimension at once plus three facts no aggregate has.

```
GET /spend/logs?start_date=&end_date=&summarize=false   → [ { … }, … ]
                                                          (or { "data": [ … ] })
```

The columns, from the published Prisma schema: `request_id`, `call_type`,
`api_key`, `spend`, `prompt_tokens`, `completion_tokens`, `total_tokens`,
`startTime`, `endTime`, `request_duration_ms`, `model`, `model_id`,
`model_group`, `custom_llm_provider`, `api_base`, `user`, `team_id`,
`organization_id`, `end_user`, `request_tags`, `session_id`, `status`,
`mcp_namespaced_tool_name`, `agent_id`, `cache_hit`, `cache_key`, `metadata`,
and the content columns (`messages`, `response`, `proxy_server_request`) this
client deliberately does not carry — prompt content is off by default upstream
(`store_prompts_in_spend_logs`) and is not this dashboard's to hold either way.

The three facts that exist only at this resolution:

- **`model_id` — which deployment served the request.** The same id `/health` is
  keyed by, and therefore the only join between usage and deployment health: a
  degraded alias's *traffic* can be told apart from its healthy sibling's here
  and nowhere else.
- **`request_duration_ms` — latency.** `SpendMetrics` has no latency field at
  all, so this is the only place the gateway can be asked how fast it is.
- **the joint key itself** — team × model, key × provider, tag × deployment.

Six things about the envelope:

- **`summarize` defaults to `true`,** which answers pre-aggregated daily totals:
  the same numbers `/user/daily/activity` already gives, with none of the joint
  keys. Omitting the parameter fetches the wrong thing *successfully*, which is
  the worst failure mode available, so the client always sends `summarize=false`.
- **The documented answer is a bare JSON array** of table rows, while newer
  proxies wrap the same rows in `{"data": […]}`. Both parse; which one a given
  proxy answers with is a version question this draft cannot settle.
- **There is no pagination on the documented route.** The only bounds available
  are the window and a row cap, which is why the API caps the window at
  `SPEND_LOG_MAX_WINDOW_DAYS` (7) and the read at `SPEND_LOG_ROW_CAP` (5,000),
  and why a read that hit the cap reports itself as `truncated`.
- **The rows may not exist at all.** `disable_spend_logs` is an ordinary
  production setting on a busy proxy — the table is the largest thing in
  LiteLLM's database and costs a row per request. A gateway can bill perfectly
  and log nothing, so `available: false` is a *result* rather than a failure,
  and 401/403/404/405/501 all land there.
- **They are pruned on their own schedule.** `maximum_spend_logs_retention_period`
  is configured separately from — and is usually far shorter than — the 90 days
  of daily aggregates the rest of the page reads. The log window and the ledger
  window disagree by design.
- **Per-row tolerance, not envelope tolerance.** Every other gateway schema here
  throws on a shape it did not expect, because a malformed *aggregate* would
  sync silently wrong numbers. A log row with no id or no timestamp is dropped
  and counted instead: one unreadable line is a lost piece of evidence and
  nothing more. A body that is neither an array nor `{data: […]}` still throws.

All of which is why **nothing derived from these rows may be presented as
gateway spend**. A sample of a capped window out of a table that may be
switched off is *evidence*; the daily aggregates are the ledger. Anything that
adds these rows up has to say it is adding up a sample — the same shape as an
`mcp_server` attribution or a closed budget period's `observedTotal`, and the
reason `crossTabSpendLogs` in `@dash/shared` reports `sampleSpend` rather than a
total and carries no share column at all.

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
The same job also pulls the **model catalogue** and replaces `gateway_model`
entire, under the same rule and for the same reason: it is current
configuration, a model withdrawn from the router has no price any more, and a
backfill of six days in May has nothing to say about what the proxy charges
today. `/model/info` is independently optional like the other management routes,
and there is no history table beside it — a price change is rare, and the one
that matters is the one in force when the spend was billed, which the spend
already carries.

And the same job takes a **deployment health** reading and replaces
`gateway_deployment_health` entire, under the same rule for a third time: a
deployment the router no longer offers must lose its row rather than sit on the
page as a permanent outage nobody can clear. It is the one ride-along with a cost
attached — on a proxy without `background_health_checks`, `/health` issues a live
test call to every deployment while answering — which is why a backfill skips it
and why a failure there is logged and swallowed instead of failing the job. The
alias each deployment serves is resolved in the sync rather than in the client,
because the sync is the only place both snapshots exist: joining today's
deployments against a stored catalogue would be joining them to yesterday's price
list.

That same reading is **appended** to `gateway_deployment_health_history`, the
health twin of the budget recording below and written under exactly the same
rules: one row per deployment per **UTC day**, upserted, so a second sync the
same afternoon replaces the day's reading rather than adding one, and a backfill
files nothing because it never calls `/health` at all. A swallowed `/health`
failure files nothing either — the snapshot keeps standing with its own
`checkedAt`, and the history simply has no row for that day, which is the honest
record of a night nobody looked.

It exists because the snapshot can say a pool is refusing *tonight* and can
never say it has been refusing all week, and that second statement is the whole
difference between a fault somebody has to fix and an evening's trouble that has
already cleared. `model` is stored as it resolved that day rather than joined at
read time: a deployment moved to another alias is a change worth seeing, and
re-resolving old observations against today's catalogue would erase it.

It is a **weaker sample than the budget one**, and the derivation over it
(`summarizeDeploymentHistory` in `@dash/shared`) is written knowing that. A
budget counter cannot un-spend itself between two readings; a deployment can
fail and recover between two nights and leave nothing behind at all. So every
figure it produces is counted in **readings** — "failing at 9 of 14 readings" —
and there is no availability percentage, no hours, and no duration anywhere on
it. A run of failing readings is broken by an *observed* recovery and by nothing
else: an unobserved day inside a run is reported as `unobservedDays` rather than
splitting the run in two, because claiming two episodes there asserts a recovery
nobody saw just as firmly as claiming one long outage asserts a failure nobody
saw. `STANDING_OUTAGE_READINGS` (3) is the one threshold it adds — one failing
reading is the snapshot's own finding and says nothing new, two can be a single
evening spanning a night, and three is the first count that cannot be.

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

Finally — again only after a **full** sync — the job **evaluates governance and
sends what it finds** (`services/gateway-notify.ts`). This is the one gateway
finding that can leave the dashboard, and it can only because governance is a
table: every other card derives its findings in the browser from the
usage payload, so they exist only while somebody is looking at the page. Four
states travel — `blocked`, `over`, `soft`, and *pacing* past a cap — and they are
classified by `assessBudget` in `@dash/shared`, the same function the budget card
and the attention digest read, so a notification and the card it names cannot
disagree. `warn`, `ok` and `uncapped` deliberately produce nothing: a threshold
nobody configured is worth a row on a card and is not worth waking somebody, and
an uncapped key is a standing decision rather than an event.

The de-duplication story is `gateway_notification`, keyed on the finding's
**fingerprint** — `kind:scope:key`, carrying no numbers:

- **A finding still true tomorrow is not a new alert.** A counter climbing from
  104% to 137% is the same episode and only moves `last_seen_at`. Crossing from
  `soft` to `over` changes the *kind*, so it is a new episode and is sent.
- **A resolution is recorded, not delivered.** `cleared_at` bounds the episode
  (which is what makes a later reappearance a new one, dated and delivered
  afresh); announcing recoveries is a different product decision, and a channel
  that makes both is one people mute.
- **Undelivered is the retry state.** A refused POST, or no
  `GATEWAY_ALERT_WEBHOOK_URL` at all, leaves `delivered_at` null and the next
  sync tries again — there is no queue, because the sync is already a schedule.
  With no target configured nothing is attempted and no attempt is counted, so
  the column reads as *unconfigured* rather than as a broken endpoint, and
  turning a webhook on tomorrow sends what was found today.

Delivery is one POST per run carrying at most 50 findings (worst first, so a
truncated batch is the batch that matters), with a 10-second timeout, no retry
inside the run, and a body that leads with a plain `text` line — a chat webhook
renders nothing else. Like the seal, it never fails the sync.

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
- **A request log is a sample; the aggregates are the ledger.** `/spend/logs` is
  the only source with a joint key, and the only one that may be switched off
  (`disable_spend_logs`), pruned on a schedule of its own
  (`maximum_spend_logs_retention_period`) and truncated by a row cap. So nothing
  derived from it may be rendered as gateway spend: a total over the sample is a
  floor, the same shape as an `mcp_server` attribution, and a read that hit the
  cap says so. The one completeness figure the view carries is in **requests** —
  sample requests over the ledger's own count for the same days, clamped at 100%
  — because that is the counter both layers hold exactly, and because a reader
  who cannot see how thin the sample is will read the matrix as the window.
  Nothing stores these rows either — the route is live, because a
  copy of the proxy's request log is not a thing this dashboard should be the
  system of record for.
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
- **A catalogue price is a list rate, never the bill.** `gateway_model` says
  what the proxy is configured to charge; `gateway_daily.spend` says what it
  charged. Re-pricing tokens from the catalogue is an estimate that ignores
  negotiated discounts, provisioned throughput and per-key overrides, so it may
  be shown *beside* the billed number and never in place of it — the same rule
  the budget counter carries, one layer up. Every price is nullable and never
  zero-filled, because a model billed per second and a model LiteLLM cannot
  price both have no per-token rate, while an explicit `0` is a deliberately
  free model.
- **A price on a multi-deployment alias is a floor.** Several deployments can
  answer to one public model name at different rates, and the daily aggregates
  carry no deployment id to split them by. The stored row reports the cheapest
  and sets `price_varies`; anything reading it has to word it as a lower bound,
  exactly as the MCP-attributed split does.
- **`prompt_tokens` is the whole input, and both cache counters are inside it.**
  `CACHE_TOKENS_INSIDE_PROMPT_TOKENS` in `@dash/shared` is the single statement
  of that, with `inputTokens`, `uncachedInputTokens` and `cacheReadShare` as the
  only three ways to read it. Nothing may add a cache counter to `promptTokens`
  to build an input total (it double-counts the cache and understates every hit
  rate), and nothing may price `promptTokens` at the full input rate without
  taking both counters back out (it charges full price for cached tokens — the
  same shape as LiteLLM's own BerriAI/litellm#9812). It holds for both families
  the gateway fronts: OpenAI-shaped backends report cache hits inside
  `prompt_tokens` and have no cache write at all, and LiteLLM's Anthropic usage
  transform sets `prompt_tokens = input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens`. Subtracting *both* is therefore safe rather than
  a compromise — a write counter is only non-zero on the family that puts it
  inside. The rule is falsifiable and checked rather than assumed:
  `detectCacheTokenConvention` reads the payload for rows whose cache counters
  do not fit inside their prompt count, and the cache card leads with that
  verdict instead of rendering rates measured against the wrong denominator.
- **A budget's `spend` is the proxy's counter, never our sum.** It covers the
  period in flight, which resets on the key's own schedule — possibly mid-day,
  possibly on a duration nothing else in the dashboard uses. Re-deriving it from
  `gateway_daily` would silently disagree with the number the proxy actually
  enforces, and the enforced one is what an owner needs. `blocked` is likewise
  carried, not inferred: an admin can disable a key nowhere near its cap.
- **Whether that counter resets is a property of the scope, and on one scope it
  does not.** LiteLLM's `ResetBudgetJob` walks keys and teams; it has no tag
  handler (BerriAI/litellm#27481), so a tag's linked `budget_reset_at` advances
  every cycle while `LiteLLM_TagTable.spend` keeps climbing. A tag's counter is
  therefore spend **since the tag was created**, whatever its `budget_duration`
  says. `budgetCounterResets(scope)` in `@dash/shared` is the single statement of
  that rule, and it cuts both ways: nothing may divide the counter by a fraction
  of a period (a pace projection over a lifetime counter is wrong, not slow, so
  it is withheld rather than caveated), while utilisation is *more* load-bearing
  here than elsewhere — it is the exact comparison the proxy enforces, and a tag
  past its cap stays refused rather than recovering when the month turns.
- **`/tag/list`'s governed rows are a strict subset of the `tag` usage
  dimension.** A tag exists on the usage side the moment one call carries it;
  it exists on the governance side only if somebody created it. The two
  populations are deliberately different sizes, which is why "governed tags" is
  a coverage number worth reporting rather than always 100%.
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
- **An alert is one per episode, and an episode is bounded by the finding
  going away.** `gateway_notification`'s key is `kind:scope:key` and carries no
  numbers: a counter climbing further is the same finding, escalating into a
  worse state is a new one, and a resolved one closes so that a reappearance is
  a fresh episode. `delivered_at` is the retry flag — null means it has not been
  accepted by a target, whether the POST failed or none is configured — and no
  attempt is counted when there is nowhere to send it.
- **A notified state is never re-derived.** Every state a notification carries
  comes from `assessBudget` in `@dash/shared`, the one the budget card and the
  attention digest read. A second implementation on the server would let the
  alert somebody received disagree with the card they open to check it, which is
  strictly worse than the digest's two-answers failure because one of the
  answers is already out of the building.
- **Deployment health is keyed below the alias, and the alias reading is the
  only one worth making.** `gateway_deployment_health` is one row per
  deployment — the resolution `gateway_daily` does not have. LiteLLM fails over
  silently between the deployments of one alias, so an alias is **down** only
  when *every* deployment behind it is failing, and **degraded** when some are:
  a degraded alias bills normally, fails nothing, and is invisible on every other
  card. `model` on that table is a *resolved* column, never a fetched one, and a
  deployment the catalogue could not name is stored as null rather than filed
  under a near-match — naming the wrong model as degraded is worse than naming
  none.

- **A health observation is a sample, and a thinner one than a budget
  observation.** `gateway_deployment_health_history` holds one reading per
  deployment per day the sync called `/health`. A deployment that failed and
  recovered between two nightly readings left nothing behind, so everything
  derived from it is counted in **readings** and nothing may be reported as a
  duration, an availability percentage or an hour count. A run of failing
  readings is broken by an observed recovery and by nothing else: an unobserved
  day inside a run is counted and reported, never used to split it, because both
  splitting it and filling it in assert something nobody saw.

- **Nothing outside `apps/api/src/gateway/` knows which source is active** —
  the same rule `copilot/` follows.

## Configuration

```bash
GATEWAY_SOURCE=off             # off (default) | mock | litellm
LITELLM_BASE_URL=              # https://llm-gateway.corp.example
LITELLM_API_KEY=               # admin / admin-viewer virtual key
GATEWAY_ALERT_WEBHOOK_URL=     # optional: where governance findings are POSTed
GATEWAY_ALERT_WEBHOOK_TOKEN=   # optional: bearer token for that endpoint
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
| `GET` | `/api/gateway/budgets` | `{ budgets }` — current caps, rate limits and the enforced counter per key, team and configured tag, grouped in `GATEWAY_BUDGET_SCOPES` order and each scope ranked by share of cap consumed with the uncapped rows last. No parameters: it is state, not a range. |
| `GET` | `/api/gateway/budgets/history?days=` | What those same budgets read on each of the last `days` days (default 60, max 365) — the dashboard's own recording, since the proxy serves current state only. Nothing is filled in for a day no sync ran. `recordingSince` is answered *outside* the window, because "never over its cap" and "we started watching yesterday" are otherwise the same answer. |
| `GET` | `/api/gateway/models` | `{ models }` — the proxy's configured price list as of the last full sync: per-model input/output/cache rates in dollars per million tokens, context window, modality and provider. Cheapest input first, with the unpriced models last. No parameters: state, not a range, and deliberately not folded into `/api/gateway`, which is a date range. |
| `GET` | `/api/gateway/health` | `{ deployments, checkedAt }` — every deployment as the last full sync found it, failing ones first: routing string, resolved alias (null when the catalogue could not name it), provider, endpoint, state, the proxy's own error text and the upstream status. A *stored* reading rather than a live one, deliberately: forwarding `/health` would let a browser refresh bill a test call per deployment. `checkedAt` is null when it has never answered, which is not the same as a proxy that routes nothing. |
| `GET` | `/api/gateway/health/history?days=` | `{ from, to, recordingSince, observations }` — what `/health` reported on each of the last `days` days (default 60, max 365), one row per deployment per day the sync asked. The health twin of the budget history and read under the same rule: a day with no row is a day nobody looked, and `summarizeDeploymentHistory` counts readings rather than hours because a deployment can fail and recover between two of them. |
| `GET` | `/api/gateway/coverage` | Which days `gateway_daily` actually holds: first and last stored day, how many are stored, which are missing and in what runs, how many predate the proxy's retention window, and the `floor` every picker on the page clamps to. No parameters — it is the answer to *what may I ask for*. |
| `GET` | `/api/gateway/months` | `{ seals }` — every calendar month that has been sealed, newest first, with the totals as recorded. Headers only; no parameters. |
| `GET` | `/api/gateway/months/:month` | One sealed month with its per-payer lines — the statement as issued. `?revision=` quotes a *replaced* statement by number; omitted, it answers with the current one. `404` when the month was never sealed (or has no such revision), carrying the `check` that says why (still running, or missing days to backfill). |
| `GET` | `/api/gateway/months/:month/revisions` | Every statement the month has carried, newest first, with a pure diff for each re-seal: what the month moved by, and which payer lines moved with it. `404` for a month that was never sealed. |
| `POST` | `/api/gateway/months/:month/seal` | Seal a closed month by hand. `400` for a month still in flight or with holes in it, `409` for one already sealed — `?force=true` re-seals and replaces the statement that was issued. |
| `GET` | `/api/gateway/notifications?days=` | `{ notifications, deliveryConfigured, open, pending, evaluatedAt }` — governance findings and whether they left the building. Every open episode plus the ones that closed inside `days` (default 30, max 365). The only gateway read about the dashboard's own behaviour rather than the proxy's. |
| `GET` | `/api/gateway/logs?from=&to=&limit=` | `{ from, to, rows, available, truncated, fetchedAt }` — a sample of individual requests, fetched **live** from `/spend/logs` and stored nowhere. The joint-keyed evidence layer: every dimension on one row, plus the deployment that served it and how long it took. Window capped at 7 days, rows at 5,000 (`limit` may lower it, never raise it); `400` for a wider window or an inverted one, `503` while the source is `off`. `available: false` means the proxy keeps no logs, which is a supported way to run one — not an error, and not "no requests". |
| `GET` | `/api/gateway/probe` | A live connection check — see below. Reads no table, writes nothing, and always answers `200`: a dead proxy is a result, not an error. |
| `GET` | `/api/gateway/status` | `{ source, configured }`. |
| `POST` | `/api/refresh/gateway` | `202` with the job to poll; `503` while the source is `off`. |
| `POST` | `/api/refresh/gateway?from=&to=` | The same job narrowed to a backfill of those days — how a coverage gap is repaired. Bounds are optional and clamped to the sync's own window; `400` for an inverted range or one the proxy has pruned entirely. |

## The connection check

`GET /api/gateway/probe`, behind **Test connection** on the `Data sources`
page (`apps/web/src/components/sources/GatewayProbePanel.tsx`). It calls every
route the sync depends on — the three activity routes for a single day, then
`/key/list`, `/team/list`, `/tag/list`, `/model/info` and `/health/readiness` —
and reports what each one answered. `/model/info` judges itself on *priced* rows rather than returned
ones, for the same reason `/tag/list` judges itself on governed ones: a proxy can
answer every deployment it routes to and know the price of none of them, and a
catalogue of those prices nothing.
`/health/readiness` is the one route on the panel the sync does **not** call, and
the one route the sync calls that the panel does not. The sync reads `/health`,
which issues a live test call to every deployment; probing that would bill the
corporation a token per model per press, and a probe has to be free to press or
nobody presses it. Readiness is the honest substitute — unauthenticated, no
upstream calls, and it answers the question *upstream* of every other row: a
proxy that cannot reach its own database explains the whole panel at once. It
also has no rows to be empty of, so it reports `ok` or the status that says why
not, and a `503` there classifies as `unreachable` rather than `denied` precisely
because no credential was involved.

`/tag/list` is the one route where `empty` is counted on the *governed* rows
rather than on the response: a proxy that answers forty dynamic tags and no
configured one has nothing to put on the budget card, which is the same
consequence as an empty array and a different one from a refusal.

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

## Governance alerts on the Data sources page

`GatewayAlertPanel`, under the connection check
(`apps/web/src/components/sources/GatewayAlertPanel.tsx`), reading
`GET /api/gateway/notifications`. It is the only gateway surface that is not on
the gateway page, and deliberately so: it does not describe the proxy, it
describes **this dashboard's own alerting** — what governance findings are open,
which are still waiting to be sent, and when the last evaluation ran.

The one thing it exists to make impossible is a silent channel. An unconfigured
target is stated in the header rather than implied by an empty list; a finding
recorded but never delivered says so on its own row, carrying the target's own
error verbatim, because "the webhook 404s" and "nothing is wrong" look identical
in a quiet channel. `evaluatedAt` comes from the last successful sync rather than
from the rows, so "nothing is open" and "this has never run" stay different
answers — the same rule as `recordingSince` on budget history and coverage's
`floor`.

Closed episodes are listed beside open ones, which is the other reason the panel
is a list and not two counters: an episode that opened and cleared between two
visits is invisible in the budget card, whose snapshot has already moved on, and
it is exactly what "did anything happen last week" means.

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
| Deployment health | Which of the deployments behind each public alias are answering, from the reading the last full sync took: the aliases worst-first with their deployments and the proxy's own error text under them, the provider rollup beside it, and the reading's **age** on the card — a nightly snapshot, never a live call |
| Agent traffic | MCP-attributed spend against everything else — the split, its unit economics ($/call and tokens/call vs the remainder), the daily share strip, half-over-half adoption, and the MCP servers ranked by share **of agent spend** |
| Budgets and limits | Every governed key or team (a switcher, one scope at a time): its state, the proxy's own counter against its cap with the owner's soft budget marked on the bar, what remains, where the current pace lands by the period's end, and its TPM/RPM ceilings |
| Budget history (per row) | Opening a budget row shows what that key or team read on previous days: a strip of the recorded share of cap with a **hole** on every day nobody synced, the changes we caught (period resets, cap and soft-budget moves, rate-limit changes, renames, blocks, and the day it crossed its cap), and the periods that closed inside the record — each labelled *at least*, because the counter is read once a day |
| People on the gateway | How many users the proxy attributed calls to and what share of spend carries a user id at all, distinct actives per day, spend and calls per user, how many of the population call on an average day, users first seen in the second half of the window, and the concentration read — how few users are half the attributed bill, and 80% of it |
| Chargeback statement | One calendar month's spend, split across the units that will be billed for it (team / tag / API key / user, one at a time) — each line with its share of the month, its tokens, its blended $/1M and the same line in the month before, plus an explicit **unallocated** line and a CSV export |
| Prompt cache | Input tokens the backends served from cache against the ones we paid to send again — the split, the daily hit rate, reads per token written against the break-even, the share of the input bill the cache is keeping off it, the headroom, and the current dimension's keys ranked by uncached input with the two fault states badged |
| Priced cache (panel on the cache card) | The same cache activity in **dollars**, from the catalogue's four rates and pinned to `model` whatever the switcher says: what the reads kept off the bill, what the writes cost, the net against what those input tokens would have cost with no cache at all, the headroom valued at each model's own read discount, and the models with cache activity the catalogue could not price. Renders only when something priced |
| Price catalogue | The rates the proxy is configured with, beside the bill they produced: what share of gateway spend sits on models the catalogue can price, each model's list input/output $/1M against its **effective** blended rate, the same tokens re-priced at list, and the ratio between the two — with a single-deployment model more than 5% away from list flagged, a multi-deployment alias labelled a **floor** and left out of the aggregate, and the models the proxy offers that saw no traffic counted |
| Seal badge on the statement | Whether the month on screen is *final* — recorded at close and quotable — and, when the daily rows have moved since, by how much. Nothing renders for a month still in flight |
| Revision history on the statement | For a month that has been billed more than once: every statement it has carried with its own total and what it moved by, and — for the payer dimension on screen — which lines moved into the current revision, with dollars the proxy attributed to nobody in one revision or the other named rather than spread. Fetched only for a month that has one, so the ordinary month costs no extra request |
| Monthly ledger | Every month that has been **sealed**, newest first: what it cost, what it moved by against the calendar month before it, its tokens, calls and blended $/1M, and the compounded direction across the longest unbroken run — with a strip that draws a closed-but-unsealed month as a marked hole rather than a short bar, and an `archive` mark on the months whose days LiteLLM has since pruned. The only card on the page not bounded by the range picker, because it reads the record rather than the days |
| Request sample | The one card that reads *individual requests*, live and on a button press: a **row dimension × column dimension** matrix — the joint key the daily aggregates cannot express — plus the sample's latency percentiles, and which deployment served each alias's traffic. Everything on it is framed as a sample: a completeness figure in **requests** against the ledger's own count, a truncation flag, and no share of gateway spend anywhere |
| Coverage note | Days inside the stored span that carry no row at all (and the runs they form), and how much history predates the proxy's retention window. Each run still inside the window carries a **Fill** button that backfills exactly it; a run the proxy has pruned reads *pruned upstream* and offers nothing. Renders nothing when there is nothing to say, which is the normal state |

Twenty-five decisions worth keeping:

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

- **Tags are the third governance scope, and the only one whose counter the
  proxy does not reset.** `/tag/list` gives the budget card a `Tag` switcher
  beside `API key` and `Team`, on the same never-combine rule: a key's cap, its
  team's cap and its tag's cap govern the *same* dollars, so they are three
  readings and never a sum. What is new is that the number being read means
  something different. LiteLLM's `ResetBudgetJob` walks keys and teams and has no
  tag handler (BerriAI/litellm#27481), so a tag's linked `budget_reset_at` rolls
  every cycle while `LiteLLM_TagTable.spend` keeps climbing: the counter is spend
  **since the tag was created**, however clearly its `budget_duration` says
  otherwise. `budgetCounterResets(scope)` in `@dash/shared` is the one statement
  of that, and it decides two things in opposite directions. The **pace is
  withheld entirely** — `spend ÷ elapsed` over a lifetime counter is a wrong
  forecast rather than a slow one, and a caveat next to a big number does not
  undo the number. **Utilisation stays, and matters more here than anywhere
  else** — it is the exact comparison the proxy enforces, so a tag past its cap
  really is being refused, and (until the upstream job learns to reset it) stays
  refused rather than recovering next period. That is a finding, and the card
  says it in the footer rather than badging it per row, because it is true of
  every row in the scope. The mock reproduces the whole shape: four configured
  tags against six workload tags, so the governed set is a strict subset of the
  usage dimension, and `batch` reads 425.8% of a $2,500 monthly cap because
  three months of counter are being measured against one month of allowance.
  Two smaller consequences fell out of the third scope existing at all: the read
  route's scope ordering had to come from `GATEWAY_BUDGET_SCOPES` (a two-way
  `a.scope === 'api_key' ? -1 : 1` is not a consistent comparator once there are
  three), and a tag carries no alias — its name is its primary key and the same
  string the `tag` usage dimension is keyed by — so `label` is null by design
  rather than unresolved.

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
  history, anomalies, reliability, cache, coverage, deployment health — and puts
  their findings in one list, because seventeen cards each flagging their own faults means every
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

- **The catalogue card shows an estimate beside the bill, and leads with
  coverage.** `lib/metrics/gatewayCatalog.ts` is the page's only surface where
  two independent facts meet: the rates `/model/info` says the proxy is
  configured with, and the spend `gateway_daily` says it recorded. Everything
  else on the page reads the second one and slices it. What makes the pair worth
  rendering is that on a model with one deployment and no discount they agree to
  the cent, so a row that does not agree is a finding — an override nobody wrote
  down, a deployment pointed at something other than what the config names, or
  an enterprise rate the catalogue never sees. It is measured on a *blended*
  rate over the row's own token mix (uncached input, cache read, cache write,
  output priced separately, then divided by the same token count both ways), so
  the mix cancels and a model that simply generates more output than it reads
  does not read as mis-priced.

  Three labels are load-bearing rather than decorative. The estimate never
  replaces the bill: a list rate knows nothing about a negotiated discount, a
  per-key override or a committed-throughput SKU, and every other card on the
  page keeps reading `spend`. A `price_varies` row is a **floor** — several
  deployments answer to one alias at different prices and the daily aggregate
  carries no deployment id to split them by — so it is never flagged as a
  disagreement and never enters the aggregate ratio, because folding a PTU pool
  in would report a gateway-wide discount that does not exist (the mock's
  discounted alias bills 1.40× its own quoted floor, which is the discount, not
  an error). And a model the catalogue cannot price is **absent from coverage**
  rather than priced at zero, which is why coverage — priced spend over
  gateway-wide spend, measured against the whole bill and not against the model
  dimension — is the number the card leads with, exactly as the adoption card
  leads with attribution coverage.

  The 5% drift tolerance is the same kind of gate as the reliability card's
  materiality ratio: above the noise floor of nano-dollar integers split across
  four rates, and well below any discount worth naming (an enterprise agreement
  is 15–40%, a mis-configured deployment is usually a factor). The card is
  pinned to the `model` dimension rather than following the switcher, for the
  same reason the agent and adoption cards are pinned to theirs — a catalogue
  prices models, and "what does a team cost per million tokens" is a question
  about a workload's mix, not about a rate.

- **The cache is priced by model, or not at all.** `lib/metrics/gatewayCache.ts`
  refuses to report dollars because the daily row carries one `spend` covering
  input, output and both cache operations together — and four rates per model is
  exactly what lifts that refusal. `lib/metrics/gatewayCacheValue.ts` is the
  panel that does it, and the dimension is the whole design: a rate belongs to a
  model, and one `team`'s cached tokens span every model it touched at rates
  differing by a factor, so a per-team saving would be an average of price
  lists. It is pinned to `model` whatever the switcher above it says, and the
  panel says so rather than leaving a reader to assume the two tables share a
  key.

  The number is a **counterfactual**, not a re-pricing: what those input tokens
  would have cost with no cache at all, minus what the catalogue says they cost
  with one. Reads are valued at the spread between the input rate and the read
  rate, writes at the premium over a plain input token, and output tokens cancel
  and are left out entirely — the cache cannot touch them, and folding them in
  would bury the figure the panel exists to state. That subtraction is checkable
  against the cache card above it: a workload sitting exactly on
  `CACHE_BREAKEVEN_REUSE` must price to $0.00 at the 0.1×/1.25× rates the
  constant is derived from, which is what keeps the convention-weighted card and
  the priced panel from telling a reader two different things.

  Three rules carry over from the catalogue card, and one is new. A missing
  cache rate is **unknown, never zero**: `repriceMetrics` falls back to the
  input rate when a backend prices no cache separately, which is right when
  reconstructing a *total* and catastrophic when measuring a *difference* — the
  same fallback here would report a saving of exactly $0.00 out of a null, so
  those models are excluded and named instead. A `price_varies` alias is a
  floor, so its rate spread is a lower bound too, and it is reported apart from
  the headline rather than mixed into it. Nothing here is subtracted from
  `spend`, and no other card reads these numbers. The new one is the levelling
  rate for headroom: it comes from `cacheReadShare` in `@dash/shared` — the same
  helper the cache card and the KPI read — because a module that prices on one
  convention and levels on another reports no headroom anywhere. It did not,
  until the convention became one statement; see the entry below.

- **The cache-token convention is one statement, and it is checked rather than
  assumed.** `prompt_tokens` is the whole input and both cache counters are
  subsets of it, stated once as `CACHE_TOKENS_INSIDE_PROMPT_TOKENS` in
  `@dash/shared` and read through exactly three helpers (`inputTokens`,
  `uncachedInputTokens`, `cacheReadShare`). It is one statement because it is a
  *denominator*: a hit rate, a re-priced bill and a saving all move by the size
  of the cache, so two modules answering differently disagree about every number
  they show. Two did, for five iterations — `gatewayCache.ts` and the shared
  `cacheHitRate` read the input total as `promptTokens + cacheReadTokens` while
  the catalogue, the priced panel and the mock's own billing read the cache as
  already inside it, which is 22.1% against 28.3% on the same payload. Nothing
  surfaced it because each module was internally consistent; it only became
  visible when one borrowed a *rate* from another.

  Subtracting **both** counters is what makes the rule provider-agnostic rather
  than a compromise. OpenAI-shaped backends report cache hits inside
  `prompt_tokens` and have no cache write at all, so the second subtraction is a
  no-op there; LiteLLM's Anthropic transform sets `prompt_tokens = input_tokens
  + cache_read_input_tokens + cache_creation_input_tokens`, so both belong
  inside on Bedrock. A write counter is only ever non-zero on the family that
  puts it inside.

  And it is falsifiable, which is the part that matters for a proxy nobody here
  has driven: `detectCacheTokenConvention` reads the payload for rows whose
  cache counters do not fit inside their prompt count, keeps `reads_outside`
  apart from `writes_outside` (a mixed-family proxy shows only the second),
  answers `unobserved` for a window with no cache activity rather than reading
  silence as agreement, and the cache card leads with that verdict instead of
  drawing rates whose denominators are wrong. That is deliberately not a
  footnote — a violation does not make the numbers approximate, it makes them
  measured against the wrong total.

- **The health card leads with the reading's age, and its findings are the
  two states the alias list can be in.** `gateway_deployment_health` is a
  *snapshot* of something that changes in minutes, taken once a night, because
  `/health` issues a live test call to every deployment while answering it — so
  the card renders the stored reading and says how old it is, rather than
  fetching on open and costing a token per deployment per visit.
  `lib/metrics/gatewayHealth.ts` adds no rule about the gateway at all
  (`summarizeDeploymentHealth` in `@dash/shared` is the single up/degraded/down
  statement, shared with the API's own checks); everything it derives is about
  the *reading*: how old it is, whether one has ever been taken, and whether it
  is older than a working nightly sync would leave it.

  Those three are deliberately not the same answer. A reading older than
  `HEALTH_STALE_HOURS` (36 — one missed run plus the slack a retry needs) still
  reports every finding it holds, because the data is old rather than absent;
  what it adds is a **blind spot** on the digest, since a deployment that failed
  since is not on the list and a late scheduler says nothing about the gateway.
  A reading that has never been taken produces no finding and no card at all —
  a backfill skips `/health` and a failed read is swallowed rather than failing
  the sync, so an empty alias table and a gateway with nothing failing look
  identical and must not read the same.

  On the digest the two states are two findings, not one severity scale.
  **Down** is `critical` — every deployment behind the alias is failing, so
  calls are being rejected now, and the usage payload will show it as failures
  tomorrow; the card is merely the earlier answer. **Degraded** is `warning` and
  is the finding nothing else on the page can make: the alias still answers on
  the deployments that are left, so it bills normally, fails nothing, and is
  invisible on every spend-shaped and failure-shaped card. The unnamed bucket is
  eligible for both — a deployment the catalogue could not name is still a
  deployment that can fail, and filing it under a near-match is the one thing
  this table refuses to do.

- **The ledger reads the record, and an unsealed month is a hole rather than a
  cheap one.** Every other card here is bounded twice over — by the range picker
  and, behind it, by LiteLLM pruning its aggregates at 90 days — which makes
  "what did the gateway cost in March" unanswerable from the usage payload the
  moment March falls out of the window. `gateway_month` is the answer and it is
  the reason the seal exists, so `lib/metrics/gatewayHistory.ts` reads the seal
  headers as a series and nothing else. It deliberately does **not** re-add
  `gateway_daily` to check itself: for the older months there is nothing left to
  add, and for the newer ones that comparison already exists as `sealDrift` on
  the statement card, so doing it again here would give a reader two histories
  and no way to choose which one he is quoting.

  A month with no current statement is the one thing this card could lie about,
  and it would lie twice if allowed to. In the strip a zero-height bar is how a
  free month draws, so an unsealed month gets a marked slot instead; and a
  month-over-month change measured *across* the hole would turn a missing August
  into a doubled September, so the comparison is against the previous **calendar**
  month or nothing at all. The spine runs to the last *closed* month rather than
  to the newest seal for the same reason: a month that ended and never got
  sealed is the most interesting row in the table, and stopping at the last seal
  is exactly what would hide it.

  Two things follow from the input rather than from taste. **Months are the one
  axis on this page that may be summed** — the breakdown dimensions overlap and
  budget counters run on their own periods, but calendar months are disjoint
  spans of one gateway-wide total — so the card carries a real multi-month total,
  over the sealed months only and with the unsealed ones counted beside it. And
  **only the current statement counts**: `GET /api/gateway/months` already filters
  superseded revisions, but the payload type carries `supersededAt`, so the
  filter is repeated in the module and a month whose only row is superseded
  reads as a hole. A month whose current statement is a revision is marked
  (`rev 2`), because "we billed $X and then corrected it" is a fact about the
  ledger worth seeing without opening the chain. The trend compounds across the
  longest *unbroken* run ending at the newest sealed month, since a mean of
  month-over-month percentages is dominated by whichever month was smallest and
  a run that jumped a hole is not a run.

- **The request sample is read on a press, framed as a sample, and cut in the
  view.** It is the page's only *live* read and its only joint-keyed one, and
  all three of those follow from what the layer is rather than from taste.

  **A button, not a mount.** `/spend/logs` reads the largest table LiteLLM has;
  a card that fetched on open would run that query against the corporate proxy
  every time somebody navigated here. The same argument the health card makes
  for having no refresh button, in the other direction: there, pressing costs
  money, so the reading is nightly and stored; here, mounting costs the proxy,
  so the read is manual and stored nowhere.

  **The window is the tail of the trimmed spine, not the range picker's.**
  Anchoring on the picker would ask for today, which no other card on the page
  is showing — the same reason the comparison window is measured off the spine.
  At most seven days, the route's own cap.

  **The completeness figure is in requests.** How thin the sample is matters —
  a matrix over 0.7% of a window reads very differently from one over 80% — but
  a share of gateway *spend* taken from a capped sample is precisely what the
  invariant forbids. Requests are the one counter both layers hold exactly, so
  the note is `sample ÷ ledger requests`, clamped at 100% because the two are
  pruned on different schedules and may legitimately disagree.

  **The axes are capped here rather than in `crossTabSpendLogs`.** The shared
  function is deliberately not allowed to truncate — dropping keys would leave
  its axis totals disagreeing with the cells that survived — so the view cuts to
  8 × 6 and *reports* what it cut. The heat scale is taken over the drawn cells
  only, and is a scale rather than a share: a matrix whose brightest cell sits
  outside the grid would render every visible one dim, which reads as "nothing
  here" instead of "cropped".

  **The deployment table is the point, not a detail.** `model_id` is the only
  join between usage and `gateway_deployment_health`, so this is the one place
  a *degraded* alias — some deployments failing, the alias still answering,
  invisible on every other card — becomes a number of requests and dollars. A
  deployment under a 20-request floor shows no failure rate at all, for the same
  reason the reliability badge needs a materiality gate: one call gives 0% or
  100% and neither is a finding.

  **Three silences that all draw an empty table are kept apart**: not read yet,
  refused (`disable_spend_logs`, a supported way to run a busy gateway rather
  than a fault), and answered-with-nothing (which on this layer may simply mean
  the log table's own retention has already pruned those days).

  **It feeds no finding to the attention digest, and that follows from the
  button.** Every other source the digest reads has answered by the time the
  page has rendered; this one is unread until somebody asks, so a card that
  contributed to the digest would either report a blind spot on every visit or
  quietly make the digest depend on whether a button had been pressed. The
  findings it *would* raise — a pool refusing behind a healthy-looking alias —
  the health card already raises from the nightly reading, which is the reading
  that is always there.

`apps/api/scripts/verify-gateway-history.ts` covers it, and the split is the
same one the seal-history and budget-history scripts needed: a dev database has
no multi-month history, and the feature is entirely about months it does not
have. The pure half constructs them — a consecutive run whose deltas, mean,
total and compounded trend are checked arithmetically; a hole that must appear
as itself, carry nulls, sit outside every total, cut the trend and kill the
comparison of the month after it; a spine that ends at the last closed month and
excludes the one in flight; a superseded statement that must not be read (and a
month whose only statement is superseded reading as a hole); the retention flag
on both sides of its boundary; and the arithmetic that must *not* be invented —
no unit rate for a month that moved no tokens, no growth percentage out of a $0
month while the dollar change is still one, no trend compounded out of zero. The
Postgres half plants two months and a superseded revision shaped like the ones
earlier syncs would have written, reads them back through the same
`listGatewaySeals()` the route calls, checks the corrected statement is the one
that comes back and that nano-dollars survive as dollars, and deletes exactly
what it planted — refusing to run at all if a real seal already occupies those
months. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-history.ts`.

`apps/api/scripts/verify-gateway-catalog-view.ts` covers that derivation, and
splits into the three things the mock can and cannot show. It **can** show the
join and the arithmetic: coverage measured against the gateway total, the one
planted unpriceable model pulling it below 100% while its spend stays inside the
model dimension, every firm-rate model re-pricing to its bill in aggregate *and*
individually, and the floor row classified as a floor, kept out of `drifting`,
and kept out of both sides of the aggregate ratio. It **cannot** show drift — a
generator that bills what it quotes can never disagree with itself — so the four
classification states are checked over constructed rows instead (at list, 4%
above, 20% above, 30% below), the same plant-and-assert shape the seal-history
and budget-history scripts use. And the re-pricing itself is checked one token
kind at a time, because that is the only way to prove the four rates land on the
four counters: a fully cached prompt must price at the cache-read rate rather
than at input (LiteLLM counts cache reads *inside* `prompt_tokens`, so the
obvious version of this charges full price for every cached token), a missing
output rate must yield no estimate rather than half of one, and a backend with
no separate cache rates must fall back to input rather than to free. The
Postgres half runs the same derivation over what a sync stored, which is what
proves a null price is still null in the shape the card reads — a `$0.00/M`
coming back would render as a 100% discount. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-catalog-view.ts`.

`apps/api/scripts/verify-gateway-health-view.ts` covers what the page does with
that reading, which is the half `verify-litellm-contract.ts` (the wire and the
pure rule) and `verify-gateway-health.ts` (the alias join, the blast radius, and
the proof that a degraded alias is invisible elsewhere) leave open. Its centre is
the staleness boundary, checked on both sides — a reading exactly
`HEALTH_STALE_HOURS` old is not stale and a minute older is, a reading dated
*ahead* of the browser clamps to zero age rather than rendering as "in 3h", and
staleness changes nothing about what the reading says. Then the two kinds of
silence, which produce the same empty list and mean opposite things: an
unanswered query and a never-taken reading each yield no finding and their own
named blind spot, while a stale reading yields the same findings as a fresh one
*plus* a blind spot. The digest half is two-directional like
`verify-gateway-alerts.ts` — every finding traces to an alias the summary holds
in that state, every alias in that state produces exactly one finding, an `up`
alias produces none, and a failing unnamed deployment is still reported under its
own bucket. The Postgres half re-derives over what a sync stored, which is what
proves a null alias survives as a null rather than collapsing into a string. Run
it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-health-view.ts`.

`apps/api/scripts/verify-gateway-cache-value.ts` covers the priced panel, and
its centre is the identity: over constructed rows where both bills are known,
the saving must equal the no-cache bill minus the billed one to the cent, cache
reads must come back out of `promptTokens` before anything is priced at the
input rate, and output tokens must change nothing. Then the rules that only
break silently — a model with cache activity and no read rate is a named gap and
not a $0.00 saving, a model that read but never wrote is priced *without* a
write rate (the requirement is per counter, not per catalogue entry), a workload
on the cache card's break-even prices to zero, and one writing far more than it
reads prices negative and lands in `costing`. Headroom carries two bounds that
exist because of how this script's first run failed: it can never exceed the
input bill it would come out of, and no model can move more tokens into cache
than it sent uncached — the check that catches a levelling rate handed over on
the wrong scale or the wrong convention, which every other assertion passed
straight through. Over the mock it then proves the floor row stays out of the
headline and out of coverage, and that each firm-rate model's priced input bill
reconciles with the spend the payload actually carries once its output is taken
off. The Postgres half re-runs it over what a sync stored, which is what proves
a null cache rate is still null rather than a free cache operation. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-cache-value.ts`.

`apps/api/scripts/verify-gateway-cache-convention.ts` is the one script whose
checks are all *between* modules, because the bug it guards against cannot be
seen from inside one. For five iterations `gatewayCache.ts` and the shared
`cacheHitRate` read the input total as `promptTokens + cacheReadTokens` while
`gatewayCatalog.ts`, `gatewayCacheValue.ts` and the mock's own billing read the
cache as already inside `promptTokens` — every module internally consistent,
every verify script green, and the two answers differing by the size of the
cache itself (22.1% against 28.3%). So it checks the split reconstitutes
`promptTokens` exactly on every row of every dimension the mock emits, that the
KPI's rate and the cache card's headline are one number over one input total,
and — the check that would have failed before the convention existed — that the
token card and the priced panel level a model to *identical* headroom in tokens,
which they can only do if they agree about what an input token is. The detector
half proves the rule is falsifiable rather than assumed: reads exceeding the
prompt count is decisive about reads, reads that fit beside a pair that does not
is a statement about writes only, a window with no cache activity is
`unobserved` rather than agreement, and the sample is capped at five while the
count stays whole. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-cache-convention.ts`.

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
uncapped last ranked by dollars), the scope separation (key, team and tag ids
never collide, so the three scopes can never merge), and the pace projection in
both regimes — a month one day in projects nothing, half a month at $600 against
a $1,000 cap projects $1,200 and is flagged as pacing over, and every projection
that does answer is exactly `spend ÷ elapsed`.

The tag scope gets its own section, and the check that carries it is the
**withheld** one: every mock tag is 59–97% through its period, well past the
elapsed gate that makes every key project, so a projection of `null` there can
only be the cumulative-counter rule doing its job rather than the minimum-elapsed
guard doing it by accident. Beside it, the period start and elapsed fraction must
*survive* (the cap's own window is a real fact — only the pace built on it is
withheld), utilisation must still agree with the shared helper, the governed tags
must be a strict subset of the tags the usage side reports, and a constructed
pair of rows identical in every field but `scope` must differ in exactly two
ways: the tag twin projects nothing while the key twin projects $1,200, and both
land in the same state, since withholding a projection may not change what a row
is classified as. Run it with
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

`apps/api/scripts/verify-gateway-health-history.ts` is the same pair of halves
for the deployment recording. The pure half drives `summarizeDeploymentHistory`
over constructed readings and leans on the negatives: an unobserved day inside a
run neither splits it nor counts as a failing reading (it is reported as
`unobservedDays`), while an *observed* healthy reading between two failures
does split it — the two cases sit next to each other on purpose, because they
are the only thing separating a sample from a series. One failing reading is a
finding and not a standing fault, a window with no readings derives nothing
rather than an all-healthy gateway, a deployment the router dropped keeps the
readings it had and is not carried forward into the days after it vanished, and
an alias change inside the window is recorded rather than flattened. The rest
pins the arithmetic: transitions, the longest run, the failing share taken over
readings, error texts deduplicated per run, worst-first ordering with standing
faults above deployments that merely broke last night, and the gateway-wide
per-day rollup.

The Postgres half asserts the three rules the write has to obey. A full sync
files exactly one reading per deployment for today, agreeing with the snapshot
it came from on state, backend and resolved alias; a second sync the same day
replaces that reading instead of adding one; and a ranged backfill files nothing
at all, since it never calls `/health`. Then it plants five days of readings for
a deployment that is really stored *and healthy today* — a healthy stretch, a
day nobody looked, and three failing readings — reads them back through
`getGatewayDeploymentHistory` and requires the run to come out as one run of
three, closed by today's real reading rather than by a constructed one, with the
gap sitting outside it and the upstream status intact. It refuses to run at all
if real readings already occupy those days, and deletes exactly what it planted.
Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-health-history.ts`.

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

`apps/api/scripts/verify-gateway-notify.ts` covers governance *alerting*, and it
is the only script here whose subject is a side effect rather than a number: the
question is not whether a finding is right but whether it is sent, once, at the
right moment. Three halves. The **pure** one pins which states travel (`blocked`,
`over`, `soft`, pacing) and which do not (`warn` — a threshold nobody
configured — plus `ok` and `uncapped`), that a fingerprint carries no numbers so
a counter climbing from 104% to 999% is one episode, that crossing from `soft`
to `over` is a *different* one, and that a tag never produces a pace finding
however far through its period it is — asserted the way iteration 25's withheld
projection was, by proving the minimum-elapsed gate could not have fired instead.
The **cross-module** one is the check no single module can make: the budget card
and the notifier are run over the same real snapshot and required to agree row by
row on state and on pacing, because one of them arrives by mail and the other is
what the reader opens to check it. The **Postgres** half drives the whole
de-duplication story against a throwaway HTTP server standing in for the webhook:
a first evaluation delivers once with a bearer token and a readable sentence, a
re-evaluation with a bigger number delivers nothing while still updating what the
row says, an escalation closes the superseded finding and sends the new one, a
refused delivery is recorded with the target's own error and left undelivered
(then retried and stamped on the next run, with the attempt counted), and a
resolved finding closes silently but re-opens dated afresh and is delivered
again. It plants budget rows under a `verify-notify-` prefix and removes them.
Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-notify.ts`.

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
wrong cap.

`/tag/list` gets its own section, because it is the envelope least like the
other two: one call with no pagination to follow, caps read from the nested
`litellm_budget_table` rather than from the tag row, a `budget_id` the endpoint
did not expand yielding null limits rather than an invented cap, a nested `0`
cap staying `0` next to an uncapped tag, a dynamic tag dropped so it cannot
dilute the governance denominator, a trimmed name used as the id with `label`
null (a tag has no alias to resolve), a 404 on `/tag/list` costing the key
budgets nothing, and a mistyped *nested* cap throwing. The shared rule is pinned
alongside them: `budgetCounterResets` is true for `api_key` and `team` and false
for `tag`, and nothing else.

`/model/info` gets a section of its own for the same reason: a fourth envelope,
`{"data": […]}`, one entry per deployment rather than per model. What it pins is
everything that would be a silently wrong *number* rather than a crash — a
per-token price landing as nano-dollars per million, exponent notation surviving
the scale change (`2e-8`/token is `$0.02/M`), the two cache rates carried (they
are the only per-token prices the daily aggregate can never imply), a
per-second-billed model coming back null rather than free while an explicit `0`
stays zero, two deployments of one alias collapsing to one row that reports the
cheapest price and flags `priceVaries`, a priced deployment beside an unpriced
one counting as a disagreement, the context window collapsing to the smallest
(the one every deployment behind the alias honours), an unnamed provider read
off the routing string as LiteLLM itself does, wildcard rows dropped, a refused
or absent route costing the catalogue and nothing else, and a mistyped price
throwing. The pure join is checked in the same section: the alias resolves, the
fully qualified backend resolves, a provider-prefixed key falls back to the
deployment name, and a plausible near-miss resolves to nothing.

`/health` gets the last of the wire sections, and it is the only envelope that
is not a table: two lists, and which list an entry is in *is* its state. What it
pins is the shapes a real proxy can legitimately send and a naive reader would
mangle — an error string and an `exception_status` arriving as a number on one
entry and as a string on the next, a `mode_error` standing in as the message when
there is no other, a stray `error` on a *healthy* entry ignored (the list decides
the state, not the keys), a Bedrock deployment with no `api_base` at all, a
`custom_llm_provider` preferred over the prefix inferred from the routing string,
an entry naming no deployment dropped rather than stored blank, the
details-stripped (`health_check_details: false`) form still naming every
deployment and its state, the `model_id` fallback collapsing a pool to one row
per alias, a deployment reported in *both* lists resolving to the failing row,
all five absent statuses yielding no deployments and no error, and a malformed
body throwing rather than reporting a gateway with nothing behind it. The two
pure functions are checked in the same section: `resolveDeploymentModel` matching
on backend then alias and refusing a near miss, and `summarizeDeploymentHealth`'s
up/degraded/down rule over constructed rows — including that the counts
reconcile, that the unnamed deployments are a bucket rather than a merge, that
three regions failing identically is one fault, and that an empty gateway
summarises to nothing rather than to a healthy one.

`/spend/logs` gets a section too, and its rules are the inverse of every other
route's. What it pins first is the parameter that would fail *quietly*:
`summarize=false` must be on the wire, because the default answers daily
aggregates — the right shape, the wrong data, and a `200`. Then both envelopes
(a bare array and `{"data": […]}`), exponent-notation spend at nano scale, the
alias and the deployment model kept apart (the alias is what joins to usage),
`model_id` carried through as the only join to deployment health, a duration
taken from `request_duration_ms` where the proxy has it and derived from the two
timestamps where it does not, the identity falling back to `metadata` when the
columns are blank, `request_tags` read as a list *and* as a JSON string, and
`cache_hit` as the tri-state it is — nobody recorded one is not a miss. The two
rules that keep the layer honest are pinned last: the row cap is honoured and
reported as `truncated`, and 401/403/404/501 all mean "this proxy keeps no
logs", which is a supported configuration rather than a failure, while an empty
200 stays a *different* answer from a refused route. Per-row tolerance is
checked in both directions — a row with no id and one with no clock are dropped
while the rest of the sample survives, but an envelope that is neither shape
still throws.

A section then checks the pure budget arithmetic in `@dash/shared`,
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

`apps/api/scripts/verify-gateway-catalog.ts` covers the two things a fake proxy
cannot answer about the catalogue. The first is the **join**: a price list is
only worth storing if it can be read next to the usage it prices, and the two
are keyed independently — the catalogue by what the proxy is configured with,
the `model` dimension by what callers actually sent. So the load-bearing number
is coverage, which on the mock must be exactly 1 because both sides come from
one table; anything short of that is a bug in the join rather than in the data.
The second is what the catalogue **licenses**: re-pricing a window's tokens from
the four rates must reproduce the proxy's own bill *to the cent* on a
single-deployment model, and must land **under** it on the multi-deployment one —
which is the entire content of `priceVaries`, measured rather than asserted (the
mock's discounted alias re-prices at 0.716× its bill). The rest is the round trip:
a null price still null after Postgres, a stored price back to the cent, the
unpriced rows sorted last but still visible, and a planted retired model cleared
by the next full sync, since the catalogue is replaced wholesale. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-catalog.ts`.
`verify-gateway-range-sync.ts` carries the matching negative: a sentinel row in
`gateway_model`, like the one in `gateway_budget` and the one in
`gateway_deployment_health`, that a backfill must leave standing.

`apps/api/scripts/verify-gateway-health.ts` covers the three things the fake
proxy cannot answer about deployment health. The **join** — `/health` reports
routing strings and `/model/info` reports aliases, and only the sync holds both,
so the mock's retired `azure/gpt-35-turbo` deployment must be the one and only
row that fails to resolve, and every row that does resolve must land on an alias
the catalogue actually carries. The **reading nothing else can make** — the whole
argument for the table is that a *degraded* alias is invisible in spend and in
failures, which is checkable rather than assertable: the mock's degraded
`azure/gpt-4o` must still be billing on the same days its PTU pool is refusing,
and its failure rate must sit below the 1.5× materiality gate the reliability
card would need to badge it (2.81% against 3.49% gateway-wide). And the **blast
radius** — a full sync stores every deployment, an unresolved alias survives as
null, a null `api_base` survives as null, and a planted sentinel row is still
there after a ranged backfill. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-health.ts`.

`apps/api/scripts/verify-gateway-logs.ts` covers the request-log layer in two
halves, because two different things can be wrong with it. The **pure** half
constructs the rows a generator cannot produce — a request made outside a team,
one carrying three tags, one whose alias is only in `model` — and pins what
makes a cross-tab honest: an unattributed request is *counted* rather than
dropped or bucketed as "other", a multi-valued axis makes the cells legitimately
sum past the sample (the overlap invariant, seen at row level for the first
time), `sampleSpend` covers the unattributed rows because it describes the
sample rather than the attributed part, and a latency percentile over a sample
nobody timed is null and never zero. The **mock** half drives
`fetchSpendLogs` and checks the three facts the layer exists for: every request
carries every dimension at once, every request is timed, and the deployment each
one names is a deployment `/health` knows about — including that the
multi-deployment alias really does split across both of its ids, that one of
them is the pool `/health` reports as refusing, and that the refusing pool is
measurably slower on the same alias. Two rules keep the layer safe and are
checked rather than trusted: the sample's spend is a *fraction* of the same
window's aggregate spend (evidence, never the bill), and the same window asked
twice answers the same requests while a different window answers different ones,
since the stream is seeded off the window rather than off the clock. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-logs.ts`.

It cannot confirm that a real proxy *sends* these shapes — that is still an open
question below. It is, though, the harness for answering it: drop a captured
response from the real gateway into a handler and the assertions become a
conformance check of the proxy rather than of the client.

`apps/api/scripts/verify-gateway-logs-view.ts` covers what the *page* does with
that sample, which is a different set of ways to be wrong. Its pure half pins
the three silences apart (not read, refused, answered-with-nothing), the window
as the tail of the spine rather than of the picker, the cap being applied in the
view **and reported** while the totals above it still cover every key, the heat
scale being taken over the drawn cells only, the completeness figure being in
requests and clamped at 100%, an untimed request being excluded from the
percentiles rather than read as 0ms, and the deployment split — the failing pool
carrying its own rate where the alias-level number averages it away, an
immaterial deployment comparing nothing, and a request naming no deployment
counted as *unjoinable* rather than filed under a shared null. Its mock half
then runs `MockGatewayClient.fetchSpendLogs` through the same derivation the
page runs, which is what proves the split view finds the refusing PTU pool
behind an alias that bills normally, that the sample's spend stays a fraction of
the window's, and that switching axes re-cuts the same rows rather than fetching
again. Run it with
`node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-logs-view.ts`
(no env needed — it touches no database).

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
   per key, per team, or per tag? All three are read now, so this is no longer a
   question about what to build; it is a question about which switcher tab the
   card should open on, and the probe answers it in one round trip by reporting
   how many objects each management route carries.
8. Does the deployed proxy still leave `LiteLLM_TagTable.spend` unreset
   (BerriAI/litellm#27481)? `budgetCounterResets` assumes it does, which is the
   safe direction — treating a lifetime counter as a period counter would put a
   fabricated pace on the card, while treating a fixed period counter as a
   lifetime one only withholds a projection. The evidence is cheap to gather
   once budget history has run for a few weeks: a tag counter that never falls
   confirms the bug, one that drops to zero on its `budget_reset_at` says the
   deployment has the fix and the predicate can lose its special case.
9. Are the tags in use created ones or ad-hoc ones? `/tag/list` returns both,
   and only created tags carry a budget. A gateway where the tag dimension is
   large and the governed set is tiny means tags are being used as free-form
   spend labels, which makes them a good chargeback dimension and a poor
   governance one — the opposite of what a small, curated set would mean.

10. Is the `model` usage dimension keyed by the **public alias** or by the
    backend routing string? `resolveModelPrice` tries the alias, then the
    backend, then the deployment after the provider prefix, so either answer
    works — but which one it is decides whether two aliases pointing at one
    deployment show up as two rows of the breakdown or one, and it is the single
    number that makes catalogue coverage worth reading. The mock cannot answer
    it: both sides come from one table there, so coverage always reads 100%.
11. Do several deployments sit behind one alias on the corporate proxy, and do
    they charge the same? `price_varies` turns the stored rate into a floor
    wherever they do not, and a gateway fronting a PTU pool with a
    pay-as-you-go fallback is exactly the case where the difference is large. If
    the answer is "one deployment each", the catalogue's prices are rates and the
    floor caveat can come off the card.
12. **Does this proxy report cache tokens inside `prompt_tokens`?** Answered
    from LiteLLM's own transforms rather than from a live proxy, and now stated
    once as `CACHE_TOKENS_INSIDE_PROMPT_TOKENS`: it does, on both families —
    OpenAI-shaped backends report cache hits inside `prompt_tokens` (and have no
    cache write at all), and LiteLLM's Anthropic usage transform sets
    `prompt_tokens = input_tokens + cache_read_input_tokens +
    cache_creation_input_tokens`. Every module now reads the one statement, so
    the KPI, the cache card, the catalogue and the priced panel cannot disagree
    the way they did (22.1% against 28.3% on the same payload).

    What is left open is only whether *this* proxy behaves as documented, and
    that no longer needs anybody to remember to look: `detectCacheTokenConvention`
    runs on every payload and the cache card leads with the verdict when the
    counters do not fit inside the prompt count. A `writes_outside` verdict on a
    real gateway would mean the Bedrock path is reporting writes alongside
    `prompt_tokens` rather than inside it, which is a one-line change to
    `uncachedInputTokens` — but it must be *seen*, not assumed, which is why the
    detector exists and the convention is not simply a comment.
13. **Does `/health` carry `model_id`, and does this proxy run background
    health checks?** Two questions with one consequence each, and only the first
    is about correctness. Without `model_id` the routing string becomes the id,
    which collapses a load-balanced pool into a single row — the client handles
    it and says so in the logs, but a gateway whose PTU pool and pay-as-you-go
    fallback share one row can never read as *degraded*, only as up or down. The
    second is about cost: with `background_health_checks: true` the nightly sync
    reads a cached result for nothing, and without it the sync issues a
    one-token test call to every deployment once a night. Neither is knowable
    from the response — nothing in it says which of the two happened — so both
    are questions for whoever configures the proxy, and the recommendation is
    the same one LiteLLM's own docs make: turn background checks on.
14. **Is the routing string in `/health` the same string `/model/info` reports
    as `litellm_params.model`?** The alias join assumes so, and on the mock it
    is true by construction. If a real proxy normalises one of them (a trailing
    region suffix, a case difference) every deployment resolves to null and the
    health card reports a gateway of unnamed endpoints — which is visible rather
    than silent, since `unnamed` is a first-class count, but it is the first
    thing to check against a live proxy.

15. **Does the corporate proxy keep spend logs at all, and for how long?**
    `disable_spend_logs` is an ordinary setting at volume — the table is the
    largest thing in LiteLLM's database and costs a row per request — and
    `maximum_spend_logs_retention_period` prunes what it does keep on a schedule
    unrelated to the 90 days of daily aggregates. The drill-down is written so
    that both answers are legitimate (`available: false` is a result, not a
    failure), but which one is true decides whether the joint-key layer is worth
    a card. Ask before designing on top of it.

16. **Is `/spend/logs` fast enough to be a live route?** The API forwards it
    rather than storing it, on a seven-day window with a 5,000-row cap. On a
    proxy with a properly indexed `startTime` that is a lookup; on one with
    months of unpruned logs it may be a table scan somebody notices. If it is
    slow the answer is a narrower window, not a stored copy — a mirror of the
    proxy's request log is a different integration with a different owner.

## Not yet built

Governance is now rendered end to end across all three scopes
(`GatewayBudgetCard`, on `lib/metrics/gatewayBudgets.ts` over
`GET /api/gateway/budgets`). What is still missing on this side of the gateway:

- **A tag counter that means what it says.** Tag budgets are read and enforced,
  but the counter behind them is cumulative since creation rather than per
  period, because LiteLLM's reset job skips the tag table. Nothing on this side
  can fix that — re-deriving the period from `gateway_daily` is exactly the
  substitution the "never our sum" invariant forbids, since the enforced number
  is the one that refuses calls. The fix is upstream (or a tag whose period is
  its lifetime, which is a legitimate way to configure one). What this side owes
  it is the evidence: once budget history has watched a tag across a reset date,
  open question 8 answers itself and `budgetCounterResets` can stop assuming.

- **Budget history beyond what we recorded.** `gateway_budget_history` now
  answers "was this key already over last week" — but only back to the first
  sync that wrote it, and only at daily resolution. Neither limit can be lifted
  from here: the proxy serves current state and has nothing older to give, and a
  finer sample would mean syncing more often for no other reason.
- **Alerting beyond governance.** A budget finding now leaves the dashboard:
  every full sync evaluates the snapshot, records each finding as an episode in
  `gateway_notification`, and POSTs the undelivered ones to
  `GATEWAY_ALERT_WEBHOOK_URL`. The other five sources the attention digest reads
  cannot follow it there, and the reason is structural rather than a missing
  feature: anomalies, reliability, cache churn and coverage gaps are derived in
  the *browser* from the usage payload, so sending them would mean either running
  those derivations server-side (a second implementation of five modules, i.e.
  precisely the two-answers failure the digest exists to prevent) or moving them
  into `@dash/shared` and giving the API a range to evaluate them over — which is
  a real design question, since "what range" has no obvious answer for a nightly
  job. Delivery itself is also deliberately thin: one URL, one POST, no
  per-recipient routing, no severity filter and no quiet hours. Each of those is
  a policy somebody has to actually want before it is worth encoding.
- **Pricing what the catalogue now makes priceable.** Both cards the catalogue
  was fetched for now exist. `Price catalogue`
  (`lib/metrics/gatewayCatalog.ts`) puts list rates beside the effective rate
  the same model actually billed, and the priced panel on the cache card
  (`lib/metrics/gatewayCacheValue.ts`) puts a dollar figure on the prompt cache
  — reads valued at the spread they saved, writes at the premium they cost, the
  net against a no-cache counterfactual. What is *not* built, and is the honest
  limit rather than a gap to close later, is the same figure on any other
  dimension: the cache card's rows are keyed by the page's breakdown dimension,
  and one `team`'s cached tokens span every model it touched at rates differing
  by a factor. A per-team saving would be an average of price lists, so the
  panel stays pinned to `model` and the rest of the card keeps reporting tokens.
  The 0.1×/1.25× convention stays with it, and the catalogue is now evidence
  that it is the right convention rather than merely a plausible one — where the
  two disagree, the priced panel is the one reading this proxy's own rates.

  A second thing the catalogue makes possible and nothing does yet: a **model
  the catalogue prices lower for the same work**. Every rate on the card is
  per token, and a cheaper model that needs three times the tokens is dearer —
  so a substitution suggestion needs a quality signal the proxy does not export,
  and the card deliberately stops at reporting rates rather than recommending
  routes.
- **Pressing health on demand.** The card renders the *stored* nightly reading
  and there is deliberately no refresh button on it, because `/health` without
  `background_health_checks` issues a live test call to every deployment while
  answering: a button would bill a token per deployment per click, on production
  inference for the whole corporation. The honest versions of "check it now" are
  upstream — turning on the proxy's own background checks, at which point
  `/health` reads a cache and syncing more often becomes cheap — or a second
  route that probes one alias rather than all of them. Both are a decision about
  the proxy's configuration, not about this page.

- **A view on the outage history.** The recording now exists
  (`gateway_deployment_health_history`, one reading per deployment per day the
  sync asked, read through `GET /api/gateway/health/history` and
  `summarizeDeploymentHistory`), so "was this deployment already failing last
  Tuesday" is answerable — but nothing on the page reads it yet. The health card
  still renders the snapshot alone.

  What is *not* coming, and is the limit rather than a gap: a duration. The
  sample is nightly and a deployment that failed and recovered between two
  readings left nothing behind, so there is no honest way from these rows to an
  uptime percentage, an incident length or a minutes-down figure — every number
  the derivation produces is a count of readings for exactly that reason. The
  route to a real availability number is upstream (the proxy's own
  `background_health_checks`, which would make reading `/health` cheap enough to
  sample hourly), and that is a decision about the proxy's configuration rather
  than about this page.

  Alerting on a standing fault is the one thing that *could* follow the
  governance path, and it is the only other digest source that could: like
  budgets and unlike the five browser derivations, this is a table the API can
  assess on its own after a sync. It is not wired to
  `gateway_notification` yet, because the first question a
  standing-outage alert raises — does a deployment failing three nights running
  mean anything on a proxy nobody has looked at yet — needs a real proxy to
  answer.

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
- **Anything the request sample could be that costs a second read.** The
  `Request sample` card now renders the joint key, the latency percentiles and
  the deployment split (`lib/metrics/gatewayLogs.ts`), and what is *not* built is
  deliberate rather than pending. There is no request list — a table of
  individual calls invites reading one row as a fact about the gateway, and the
  rows carry identifiers (`user`, `session_id`) that a dashboard has no reason
  to hold on screen. There is no time-of-day or session-length read either:
  both would need a sample large enough to be representative, and this one is
  capped at a few thousand rows of a window that is millions. The honest way to
  those is a widened cap plus a statement about how the sample was drawn, and
  LiteLLM's route offers no sampling parameter at all — it answers the head of
  the window, which is a *biased* sample and is only safe for the questions the
  card asks now (does this pair exist, how slow is it, which deployment served
  it). Whether the route is even fast enough to keep as a live read is open
  question 16.
- **Cost centres on a gateway line.** A statement bills a team id, a tag or an
  email, not a department: joining those to the org taxonomy the Copilot side
  already has (`lib/metrics/costCentre.ts`) needs the `user`/`team` ids to be
  something an identity system recognises, which is open question 2 and 4 and
  cannot be settled from here. Until then the statement is billed against the
  proxy's own identifiers, which is what the export carries.
