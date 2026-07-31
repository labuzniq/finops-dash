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
GET /user/list?page=1&page_size=100                     → { users, total, page, page_size, total_pages }
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

**`/user/list` is a fourth envelope, and the one scope this integration does not
store all of.** `LiteLLM_UserTable` is the same kind of object as a key or a team
— a spend counter, a cap, a duration, rate limits — but the route and the
population differ:

- **It pages on `page` + `page_size`,** not on `size`, and answers a proper
  envelope (`users`, `total`, `page`, `page_size`, `total_pages`). Sending
  `size` here is accepted and ignored, which would silently pin the read to the
  default page of 25 users and lose the rest without an error anywhere.
- **The roster is the staff directory.** A key list is a curated set somebody
  created; an internal user row is created the first time somebody signs in, so
  a corporate proxy has one per employee. Only rows carrying an actual limit are
  governance (`isGovernedUser` in `litellm.ts`: a cap, a soft budget, a rate
  limit, a `budget_id` link, or an explicit block — `spend` is deliberately *not*
  on that list, since every user who ever made a call has one). The rest are
  dropped and counted, exactly as `/tag/list`'s dynamic tags are, and for the
  same reason read from the other direction: an uncapped *key* is a governance
  fact ("nobody has capped this"), while an uncapped *user* is a person. Storing
  them would put the directory in `gateway_budget` and append it again to
  `gateway_budget_history` every night.
- **The limits may be inline or on a join.** A user budgeted directly carries
  `max_budget` at the top level; one attached to a shared budget row carries a
  `budget_id` and the caps on `litellm_budget_table`, tag-style. Inline wins
  where both are present, because that is the row the proxy enforces against
  *this* user rather than against everyone sharing the budget.
- **`user_id` is the join and `user_email` is the label.** The id is what the
  `entities` breakdown of `/user/daily/activity` is keyed by, so a capped user's
  cap lands beside the spend the adoption card already ranks; the email is worth
  carrying because a proxy's `user_id` is frequently an SSO subject nobody
  recognises (open question 2). A governed row with no `user_id` is an orphan and
  is dropped, exactly as a key row with no token is.
- **The counter *is* reset.** `ResetBudgetJob` walks `LiteLLM_UserTable` along
  with keys and teams, so `budgetCounterResets('user')` is true and a pace
  projection over a user's counter means what it says. Tags remain the only
  exception.

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

### The exception log (the only source of *why*)

Everything above counts failures. `SpendMetrics` carries `failed_requests` per
day and per key, and `LiteLLM_SpendLogs` carries a `status` per request, and
neither carries a *reason*: a rate limit, an expired Azure credential, a prompt
over the context window and a Bedrock region falling over are one number in the
ledger and four different jobs for four different people.

`LiteLLM_ErrorLogs` is where the reason lives, and one admin route reads it:

```
GET /model/metrics/exceptions?_selected_model_group=&startTime=&endTime=
  → { "data": [ { "model": "<combined_model_api_base>",
                  "total_exceptions": 2,
                  "RateLimitError": 4013,
                  "Timeout": 7 } ],
      "exception_types": ["RateLimitError", "Timeout"] }
```

A **seventh envelope**, and the only one here whose *field names are data*: the
per-class counts are spread onto the same object as the row's own fields rather
than nested under one, so the parse takes `model`, takes `total_exceptions`, and
reads every remaining numeric key as an exception class. A non-numeric extra is
ignored rather than coerced; a class counted zero of is dropped rather than
stored.

Four things about it are load-bearing:

- **`total_exceptions` is not a total.** The route's SQL takes `COUNT(*)` over a
  CTE that has *already* grouped by `(deployment, exception_type)`, so the field
  counts distinct classes. A pool with four thousand rate limits and seven
  timeouts reports `total_exceptions: 2`. The client sums the class counts
  itself and keeps the proxy's figure only as evidence — using it would
  understate every deployment by three orders of magnitude, with a `200` and no
  error anywhere. The same family as `summarize` defaulting to `true` on
  `/spend/logs` and `size` being ignored on `/user/list`.
- **`model` is a deployment, not an alias.** It is
  `CONCAT(litellm_model_name, '-', api_base)`, or the model string alone when
  there is no `api_base` — the same resolution `gateway_deployment_health` is
  keyed at, and the resolution at which a throttled reserved-throughput pool is
  distinguishable from the pay-as-you-go deployment beside it. Both halves
  contain hyphens, so the key is never parsed back into its parts: the join runs
  the other way, with `deploymentExceptionKey(backend, apiBase)` in
  `@dash/shared` rebuilding the same string from a health row.
- **The query filters on one `model_group` at a time**, with no wildcard. There
  is no "everything" call to make: a sweep is one HTTP round trip per alias, the
  API picks the aliases from the window's own `model` usage ranked by spend
  (`EXCEPTION_MODEL_CAP`, 12), and the ones it skipped are reported. An alias
  nobody asked about is *unread*, not clean.
- **The window is a pair of datetimes** filtered as
  `"startTime" >= $1 AND "endTime" <= $2`, so the end bound has to be the end of
  the last day or that day's errors fall outside it.

And the rule everything built on it follows: **an error log is a reason, not a
count.** `LiteLLM_ErrorLogs` is written by a different code path from the daily
aggregates, is separately switchable (`disable_error_logs` is the twin of
`disable_spend_logs`), and is pruned on its own schedule — so its totals may
legitimately disagree with the same window's `failed_requests`, an empty answer
means "no errors recorded" rather than "no errors", and nothing derived from it
may be rendered as a failure rate. The mock reproduces that gap deliberately
(`ERROR_LOG_COVERAGE`), because a generator whose two tables agreed to the unit
would teach a derivation to assume something no proxy guarantees.

### The latency aggregate (the only speed reading that covers the window)

The gateway exports latency in exactly two places and they answer different
questions. `/spend/logs` carries `request_duration_ms` per row — the truth for
the rows it returns and a *biased* sample of the window, since the route has no
sampling parameter, answers the head of the range and is capped at a few
thousand rows out of millions. The other place is the sibling of the exception
route, where the proxy does the aggregation itself over every row it kept:

```
GET /model/metrics?_selected_model_group=&startTime=&endTime=
  → { "data": [ { "date": "2026-06-01",
                  "https://nocturne-weu.openai.azure.com/": 0.0071,
                  "bedrock/anthropic.claude-haiku-4-v1:0": 0.0043 } ],
      "all_api_bases": ["https://nocturne-weu.openai.azure.com/", …] }
```

An **eighth envelope**, and the second whose field names are data: one object
per day carrying `date` plus one key per deployment. The parse takes `date` and
reads every remaining numeric key as a deployment, the mirror image of the
exception parse.

Four things about it are load-bearing, and three of them are traps:

- **`_selected_model_group` defaults upstream to the literal `"gpt-4-32k"`** —
  not to "everything". A call without it answers `200` with an empty `data` and
  an empty `all_api_bases`, which reads exactly like a gateway that served no
  traffic. The client always sends it, the same rule as `summarize=false` on
  `/spend/logs` and `page_size` on `/user/list`.
- **The value is seconds per completion token, averaged per request.** The SQL
  is `AVG(EXTRACT(epoch FROM ("endTime" - "startTime")) / NULLIF("completion_tokens", 0))`
  — a mean of per-request *ratios*, not total seconds over total tokens. So it
  is a rate rather than a duration (multiplying it by anything asserts a
  completion length this payload does not carry), and it is sensitive to short
  answers, which carry the whole connection overhead in their ratio. The one
  honest re-reading is its reciprocal, tokens per second. `tokensPerSecond` in
  `@dash/shared` is that, and there is deliberately nothing else.
- **The key is an `api_base`, not a deployment.** LiteLLM names the column the
  `api_base` where there is one and the backend model string where there is not,
  then cuts anything after `/openai/`. Two backend models behind one endpoint
  therefore collapse onto one key *within a single response*, last row winning
  for that day — which is why the alias has to be carried back by the caller and
  why `latencyDeploymentKey(backend, apiBase)` in `@dash/shared` exists rather
  than a parse. It is the same one-directional join rule as
  `deploymentExceptionKey`, over a different formula.
- **A `null` body is an empty answer, not an absent route.** The handler falls
  off the end of its `if db_response is not None` branch and FastAPI serialises
  the implicit `None`, so a bare `null` is the proxy saying "nothing matched".
  Reading it as a refusal would report a working gateway as one without the
  endpoint, which is why this is the one read that goes through
  `getJsonResult` rather than `getJson`.

And what it shares with the request log rather than with the aggregates: it
reads `LiteLLM_SpendLogs`, so `disable_spend_logs` empties this route too, its
retention is the log's rather than the aggregates' ninety days, cache hits are
excluded upstream (`cache_hit != 'True'` — a cached answer has no backend
latency to report), and a deployment that only ever embedded is absent
altogether (`HAVING SUM(completion_tokens) > 0`).

`summarizeGatewayLatency` rolls a window up per key and per day and carries
exactly one threshold of its own — `LATENCY_ELEVATED_RATIO` (1.5×) gated on
`LATENCY_MIN_DAYS` (3). That is one more than the exception layer allows itself
and one *fewer gate* than the reliability card's badge, and both differences are
the payload's: every key here is measured in the same unit as every other key,
so "slower than the rest of this gateway" is a comparison the data supports —
but the proxy averaged the requests away, so there are no counts, no interval to
compute and no significance to claim. The badge is a materiality statement and
the minimum-days gate is the only evidence gate available. The day-level reading
is a **median across the keys that reported**, never a sum: rates do not add.

### The hang counter (the only wall-clock reading there is)

The three routes above between them say how many calls failed, why they failed
and how many seconds per completion token the rest averaged. None of them can
see a call that answered correctly after four minutes: it is a success in the
ledger, wrote no error log, and — if the answer was long — read at a perfectly
ordinary per-token rate. That request is the one somebody was actually waiting
on, and there is exactly one route that counts it:

```
GET /model/metrics/slow_responses?_selected_model_group=&startTime=&endTime=
  → [ { "api_base": "https://nocturne-weu.openai.azure.com/",
        "total_count": 40000, "slow_count": 84 },
      { "api_base": "", "total_count": 900, "slow_count": 3 } ]
```

A **ninth envelope**, and the plainest one here: the handler returns Prisma's
rows unwrapped, so the body is a **bare array** with no wrapper at all — or
`null` when the query matched nothing, exactly like `/model/metrics`. Upstream
it is

```sql
SELECT api_base, COUNT(*) AS total_count,
       SUM(CASE WHEN ("endTime" - "startTime") >= INTERVAL '1 SECOND' * $1
                THEN 1 ELSE 0 END) AS slow_count
FROM "LiteLLM_SpendLogs"
WHERE "model_group" = $2 AND "cache_hit" != 'True'
  AND "startTime" >= $3 AND "startTime" <= $4
GROUP BY api_base ORDER BY slow_count DESC
```

Four things about it are load-bearing, and three of them are traps:

- **The threshold is the proxy's, and it is not in the response.** `$1` is
  `proxy_logging_obj.slack_alerting_instance.alerting_threshold`, falling back to
  `DEFAULT_SLACK_ALERTING_THRESHOLD` — 300 seconds unless somebody configured the
  proxy's Slack alerting otherwise. The payload carries neither number, so the
  count means "requests at or past the proxy's own alerting threshold" and
  **nothing derived from it may be rendered with a number of seconds attached**.
  `SLOW_RESPONSE_DEFAULT_THRESHOLD_SECONDS` in `@dash/shared` exists to describe
  the default in prose and never to label a reading.
- **It carries its own denominator, and it is not the ledger's.** `total_count`
  is the request-log rows this query grouped: same window, same alias, cache hits
  excluded. That makes a slow *share* computable, which is the one thing the
  exception layer cannot do and the reason this is the only per-alias sweep whose
  badge can afford a significance test beside a materiality ratio. It is
  emphatically not a share of gateway requests — the ledger counts cached answers
  and lives in another table on another retention schedule.
- **The key is the `api_base` alone.** Coarser than either sibling:
  `/model/metrics/exceptions` keys by `model-api_base` (both parts) and
  `/model/metrics` falls back to the backend model string where there is no base,
  but this route selects `api_base`, groups on it, and coalesces a null to `""`.
  So every deployment addressed by region rather than by URL — the whole Bedrock
  fleet — is **one row per alias**, with nothing in the payload to split it.
  `slowResponseDeploymentKey(apiBase)` in `@dash/shared` is the third
  one-directional join key here, and `UNKEYED_DEPLOYMENT` is what that bucket is
  called so nothing renders it as a blank row or treats it as an addressable
  backend.
- **The counts come from `COUNT(*)` and `SUM(...)`.** Postgres types those as
  `bigint` and `numeric`, and a driver handing a bigint back as a string is
  ordinary rather than malformed — so both are accepted. A row whose
  `total_count` does not read as a non-negative integer is *dropped* rather than
  zero-filled (the total is this layer's only denominator, and a zero one would
  render every hang as an infinite share), and a `slow_count` past the total is
  clamped, since the SQL cannot produce one.

What it shares with the request log rather than with the aggregates is the whole
of `/model/metrics`'s last paragraph: it scans `LiteLLM_SpendLogs`, so
`disable_spend_logs` empties it, its retention is the log's, and cache hits are
excluded upstream — a cached answer was never slow.

`summarizeGatewaySlowResponses` rolls a sweep up **per key** rather than per
(alias, key) pair, which is the opposite of the latency layer's choice and is
forced by the route: one endpoint answering four aliases comes back four times
with four disjoint counts of the same deployment's traffic, and those are counts
of requests, so — unlike a rate — they may be added. The aliases are kept beside
the row. The badge has **both gates**: `wilsonScoreLowerBound` against the
gateway-wide share for evidence, `SLOW_RESPONSE_ELEVATED_RATIO` (1.5×) and
`SLOW_RESPONSE_MIN_COUNT` (5) for size. This is the only live read that can
afford both, for the reason stated above — and the ranking is by hangs first,
because that is the number somebody acts on.

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

A **full** sync also sweeps `/model/metrics/slow_responses` for **one day** — the
window's last, which is yesterday — and appends what it counted to
`gateway_slow_response_daily`. It is the first of the four *live* reads to be
stored, and the only one of the three per-alias sweeps whose payload survives
being kept: the exception route carries no denominator and `/model/metrics`
answers an average with its counts already discarded, while this one answers a
count of disjoint request-log rows beside the number of rows it counted them out
of. Counts add, across the aliases of one sweep and across nights; an average and
a denominator-less total do not.

Six rules, and only the first two are new:

- **One day, and it is yesterday.** Today is still accruing, exactly as it is
  for usage, so filing it would make every trend read as a collapse on its newest
  bar. Sweeping the day the usage window just settled for also means the counts
  sit beside the `gateway_daily` row written in the same run.
- **The alias list comes from the snapshot in memory**, ranked by that day's own
  spend and capped at `SLOW_RESPONSE_MODEL_CAP` like the live route, because the
  proxy's SQL filters on one `model_group` at a time and a sweep is a round trip
  per alias over the largest table LiteLLM has.
- **Grain is (date, alias, key)**, upserted on all three. Finer than the roll-up
  anything renders, deliberately: the route groups on `api_base` and is queried
  per alias, so one endpoint serving four aliases answers four times with four
  disjoint counts of it. Keeping them apart is what lets a reader sum to the key
  *and* see which traffic routed there.
- **A backfill records nothing**, and unlike `/health` the reason is not cost but
  truth: this route reads the request log, which has its own retention and can be
  switched off, so asking it about six days in May would answer with whatever
  survived pruning and file that as the reading for those days.
- **A refusal, `disable_spend_logs` and a swallowed failure all record nothing
  either.** `available: false` may never land as a night on which nothing hung —
  the entire value of the table is that an unread night stays unread.
- **A failure never fails the job**, for `/health`'s reason and more strongly:
  this is the proxy's largest table, and a sweep that timed out is not a reason
  to discard ninety days of usage that already landed.

`GET /api/gateway/slow-responses/history?days=` serves it and
`summarizeSlowResponseHistory` in `@dash/shared` reads it. The window **ends
yesterday** rather than today — unlike the two other history routes, and because
of what is stored rather than because of the clock: today can never carry a
reading, so ending the window on it would report a gap on the newest night on
every visit forever. The derivation adds no threshold of its own: the badge is
the live card's two gates restated over the pooled counts (more evidence, the
same question), shares are of the route's own denominator, and a night with no
reading is left out of the series and counted in `unobservedDays` rather than
zero-filled. Its one new statement is a **trend** — the observed nights split in
half and each half *pooled*, because the nights have wildly different
denominators and a mean of nightly shares would let a quiet Sunday outvote a
Wednesday — reported in percentage points and withheld under
`SLOW_RESPONSE_TREND_MIN_DAYS` (6) observed nights.

A full sync sweeps `/model/metrics/exceptions` for the **same day** under the
same rules, and appends what it counted to `gateway_exception_daily`. It is the
second live read to be stored, on the same licence: `LiteLLM_ErrorLogs` rows are
disjoint, so counting them adds across the aliases of one sweep and across
nights. `/model/metrics` is kept too, one section below, but on a narrower
licence: an average of nightly averages is a number with no referent, so those
readings are compared and never added.

What it does **not** inherit is a denominator. That route carries none at all, so
the stored rows can answer what has been breaking and whether the *mix* moved,
and never a rate, a share of traffic or a badge. Every rule above carries over
unchanged (one day and it is yesterday, aliases from the snapshot capped at
`EXCEPTION_MODEL_CAP`, nothing recorded for a backfill or a refusal or a
swallowed failure, and a failure never fails the job). Two are this layer's own:

- **The sweep files a receipt, whatever it found** —
  `gateway_exception_sweep`, one row per night with how many aliases were asked
  about and what came back. It is needed here and nowhere else because of a
  difference between two otherwise identical routes:
  `/model/metrics/slow_responses` answers a row for every deployment key that
  carried traffic, so a night that was read always leaves rows behind, while
  `/model/metrics/exceptions` answers rows only where something *failed*. A night
  on which the gateway behaved perfectly therefore records nothing at all —
  byte-identical, in the rows, to a night the sweep was refused or never ran, and
  those are opposite findings. A date with a receipt and no rows is a **clean**
  night; a date with neither is unread.
- **The class is derived on read, not stored.** `exception_type` is kept
  verbatim. The contrast with `gateway_deployment_health_history.model` is
  deliberate and is about what the value depends on: that column is resolved
  against the catalogue fetched in the same run, so re-resolving it later would
  re-file a deployment that has since moved. A class is a static mapping from a
  Python class name to whoever can act on the fault, so deriving it on read means
  adding a name to the taxonomy re-files the history instead of stranding it
  under `other` for good.

`GET /api/gateway/exceptions/history?days=` serves both tables and
`summarizeExceptionHistory` in `@dash/shared` reads them. The window ends
yesterday for the hang history's reason. The derivation adds no threshold — there
is nothing to threshold, since the layer has no denominator — and its one new
statement is a **mix shift**: each class's share of recorded exceptions, split
half-over-half on *swept* nights (clean ones included, since a quiet night is
evidence), pooled rather than averaged, in percentage points, and withheld under
`EXCEPTION_TREND_MIN_DAYS` (6) or when a half recorded nothing at all. A mix is
the one reading a missing denominator cannot corrupt: ten times the traffic
doubles every class and moves the statement by nothing, which is exactly what a
count trend would fail to do.

A full sync sweeps `/model/metrics` for the **same day** as well, and appends
what it read to `gateway_latency_daily` — one reading per (night, alias,
deployment key). It is the third live read to be stored and the first stored on a
licence that is not arithmetic. The two above are kept because their counts
**add**: disjoint log rows may be summed across a sweep and across nights.
Nothing here adds, and nothing ever will — the proxy answers
`AVG(seconds / completion_tokens)` and throws the request counts away before
answering, so two nights' readings have no total and no weighted mean.

What licenses this table is the other precedent in this integration:
`gateway_deployment_health_history`, which keeps a nightly reading that cannot be
aggregated either. A sequence of readings answers a question the live route
structurally cannot — *has this endpoint been reading slow all week, or only
tonight* — because a live route answers one window and has no memory. So the rule
this table carries is narrower than the hang table's: **the rows may be kept and
compared, never pooled**.

Every rule from the two sweeps above carries over (one day and it is yesterday,
aliases from the snapshot capped at `LATENCY_MODEL_CAP`, nothing recorded for a
backfill or a refusal or a proxy running `disable_spend_logs` or a swallowed
failure, and a failure never fails the job). Three are this layer's own:

- **The grain keeps the alias.** The hang history adds two aliases behind one
  endpoint into one row, because their counts are disjoint counts of that
  endpoint's traffic. Here they are two averages over two different workloads,
  and their mean would describe neither — so `(date, model, key)` is the grain
  and the alias is never summed away. It is also the grain the live card uses,
  so the two cannot disagree.
- **The rate is stored as an integer.** `seconds_per_token_nano` is the reading
  at 1e9 scale, for the same reason money is integer cents: a float column
  drifts. It is never zero — a non-positive average is a parse failure, not an
  instant deployment — and it leaves that form in exactly one place, the read
  service, as `nanoToDollars` is the one place money does.
- **The sweep picks its night out of a series.** This route answers a per-day
  series per key rather than one number, so the reading for the swept day is
  selected by date and any other day the proxy volunteers is dropped. Filing them
  would record nights nobody asked about under tonight's `observed_at`.

`GET /api/gateway/latency/history?days=` serves it and `summarizeLatencyHistory`
in `@dash/shared` reads it. The window ends yesterday for the hang history's
reason. The derivation adds **no threshold of its own** — the badge is the live
layer's `LATENCY_ELEVATED_RATIO` gated on `LATENCY_MIN_DAYS`, restated over
stored nights, because a longer recording is more evidence rather than a
different question — and every window figure is a **median**: a night is the
median across the pairs that reported it, a pair is the median of its nights, and
the gateway figure is the median of the pair medians. Its one new statement is a
trend, and it is the only one on this page reported as a **ratio** rather than in
percentage points: the two sibling trends compare shares, where a difference is
points, while this compares a rate, where the honest comparison is "1.4× the
seconds per token it was" and a subtraction would answer in a unit whose size
depends on which models the gateway happens to run. It is withheld under
`LATENCY_TREND_MIN_DAYS` (6) observed nights, and it is evidence about the
*reading* rather than a verdict about the backends: the average is per request,
so a team shipping a classifier that answers in one token drags it without
anything having got slower (open question 20).

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

Finally — again only after a **full** sync — the job **evaluates what it just
stored and sends what it finds** (`services/gateway-notify.ts`). Two sources
feed it, and they are the only two that may: a finding can leave the dashboard
exactly when it comes out of a *table*, because every other card derives its
findings in the browser from the usage payload over a range, so they exist only
while somebody is looking at the page and there is no obvious range for a
nightly job to evaluate them over.

**Governance** (`gateway_budget`) sends four states — `blocked`, `over`, `soft`,
and *pacing* past a cap — classified by `assessBudget` in `@dash/shared`, the
same function the budget card and the attention digest read, so a notification
and the card it names cannot disagree. `warn`, `ok` and `uncapped` deliberately
produce nothing: a threshold nobody configured is worth a row on a card and is
not worth waking somebody, and an uncapped key is a standing decision rather
than an event.

**Deployment health** (`gateway_deployment_health`) sends the two alias states
`summarizeDeploymentHealth` — again the shared function, again the one the card
reads — calls out: `deployment-down` (every deployment behind the alias failing,
so calls are being rejected *now*, which the usage payload only shows as
failures tomorrow) as critical, and `deployment-degraded` (some failing, the
alias still answering) as a warning, because that is the finding no spend- or
failure-shaped surface can make at all. `up` is not a finding, and neither is
the *history*: a standing fault names the deployment the snapshot is already
reporting tonight, so `gateway_deployment_health_history` is the evidence under
the finding rather than a second one. The one deliberately odd key here is the
unnamed bucket (`UNNAMED_MODEL_KEY`, shared with the page's digest): a
deployment the catalogue could not name is still a deployment that is failing,
and filing it under a near-match is the one thing the health table refuses to do.

The de-duplication story is `gateway_notification`, keyed on the finding's
**fingerprint** — `kind:scope:key`, carrying no numbers (`scope` is the budget
scope for a governance finding and `model` for a deployment one, since an alias
is what a reader looks up):

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
- **A source that could not be read closes nothing.** An episode ends because
  the finding stopped being reported, which is only a fact about a table
  somebody actually looked at. `/health` is the one whose failure is *swallowed*
  by the sync (it issues a live call per deployment, so failing a sync over it
  would be the wrong trade), which leaves the previous reading standing and no
  reading refreshed — and a proxy that has never answered it leaves the table
  empty. Neither is a recovery, so the close pass is scoped to the sources the
  run evaluated (`GatewayNotifyResult.assessed`), and every open deployment
  episode survives a blind night.

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
- **An error log is a reason, not a count.** `/model/metrics/exceptions` reads
  `LiteLLM_ErrorLogs`, which is written by a different code path from the daily
  aggregates, is switchable on its own (`disable_error_logs`) and is pruned on
  its own schedule — so its totals may disagree with the same window's
  `failed_requests` and nothing derived from it may be rendered as a failure
  rate or a share of traffic: this table carries no denominator at all. An
  answer with no rows means "no errors *recorded*", which is a weaker claim than
  "no errors". And the proxy's own `total_exceptions` is never read as a total:
  upstream it counts distinct exception classes, so a pool with four thousand
  rate limits and seven timeouts reports `2`. The count is ours, summed from the
  classes, with the proxy's figure carried beside it as evidence. It **may** be
  stored (`gateway_exception_daily`, one night per alias per deployment per
  type), because error-log rows are disjoint and counting them adds across
  nights — but it is stored with a **receipt** (`gateway_exception_sweep`), and
  that is not optional: this route answers rows only where something failed, so a
  night the gateway behaved records nothing and is byte-identical to a night the
  sweep was refused. A night with a receipt and no rows is clean; a night with
  neither is unread, and nothing derived from either may be interpolated. The
  class is derived on read from the stored `exception_type`, never frozen into
  the row.
- **Latency is a rate, and the rate is per completion token.** `/model/metrics`
  answers `AVG(seconds / completion_tokens)` over requests — a mean of
  per-request ratios, so nothing derived from it may be rendered as a request
  duration, an SLA figure or a percentile, and the only transformation that adds
  no claim is its reciprocal (`tokensPerSecond`). It carries no request counts
  at all, which is why the badge on it is a materiality ratio gated on days
  observed and never a significance test: there is nothing to compute an
  interval from. The day-level reading is a median across keys, never a sum,
  because rates do not add. And it reads the request log rather than the
  aggregates, so `disable_spend_logs` empties it, cache hits are excluded
  upstream, and a deployment with no completion tokens is absent rather than
  instant. It **may** be stored (`gateway_latency_daily`) — but on a licence
  neither of the other two stored reads needs, and the difference is the whole
  rule: those keep counts, which add, while these are readings that may be kept
  and compared and never pooled. Every window figure taken off the table is a
  median of nightly readings, two aliases behind one endpoint stay two rows
  (their averages have no sum), a night with no row is a night nobody read rather
  than a fast one, and nothing may be interpolated into it.
- **A hang count is against a threshold nobody here can see.**
  `/model/metrics/slow_responses` compares `endTime - startTime` against the
  proxy's own `alerting_threshold` (300 seconds unless configured) and does not
  report which number it used — so the count may never be rendered with a
  duration attached to it, and two proxies' counts are not comparable. It does
  carry its own denominator (`total_count`, the request-log rows it grouped with
  cache hits excluded), which makes it the only live read whose badge may use a
  significance test — and that denominator is *not* the ledger's request count,
  so a hang share may never be rendered as a share of gateway traffic. Its
  grouping key is the `api_base` alone, with no fallback to a model string, so
  every deployment without a URL is one bucket per alias and is named as such
  rather than left blank. It is also the one live read that may be **kept**:
  `gateway_slow_response_daily` holds one night per row per (alias, key) because
  disjoint request-log counts add across nights, where an average and a
  denominator-less total do not. A night with no row is a night nobody read —
  never a night nothing hung — so nothing derived from the table may interpolate
  one, and a period total read off it is a floor.
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
  does not.** LiteLLM's `ResetBudgetJob` walks keys, teams and internal users; it has no tag
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
- **`/user/list`'s stored rows are a strict subset for the opposite reason, and
  the cut is ours rather than the proxy's.** Every internal user is a real row on
  the proxy; only the ones carrying a limit are stored here. A key, a team and a
  tag exist because somebody created them, so an uncapped one records a decision
  ("nobody has capped this"); a user row is created the first time somebody signs
  in, so an uncapped one records a person. Keeping them all would put the staff
  directory in `gateway_budget` and append it again to `gateway_budget_history`
  every night, and would report the gateway as ~0% governed for the arithmetic
  reason that most employees are not individually capped — which says nothing
  about whether user budgets are in use. The dropped rows are not lost: they are
  the `user` usage dimension, which is where "who spent what" belongs.
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
  comes from `assessBudget` or `summarizeDeploymentHealth` in `@dash/shared` —
  the ones the budget card, the health card and the attention digest read. A
  second implementation on the server would let the alert somebody received
  disagree with the card they open to check it, which is strictly worse than the
  digest's two-answers failure because one of the answers is already out of the
  building.
- **A source that could not be read closes no episode.** Alerting assesses
  tables, and "the finding is gone" is only a fact when the table was actually
  read. An empty `gateway_deployment_health` (never asked) and a stale one
  (`/health` failed and its failure was swallowed, so the previous reading
  stands) must both leave open deployment episodes open — a run that closed them
  would announce a recovery nobody observed, the same invention the health
  history refuses when it declines to split a run across an unread night.
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
GATEWAY_ALERT_WEBHOOK_URL=     # optional: where budget and deployment findings are POSTed
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
| `GET` | `/api/gateway/budgets` | `{ budgets }` — current caps, rate limits and the enforced counter per key, team, configured tag and *governed* user (an uncapped user is a person, not a governance object), grouped in `GATEWAY_BUDGET_SCOPES` order and each scope ranked by share of cap consumed with the uncapped rows last. No parameters: it is state, not a range. |
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
| `GET` | `/api/gateway/exceptions?from=&to=` | `{ from, to, models, skippedModels, deployments, available, fetchedAt }` — why the failed calls in a window failed, per deployment, fetched **live** from `/model/metrics/exceptions` and stored nowhere. One proxy call per alias (the route has no wildcard), aliases taken from the window's own `model` usage ranked by spend and capped at `EXCEPTION_MODEL_CAP` (12) with the rest reported as `skippedModels`. Window capped at `EXCEPTION_MAX_WINDOW_DAYS` (31), `400` beyond it, `503` while the source is `off`. `available: false` means the route was refused or is absent; an empty answer means no errors were *recorded*, which on a proxy running `disable_error_logs` is a different claim from none happening. |
| `GET` | `/api/gateway/exceptions/history?days=` | `{ from, to, recordingSince, observations, sweeps }` — what the nightly exception sweep recorded on each of the last `days` days (default 60, max 365), one row per (day, alias, deployment, `exception_type`), plus one **receipt** per night the sweep ran. The second history any of the four live reads has, on the hang table's licence: error-log rows are disjoint, so counting them adds across nights. It answers two lists rather than one because this route reports only what *failed* — a night with a receipt and no rows is a clean gateway, a night with neither is one nobody read, and in the rows alone those are the same empty list. No denominator anywhere in it, so nothing derived from it is a rate; the class is derived on read from the stored `exception_type`. Window ends **yesterday**, like the hang history. |
| `GET` | `/api/gateway/latency?from=&to=` | `{ from, to, models, skippedModels, series, apiBases, available, fetchedAt }` — how slowly each deployment answered, per day, fetched **live** from `/model/metrics` and stored nowhere. One proxy call per alias like the exception sweep, aliases taken from the window's own `model` usage ranked by spend and capped at `LATENCY_MODEL_CAP` (12). Window capped at `LATENCY_MAX_WINDOW_DAYS` (31), `400` beyond it, `503` while the source is `off`. Values are **seconds per completion token**, never durations; keys are `api_base`-shaped, so the alias is carried beside them. `available: false` means refused, absent, or a proxy running `disable_spend_logs` — never "the gateway was fast". |
| `GET` | `/api/gateway/latency/history?days=` | `{ from, to, recordingSince, observations }` — what the nightly latency sweep read on each of the last `days` days (default 60, max 365), one reading per (day, alias, deployment key). The third history any of the four live reads has, and the only one stored on a non-arithmetic licence: these readings may be **compared and never pooled**, since the proxy averaged the request counts away. Every window figure `summarizeLatencyHistory` takes off it is a median — of the pairs on a night, of a pair's nights, and of the pair medians gateway-wide — and its trend is a **ratio** rather than points, because the unit is a rate. Window **ends yesterday** like the two sibling histories. A day with no row is a night nobody read, never a fast one. |
| `GET` | `/api/gateway/slow-responses?from=&to=` | `{ from, to, models, skippedModels, rows, available, fetchedAt }` — how many calls **hung**, per endpoint, fetched **live** from `/model/metrics/slow_responses` and stored nowhere. The only wall-clock reading the proxy aggregates: a count of requests that ran past the proxy's own `alerting_threshold` (which the response does not carry, so neither does this route) beside the requests it counted them out of. One proxy call per alias like both other sweeps, capped at `SLOW_RESPONSE_MODEL_CAP` (12); window capped at `SLOW_RESPONSE_MAX_WINDOW_DAYS` (31), `400` beyond it, `503` while the source is `off`. Keys are the `api_base` **alone**, so every deployment without a URL arrives as one `UNKEYED_DEPLOYMENT` bucket. `available: false` means refused, absent, or `disable_spend_logs` — never "nothing hung".
| `GET` | `/api/gateway/slow-responses/history?days=` | `{ from, to, recordingSince, observations }` — what the nightly sweep counted on each of the last `days` days (default 60, max 365), one row per (day, alias, endpoint key). The stored twin of the route above and the only history any of the four live reads has, because counts of disjoint request-log rows are the one thing here that may be added across nights. The window **ends yesterday**: the sweep covers the day usage settled for, so today can never carry a reading. A day with no row is a night nobody read — a refusal, `disable_spend_logs`, a backfill or a missed run — and never a night nothing hung. `recordingSince` is answered outside the window so an empty list can be told apart from a recording that started on Tuesday. |
| `GET` | `/api/gateway/probe` | A live connection check — see below. Reads no table, writes nothing, and always answers `200`: a dead proxy is a result, not an error. |
| `GET` | `/api/gateway/status` | `{ source, configured }`. |
| `POST` | `/api/refresh/gateway` | `202` with the job to poll; `503` while the source is `off`. |
| `POST` | `/api/refresh/gateway?from=&to=` | The same job narrowed to a backfill of those days — how a coverage gap is repaired. Bounds are optional and clamped to the sync's own window; `400` for an inverted range or one the proxy has pruned entirely. |

## The connection check

`GET /api/gateway/probe`, behind **Test connection** on the `Data sources`
page (`apps/web/src/components/sources/GatewayProbePanel.tsx`). It calls every
route the sync depends on — the three activity routes for a single day, then
`/key/list`, `/team/list`, `/tag/list`, `/user/list`, `/model/info` and
`/health/readiness` —
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

`/tag/list` and `/user/list` are the two routes where `empty` is counted on the
*governed* rows rather than on the response: a proxy that answers forty dynamic
tags and no configured one — or four thousand users and no caps — has nothing to
put on the budget card, which is the same consequence as an empty array and a
different one from a refusal. On `/user/list` the gap between the two counts is
the wider and more interesting number, so the detail spells both: it is also the
fastest way to see that this integration is deliberately not storing the staff
directory.

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
| Section nav | The page's own table of contents, sticky at the top: one chip per section that drew something, in page order, with how many of its cards rendered. It carries no severity and no count of findings — the digest under it is the "look here first" answer, and a second one computed differently would be two answers to one question |
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
| Why calls failed | The only card that says what the failures *were*, read live on a button press: the window's exceptions rolled up **by class with the party that can act on each one named** (a quota, a credential, a cap this proxy enforces, a provider fault, a caller sending something the model would not take), and by **deployment** — the resolution the aggregates do not have — with each row joined to tonight's health reading where the key matches. Every share is a share of what was *recorded*; the ledger's own failure count sits beside the total as a disagreement between two tables rather than as coverage, and an alias the capped sweep did not reach is reported as **unread**, never as clean |
| What broke over time | The same nightly sweeps kept, and the second of the four live reads to have a history — legal here because error-log rows are disjoint, so counts add across nights. It needs one thing no other history here does: a **receipt** per night the sweep ran, since this route answers rows only where something faulted and a clean gateway files the same nothing a refused sweep does. A night with a receipt and no rows is **clean**, a night with neither is **unread**, and the strips draw the two differently. Every share is of what was *recorded* — there is no denominator, so no rate, no badge and no significance test anywhere on the card — and the one statement it adds is a **mix shift** in percentage points, half-over-half and pooled: a class taking a bigger slice of the same errors is a change in what is breaking, where a rise in the count is indistinguishable from a rise in traffic. Withheld under `EXCEPTION_TREND_MIN_DAYS` swept nights, because "nothing moved" would be a fact about the age of the recording |
| How slowly the backends answered | The page's only card about **time**, read live on a button press, and the only one whose unit has to be spelled out: seconds per completion token, averaged per request, so nothing on it is a request duration, a percentile or an SLA figure — the one re-reading is its reciprocal, tokens per second. A per-day median across the keys that reported (a median, never a sum: rates do not add) with a thin day drawn dim rather than short, and the deployment keys ranked slowest first with each row's ratio to the gateway median, its fastest and slowest day, and the gate that stopped a badge where one did not land. Every row is joined to tonight's health reading — and because this route keys a row by its `api_base` alone, a base fronting deployments the reading disagrees about reads **mixed** rather than being attributed to either |
| Latency over time | The same nightly readings kept, and the third of the four live reads to have a history — on a licence neither sibling table needs: nothing here **adds**, since the proxy averaged the request counts away, so these are readings that may be **kept and compared and never pooled**, which is what `gateway_deployment_health_history` already runs on. The window's median rate with a half-over-half **trend as a ratio** (not percentage points — a difference of two rates is a number in seconds-per-token whose size depends on which models the gateway runs), a per-night strip where height is the median and *opacity* is how many endpoints reported it, and a strip per (alias, endpoint) pair with three states (fast, slow **for itself**, **no reading filed**) — never "clean", which this layer has no such thing as. The grain keeps the alias, because two aliases behind one endpoint are two averages over two workloads with no weight to combine them. Every claim is the shared roll-up's, the badge is the live card's own ratio and days-observed gate, and a recording too short to split says so instead of drawing a flat direction |
| How many calls hung | The last of the four questions about one window of traffic, read live on a button press: how many requests ran past **the proxy's own alerting threshold** — a number the response does not carry, so no figure on the card carries a duration and two proxies' counts are not comparable. Every share is taken against the route's **own** denominator (request-log rows, cache hits excluded upstream), with the ledger's count for the same days beside it as a disagreement between two tables and never as a divisor. Endpoints rank by hangs, each with its rate, its ratio to the gateway, the aliases that routed to it, the gate that stopped a badge where one did not land, and tonight's health verdict — except the `api_base`-less bucket, which takes **no** verdict: it is not an endpoint, so there is nothing to look it up by |
| Hangs over time | The same nightly sweeps kept — the only one of the four live reads that has a history, and the only one that may have one, because counts of disjoint request-log rows are the one thing here that adds across nights. The window's pooled hang rate with a **half-over-half trend in percentage points** (pooled, never a mean of nightly shares: the denominators differ by orders of magnitude), a per-night strip where height is the rate and *opacity* is how many endpoints reported it, and a strip per endpoint with three states (clean, hangs, **no sweep filed**). Every claim is the shared roll-up's — the badge is the live card's own two gates over the pooled counts — and a recording too short to split says so instead of drawing a flat direction |
| Deployment health | Which of the deployments behind each public alias are answering, from the reading the last full sync took: the aliases worst-first with their deployments and the proxy's own error text under them, the provider rollup beside it, and the reading's **age** on the card — a nightly snapshot, never a live call |
| Deployment health over time | The same nightly readings kept as a sequence — the one thing the snapshot above structurally cannot say: which deployments have been refusing for nights rather than for one evening. A strip per deployment with three states (answering, failing, **no reading filed**), the gateway-wide failing count per night, standing faults first, then anything failing now, then intermittence — every figure a count of **readings**, never a duration or an availability percentage. A recording too short to hold a standing run says so instead of reporting a clean sheet |
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

Thirty decisions worth keeping:

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
  their findings in one list, because twenty-four cards each flagging their own faults means every
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

- **The health history card adds no rule about the gateway, and three about the
  drawing.** `summarizeDeploymentHistory` in `@dash/shared` is the single
  statement of what a *sequence* of readings may be read to mean, shared with the
  API's own verification, exactly as `summarizeDeploymentHealth` is for one
  reading. `lib/metrics/gatewayHealthHistory.ts` adds only what the card needs:

  **A spine clamped forward to `recordingSince`.** There is no backfill for this
  table and there never can be — the proxy serves current state only — so a
  60-day window on a four-day recording is drawn as four days rather than as 56
  nights nobody looked at. The budget history card clamps for the same reason.

  **Three states per cell, not two.** A night with no reading is hatched, in the
  per-deployment strip and in the gateway-wide one. This is the one surface where
  the distinction would be invisible: a green cell and an unread night read
  equally reassuringly, and drawing the second as the first asserts a success
  nobody observed — the same invention as splitting a run across an unobserved
  day, which the shared rule already forbids.

  **A recording too short to hold a standing run says so.** Below
  `STANDING_OUTAGE_READINGS` recorded days, "none standing" is a fact about how
  long this dashboard has been watching and not about the gateway, so it is
  stated above the numbers rather than footnoted. Same family as the health
  card's staleness flag and `recordingSince` on the route.

  Two things follow from what is *not* here. Nothing converts readings into
  hours, days down or an availability percentage — a deployment can fail and
  recover between two nightly readings and leave nothing behind, so a duration
  would be an invention and a percentage is a duration wearing a hat. And the
  card feeds **no finding to the attention digest**: a standing fault is the same
  deployment the snapshot card is already reporting as `down` or `degraded`
  tonight, and the digest never merges or duplicates two findings about one key.
  What the history adds is the *evidence* under that finding, which is a reason
  to open the card rather than a second row at the top of the page.

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

- **The exception card is a reason beside a rate, never instead of one.** It
  sits directly under the reliability card, and every rule on it comes from the
  layer rather than from the view.

  **A button, not a mount**, for a reason the request sample does not have: the
  proxy's route filters on one `model_group` at a time with no wildcard, so a
  read is a round trip *per alias in the window*. The API picks the aliases from
  the window's own usage ranked by spend, caps the sweep, and reports the rest —
  and the card renders those as **unread rather than clean**, because a capped
  per-model read that says nothing about the cap looks exactly like a quiet
  gateway.

  **No rate, no share of traffic, anywhere.** `LiteLLM_ErrorLogs` carries no
  denominator at all, so every percentage on the card is a share of the
  exceptions *recorded*. The one figure that touches the ledger — exceptions
  recorded over failures counted for the same days — is deliberately
  **unclamped** and labelled as a disagreement between two tables rather than as
  coverage: under 100% is error logging switched off or pruned for part of the
  window, over 100% is a retried call failing twice against one failed request,
  and both are real readings. The rate stays on the card above, which reads the
  ledger.

  **The class is the finding, and the owner is why.** `RateLimitError` and
  `AuthenticationError` are one `failed_requests` upstream and two unrelated
  pieces of work, so each class is rendered with the party that can act on it —
  capacity, configuration, governance, latency, provider, caller, policy. Two of
  them (`auth`, `budget`) appear on no other surface on this page at all.

  **The deployment rows join to the health reading, and only in that
  direction.** The exception key is `CONCAT(litellm_model_name, '-', api_base)`
  and both halves contain hyphens, so it is rebuilt from a health row with
  `deploymentExceptionKey` and never split. A deployment the reading does not
  name reads **not in the reading** rather than healthy: an absent row is
  silence, which is the same rule the health strip follows for an unread night.

  **Three silences again, and the middle one is not a fault**: not read yet,
  refused (`disable_error_logs` or a non-admin credential), and
  answered-with-nothing — which the card words as *no errors recorded*, beside
  the failures the ledger counted over the same days, because the two are not
  the same claim.

  **It feeds no finding to the attention digest**, for the button's reason and
  one more: the fault it would name — a pool refusing on quota behind an alias
  that bills normally — is already the health card's `degraded` finding, and the
  digest never carries two findings about one key. What this card adds is the
  reason under that finding, which is why the two are read together.

- **The latency card is a rate beside a count, and states its unit rather than
  converting it.** It sits directly under the exception card, which is the third
  question about the same traffic: how many calls failed, why they failed, and
  how slowly the ones that succeeded came back. A deployment answering
  everything at a crawl fails nothing and bills normally, so it is invisible on
  both cards above it.

  **Seconds per completion token, and never a duration.** The proxy answers
  `AVG(seconds / completion_tokens)` over requests, so the card carries no
  percentile, no request duration and no SLA figure. Milliseconds per token is
  the same number with the decimal point moved; tokens per second is its
  reciprocal; multiplying by a token count would be a claim about completion
  length that this payload does not carry, and nothing on the card does it.

  **A median across keys, never a sum, and a thin day is dim rather than
  short.** Rates do not add, so the day's reading is a median of the keys that
  reported *that day* and the ones that did not are left out rather than filled
  in with the gateway figure. The strip carries height for the rate and opacity
  for how many keys reported, because a day where two of nine keys answered is a
  thin reading and drawing it at full strength would read as a fast one.

  **The badge is a materiality claim and says which gate stopped it.** The
  proxy averaged the request counts away, so no significance test is computable
  at all — `LATENCY_ELEVATED_RATIO` gated on `LATENCY_MIN_DAYS` is the whole
  test, and every unbadged row states whether it was the ratio or the evidence
  that rejected it, so a row that looks clean is never silently
  under-observed.

  **The health join has a fourth state, and this route forces it.** The
  exception key carries the backend model *and* the base; this one is the
  `api_base` alone whenever there is one, so several deployments behind a single
  endpoint collapse onto one key upstream. Where the reading disagrees among
  them the row reads **mixed** — attributing a slow reading to one of them would
  be picking, and the collapse cannot be undone from the payload. `unread` stays
  silence, exactly as it is on the exception card.

  **Three silences again**: not read yet, refused (`disable_spend_logs`, since
  this route reads the request log rather than the aggregates), and
  answered-with-nothing — which the query's own `HAVING SUM(completion_tokens) >
  0` and its exclusion of cache hits make an ordinary state for a window served
  from cache or spent on embeddings, and which is not the same claim as instant.

  **It feeds no finding to the attention digest**, for the button's reason
  rather than the exception card's: a source that is unread until somebody
  presses it would either report a blind spot on every visit or make the digest
  depend on whether anybody clicked. What it adds is evidence under an existing
  finding — a pool that is refusing *and* slow.

- **The hang card counts against a line it cannot see, and says so first.** It
  sits directly under the latency card and is the fourth question about the same
  window: how many calls failed, why, how slowly the rest came back per token —
  and here, how many ran for minutes and then answered anyway. That request is a
  success on the reliability card, silent on the exception card, and, if the
  answer was long, unremarkable on the latency card.

  **No duration, anywhere, ever.** The threshold is the proxy's own
  `alerting_threshold` and is not in the response, so the disclosure line leads
  with that rather than footnoting it: the count is "requests past this proxy's
  threshold", `SLOW_RESPONSE_DEFAULT_THRESHOLD_SECONDS` appears as prose about
  the likely configuration and never as a label on a reading, and the card
  states that the same workload on another proxy would answer a different
  number.

  **Every share is of the route's own denominator.** `total_count` is the
  request-log rows the proxy grouped with cache hits excluded, which is neither
  the ledger's request count nor a subset of it by a knowable margin. The
  ledger's figure for the same days is shown beside it as a ratio between two
  independently pruned tables — unclamped, like the exception card's
  `recordedShare` — and *nothing on the card is divided by it*.

  **Both badge gates, and this is the only live read that can afford them.**
  The payload carries hits and trials, so `wilsonScoreLowerBound` asks whether a
  difference is real and `SLOW_RESPONSE_ELEVATED_RATIO` asks whether it is worth
  an afternoon — the reliability card's design, where exceptions get no gate
  (no denominator) and latency gets one (the counts were averaged away). An
  unbadged row names which gate rejected it, because "two hangs out of three
  calls" and "0.6% against 0.53%" are opposite complaints.

  **The bucket takes no health verdict.** This route keys a row by the
  `api_base` alone with no fallback, so every deployment addressed by region
  rather than by URL is one `UNKEYED_DEPLOYMENT` row per sweep. It is not an
  endpoint, so the join does not run on it — `unkeyed`, a fifth state beside the
  latency card's four, and deliberately not matched against health rows that
  merely happen to carry no `api_base` either: two unrelated absences are not a
  match, and reading them as one would file a Bedrock fleet's hangs under
  whichever deployment this proxy failed to give a URL.

  **Most hangs and worst hang rate are different rows, and both are named.**
  Rows rank by hangs (the endpoint carrying the most of them is the one somebody
  acts on) while the bars are scaled to the highest *share*, because the busiest
  endpoint and the worst one are usually not the same one.

  **Three silences again**, and **it feeds no finding to the attention digest**
  — the button's reason, the same as the latency card's.

- **The hang history is the same sweep asked whether that number is the usual
  one.** `lib/metrics/gatewaySlowResponseHistory.ts` and
  `GatewaySlowResponseHistoryCard` read `gateway_slow_response_daily` through
  `summarizeSlowResponseHistory`, directly under the live card. It exists because
  the live read answers whatever window it is asked for and nothing else: a
  reader who presses the button sees 0.6% and has no way to know whether last
  week was 0.2% or 1.4%. It is the only one of the four live reads that *can*
  have a history — counts of disjoint request-log rows with their own
  denominator add across nights, where a mean of per-request ratios and a total
  with no denominator do not.

  Like both other history cards it adds **no rule about the gateway**: the
  summary is passed through verbatim (asserted as such in the harness), the badge
  is the live card's own two gates over the pooled counts, and the trend is the
  shared one. Three rules about the *drawing* are its own.

  **The spine is clamped forward to `recordingSince`.** There is no backfill for
  this table and cannot be — the sweep asks the proxy about one settled day and
  files the answer — so a 60-night window on a four-night recording draws four
  nights rather than 56 nights nobody read.

  **A night with no sweep is a hole**, in the gateway strip and in every
  endpoint's own strip. A refusal, `disable_spend_logs`, a backfill and a missed
  run all leave the same absence behind, and none of them is a night on which
  nothing hung. The gateway strip carries a second channel for the same reason
  the latency strip does: height is the night's pooled share, opacity is how many
  endpoints reported it, because a night two endpoints answered has a valid share
  that describes almost nothing.

  **Under `SLOW_RESPONSE_TREND_MIN_DAYS` observed nights the direction is
  withheld and the card says why.** The trend is the one thing this card adds
  over the live read, and drawing no direction on a four-night recording would
  read as "no change" — a fact about the age of the recording rather than about
  the gateway, exactly as "none standing" is on the health history.

  It **feeds no finding to the digest**, and unlike the live card the reason is
  not the button: the finding it would raise needs a threshold on a count against
  a line this dashboard cannot see, which is the open question the stored trend
  exists to answer once a real proxy is behind it.

- **The exception history is the same sweep asked what usually breaks.**
  `lib/metrics/gatewayExceptionHistory.ts` and `GatewayExceptionHistoryCard` read
  `gateway_exception_daily` and `gateway_exception_sweep` through
  `summarizeExceptionHistory`, directly under the live exception card. It exists
  for the hang history's reason restated over a different quantity: the live read
  answers whatever window it is asked for, so "42% of what we recorded was rate
  limits" is a good answer with no way to know whether last week was 8% or 60%.

  Like every other history card it adds **no rule about the gateway** — the
  shared summary is passed through verbatim, asserted as deep equality in the
  harness rather than as a convention — and three about the *drawing*, two of
  which the two sibling cards already have and one of which is this layer's own.

  **The spine is clamped forward to `recordingSince`,** which here is taken from
  the *receipts* rather than from the rows: the first night we looked is the
  honest start of the recording, and it may well be a night on which nothing
  failed.

  **A night with no sweep is a hole, and a swept night that found nothing is
  drawn.** This is the one drawing rule the receipt table exists for. Every other
  history layer here can read "no rows" as "nothing was happening", because its
  route answers a row per object with traffic; this route answers rows only where
  something faulted, so a clean gateway and a refused sweep leave the identical
  empty list behind. The gateway strip and every class strip therefore carry three
  states, and a clean night is a **finding** rather than an absence — it is drawn,
  counted, and reported in its own stat.

  **Under `EXCEPTION_TREND_MIN_DAYS` swept nights the mix shift is withheld and
  the card says why** — and the withheld sentence is several sentences, because
  the silences differ: too few nights to split, a half that recorded nothing (a
  mix cannot be compared against no mix), a class the split did not see, and a
  class *new* in the recent half are four different readings. There is no badge
  anywhere on the card to explain, since a layer with no denominator has nothing
  to be significant against, so the withheld direction is the only silence a
  reader meets.

  It **feeds no finding to the digest**, for the live card's reason and one more
  of its own: a standing fault names the deployment tonight's health reading is
  already reporting, and the only quantity that could carry an alert here — a
  rise in the count — moves with traffic.

- **The latency history is the same sweep asked whether that rate is the usual
  one.** `lib/metrics/gatewayLatencyHistory.ts` and `GatewayLatencyHistoryCard`
  read `gateway_latency_daily` through `summarizeLatencyHistory`, directly under
  the live latency card. It exists for the reason the two sibling histories do —
  the live route aggregates whatever window it is handed and has no memory, so a
  reader who presses the button sees 7.3 ms/tok and no way to know whether last
  week was 4 or 12 — and it is kept on a **narrower licence** than either of
  them: nothing here adds, so the rows may be compared and never pooled, exactly
  as the deployment-health recording is.

  Like every other history card it adds **no rule about the gateway**: the shared
  summary is passed through verbatim (asserted as deep equality in the harness),
  the badge is the live card's own ratio gated on days observed — there is no
  significance test, because this payload carries no counts anywhere — and the
  trend is the shared one. Three rules about the *drawing* are its own.

  **The spine is clamped forward to `recordingSince`,** the three sibling cards'
  rule for the same reason: there is no backfill for this table and cannot be, so
  a 60-night window on a four-night recording draws four.

  **A night with no reading is a hole, and the third cell state is not "clean".**
  There is no clean reading here — only a fast one, a slow one and a night nobody
  read — so a cell that carries a reading is drawn against the pair's **own**
  median rather than the gateway's, because the row's ratio column already
  answers "slow for the gateway" and the strip is the only place that can answer
  "slow for itself". The gateway strip carries the live card's second channel:
  height is the night's median, opacity is how many pairs reported it, since a
  night two of nine endpoints answered has a valid median that describes almost
  nothing.

  **Under `LATENCY_TREND_MIN_DAYS` observed nights the direction is withheld and
  the card says which silence it is.** With no badge to explain (this layer has
  no denominator to be significant against) the withheld trend is the card's only
  silence, so it is the one that has to be named.

  It **feeds no finding to the digest**, and unlike the live card the reason is
  not the button: a standing fault names the deployment tonight's health snapshot
  is already reporting as `down` or `degraded`, and a rise in this number can be
  a classifier answering in one token rather than a backend that got slower —
  which is open question 20 and needs a real proxy.

- **The page is eight named sections with a nav, and the nav is derived rather
  than written.** Twenty-four cards accumulated one under another, each placed
  directly beneath the card it argues with, which makes the page readable top to
  bottom and unusable to somebody arriving with a question. `lib/gatewaySections.ts`
  is the one statement of the structure — Overview, Governance, Statements,
  Spend, Operations, Efficiency, Adoption, Requests — and three rules keep it
  from becoming a second opinion about the gateway.

  **It lists only what rendered.** More than half the cards stand themselves
  down (no cache activity, no sealed month, no MCP traffic, a recording that has
  not started), so the nav is derived from the page's own presence map — the
  identical `has*` predicates the JSX is gated on, written once and read twice.
  A chip pointing at an empty wrapper is the same failure the anchor comment
  already names: worse than no chip.

  **It never re-ranks.** Sections come back in page order however busy they are.
  A nav that floated the section with findings to the front would move under the
  reader between two visits, and the digest immediately below it already carries
  "look here first" *with the numbers behind it*.

  **The count beside a section is cards, not findings.** Counting findings would
  be a second digest computed a second way, which is precisely the two-answers
  failure `gatewayAlerts.ts` exists to prevent.

  Two orderings changed with it, both because a section forces the question. The
  **breakdown switcher moved above** reliability, the anomaly attribution and the
  movers list, since all three read whichever dimension it selects and a control
  below the things it governs reads as a filter nobody applied; and the **request
  sample moved last**, where the one card that reads individual calls belongs.
  The card anchors are the same ids the digest scrolls to, extended to the cards
  nothing pointed at yet, and the section headings are separate ids so a
  one-card section lands on the heading that names it rather than mid-card.

`apps/api/scripts/verify-gateway-sections.ts` covers that model, and the half
worth having is textual rather than pure: the section list and the page are two
files that must agree on a set of string ids and nothing in the type system
connects them, so a card renamed on one side typechecks, builds, and renders a
chip that scrolls nowhere. It asserts every declared anchor appears as an `id=`
on the page exactly once, every `gateway-*` id on the page is declared, both
agree on *order*, every anchor carries an entry in the presence map, one heading
is rendered per section in the declared order, and every anchor the **digest**
scrolls to is still one of them. The pure half pins the three rules above: the
declared order survives an arbitrary presence-map key order, a section whose
every card stood down is dropped rather than listed empty while the rest keep
their order, a partly-drawn section reports the difference as `hidden`, and an
anchor nobody declared cannot add itself. Run it with
`node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-sections.ts`
(no env needed — it touches no database and no proxy).

`apps/api/scripts/verify-gateway-health-history-view.ts` covers what the *page*
does with those readings, and only that: `verify-gateway-health-history.ts`
already pins the recording and the shared sequence rule. The pure half constructs
the histories a dev database does not have — a spine clamped forward to
`recordingSince` and one that must not stretch backwards; a three-state strip
where the unread night is a hole carrying no error while the failing cell carries
the proxy's own text; `tooShort` on both sides of its boundary, with "none
standing" only meaning a clean gateway on the far side of it; every verdict
against the shared summary that produced it (standing, failing-but-short,
newly-failing, flapping, recovered, historic, clear) plus the row order taken
from the shared derivation rather than re-sorted; a five-calendar-day run with
two readings that must report two, with three unread nights inside it and exactly
one run; and a second deployment that only appeared mid-window, which must carry
no missing readings from before it existed while still stacking on the shared
spine. The Postgres half runs the same derivation over what a sync actually
stored and checks the two things only real rows can: every row's non-hole cells
are exactly the readings filed, and **today's snapshot and today's appended
readings name the same failing deployments** — two tables, one reading. Run it
with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-health-history-view.ts`.

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
uncapped last ranked by dollars), the scope separation (key, team, tag and user
ids never collide, so the four scopes can never merge), and the pace projection in
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
is classified as.

The user scope gets a section for the opposite reason the tag scope does: not a
rule about the counter, but a rule about which objects exist at all. The governed
users must be a *strict* subset of the people the usage side reports — a proxy
caps a handful and the rest are a directory this table has no business holding —
and their ids must collide with no key, team or tag. The states are checked
against what the generator planted: the capped user on the deliberately uncapped
key (the contrast that is the scope's whole argument — that user's cap is the
only governance over the gateway's largest workload), a rate-limited user who is
governed *and* uncapped and must draw a row with no bar rather than vanish, a
user budgeted at exactly `$0` classified as blocked with `zero-cap` as the reason,
and two different periods inside one scope. Run it with
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

`apps/api/scripts/verify-gateway-notify.ts` covers gateway *alerting* — both
sources — and it is the only script here whose subject is a side effect rather
than a number: the question is not whether a finding is right but whether it is
sent, once, at the right moment. Three halves. The **pure** one pins which states
travel (`blocked`,
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
again.

The health source is checked the same way twice over, because its findings are a
*partition of a snapshot* rather than a ranking over a window: on constructed
readings (an alias with everything failing is down, one with a survivor is
degraded, a healthy one produces nothing, an unnamed failing deployment still
produces a finding under the shared bucket key, exactly one finding per failing
alias, critical sorted first, a fingerprint that survives a third region joining
the outage and changes when the alias falls over), and then on planted rows in
Postgres — where a deployment finding is recorded with a *null* counter and its
reading in `detail` (a $0.00 on a webhook message would read as a budget nobody
spent against), a spreading outage updates the row without sending again,
`degraded → down` closes the old episode and sends the new one, and a recovery
closes silently. The last of those is the rule the second source added: the
health rows are removed for one run, and the open outage must **still be open**
afterwards, because a table nobody read is not a recovery.

It plants budget rows and deployment rows under a `verify-notify-` prefix and
removes them.
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

`/model/metrics` gets a section of its own, and what it pins first is again the
parameter that fails quietly: `_selected_model_group` must be on the wire for
every call, because its upstream default is the literal `"gpt-4-32k"` and a call
without it answers `200` with an empty gateway. Then the envelope's own rules —
one call per alias with no wildcard, the window as datetimes ending at the end
of the last day, each day's numeric keys becoming one reading per deployment
with the value carried through unconverted, a non-numeric extra ignored, a
`null` average dropped (unmeasured is not instant), a row whose `date` is not an
ISO day dropped rather than placed by guesswork, both branches of
`latencyDeploymentKey` live in one sweep (an Azure base and a Bedrock model
string), and `all_api_bases` merged across the sweep as evidence. Three silences
are kept apart at the end: a bare `null` body and an empty envelope are both
*available with nothing to report*, while 401/403/404/405/501 stand the sweep
down after one call — `disable_spend_logs` empties this route too — and a
malformed envelope still throws rather than reporting a fast gateway.

`/model/metrics/slow_responses` gets a section beside it, and what it pins is
the envelope this integration has not seen before: a **bare array**, so an
enveloped `{"data": []}` throws rather than reading as an empty answer, while a
bare `null` and an empty array are both *available with nothing to report*. Then
the route's own rules — `_selected_model_group` on every call for the third
time, the window as datetimes, a count handed back as the string a `bigint`
driver produces read as the number it is, a row with no `total_count` dropped
because the total is this layer's only denominator, a `slow_count` past the
total clamped since the SQL cannot produce one, a null `api_base` landing in
`UNKEYED_DEPLOYMENT` with a name rather than a blank key, and the `/openai/` cut
landing on the same key a health row rebuilds. 401/403/404/405/501 stand the
sweep down after one call, exactly as on its two siblings.

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

`apps/api/scripts/verify-gateway-exceptions.ts` covers the exception layer in
the same two halves. The **pure** half pins the classification — every LiteLLM
exception class maps to the party that can act on it, a prefixed
`litellm.RateLimitError` is the same fault as a bare one, a
`ContextWindowExceededError` is the *caller's* fault rather than a capacity one
(it is a 400), and a class this build has never seen is `other` under its own
name rather than a near-match — and the roll-up: the class counts partition the
window exactly, a class spanning two deployments is added across them and
reports how many produced it, and the total is ours rather than the proxy's
`total_exceptions`, which the fixture reproduces as the class count it really
is. The **mock** half drives `fetchModelExceptions` and checks the claim the
layer exists for, which is a claim about the *other* cards: the refusing
reserved-throughput pool behind `azure/gpt-4o` produces thousands of rate limits
while the alias in front of it stays unremarkable in the ledger — below the 1.5×
materiality gate the reliability card would need to badge it — and bills
normally every day. The contrast case is checked beside it: the throttled
`azure/o4-mini` is elevated in the ledger *and* named as a quota here, which is
the difference between a finding and its reason. Two classes that appear nowhere
else on the page are pinned (a rotated credential as `auth`, an enforced cap as
`budget`), the incident days come back as backend faults rather than as more of
the ordinary mix, an alias the proxy never routed records nothing, and the same
window asked twice answers identically. The last check is the invariant itself:
the exception total and the ledger's `failed_requests` disagree, on purpose. Run
it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-exceptions.ts`.

`apps/api/scripts/verify-gateway-latency.ts` covers the latency layer in the
same two halves. The **pure** half pins the two rules the payload forces. The
first is the key: `latencyDeploymentKey` reproduces LiteLLM's own collapse — a
deployment with a URL is keyed by the URL, one without is keyed by its backend
model string, everything from `/openai/` onwards is cut, a base that is not a
URL is not a key at all, and two models behind one endpoint land on one key,
which is a fact about the proxy rather than a bug to repair. The second is the
badge: a key 1.5× the median on enough days is flagged, the same rate on one day
is not, and a key above the median but under the ratio reports the ratio and no
badge — with the fixture built so the median itself is *not* dragged by the
outliers it is meant to find, which is the argument for a median. The roll-up is
checked around them (means unweighted, points sorted, the daily reading a median
across keys and never a sum, a zero rate dropped rather than ranked as instant)
and so are the two silences: a refused route is never an empty one. The **mock**
half drives `fetchModelLatency` and checks the claim the layer adds to the other
cards: the reserved pool behind `azure/gpt-4o` is measurably slower than the
sibling behind the same alias and is the deployment the badge lands on, while
the alias in front of it bills every day and fails ordinarily — so the same
deployment `/health` calls failing and the exception log calls rate-limited is
slow on a third, independent payload. The reasoning deployment is checked as the
contrast (slower than the median, deliberately under the gate, which is what
makes the badge a finding), a Bedrock deployment's worst day is an incident day,
both key branches appear in one payload, and the same window asked twice answers
identically. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-latency.ts`.

`apps/api/scripts/verify-gateway-slow-responses.ts` covers the hang counter in
the same two halves. The **pure** half pins the key rule
(`slowResponseDeploymentKey` reproduces the route's own `api_base or ""`
grouping, including the `/openai/` cut, a non-URL base that is still a key, and
the unnamed bucket that has no equivalent on either sibling), the roll-up (two
aliases behind one endpoint are one row with both aliases kept and their counts
*added*, since these are disjoint request counts rather than rates; the
gateway-wide share is the sweep's own and never the ledger's; a key the route
grouped nothing under is dropped rather than rendered as 0% of no calls), and
both badge gates from both sides: a key five times the gateway rate over twenty
thousand calls is badged, one hang out of three calls clears the ratio by two
orders of magnitude and is refused by the minimum-count floor, and a key that is
*certainly* worse by four hundredths of a point clears the interval and is
refused by the ratio. The **mock** half drives `fetchModelSlowResponses` and
checks the three planted shapes: the refusing reserved pool queues before it
gives up and is the one key badged, several times the gateway rate; the whole
Bedrock fleet arrives as a single unnamed row because the proxy grouped it that
way, with the two-day incident inside it averaging away below the badge exactly
as it does on the reliability card; and the reasoning deployment is diluted into
the endpoint it shares rather than flagged. The sweep's denominator is checked
against the ledger's request count and must be *short* of it, since cache hits
are excluded upstream. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-slow-responses.ts`.

`apps/api/scripts/verify-gateway-exceptions-view.ts` covers what the *page* does
with those rows. Its **pure** half keeps the three silences apart (unread,
refused, answered-with-nothing — and only the last is about the gateway), pins
the roll-up the card draws (class shares summing to one over what was recorded,
the dominant class carrying its owner, deployments ranked by their own totals),
and holds the two rules that are easiest to soften: the ledger comparison is
reported unclamped — a fixture where the exception count *exceeds* the ledger's
failures must read past 100% rather than being trimmed to it — and the join to
`gateway_deployment_health` is one-directional, with a deployment the reading
does not name reported as unread rather than healthy, including the
details-stripped case where `api_base` is null and the key is the backend alone.
The window rules are checked on the spine rather than on the picker, and the
skipped aliases survive the derivation. The **mock** half drives
`fetchModelExceptions` and `fetchHealth` together and checks the claim the card
exists to make: the reserved-throughput pool the health reading finds failing is
the same deployment the exception log names, it is rate limits and almost
nothing else, its sibling behind the same alias is healthy — which is why the
alias reads as ordinary everywhere else — and the exception total disagrees with
the ledger's failures for the window, which is the disagreement the card shows
rather than reconciles. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-exceptions-view.ts`.

`apps/api/scripts/verify-gateway-latency-view.ts` covers what the *page* does
with the latency readings, and its centre of gravity is the join. The **pure**
half keeps the three silences apart (unread, refused, measured-nothing — and the
last one is the query's own `HAVING SUM(completion_tokens) > 0` and its exclusion
of cache hits rather than a fast gateway), pins the window as the tail of the
trimmed spine under the route's own cap, checks the roll-up the card draws (rows
slowest first, the gateway figure a median of key means, the daily reading a
median across the keys that reported *that day* with an absent key never filled
in with the gateway number, and coverage carried per day so a thin reading is
dim rather than short), and drives the badge from both sides — a key over the
ratio on enough days is badged, the *slowest* key of all is not because it was
seen twice, and `latencyBadgeReason` names which gate stopped it so a row that
looks clean is not silently under-evidenced. The join gets four cases because
this key forces a fourth state: `failing`, `healthy`, `unread` for a deployment
the reading does not name (including the details-stripped case where `api_base`
is null), and **`mixed`** where one `api_base` fronts deployments the reading
disagrees about — with the neighbouring case that a base whose deployments are
*all* failing is `failing`, so `mixed` stays disagreement rather than
multiplicity. The **mock** half drives `fetchModelLatency` and `fetchHealth`
together and checks the claim the card exists to make: the reserved-throughput
pool is measurably slower than the sibling behind the same alias, badged, and
named by the health reading with its own quota error — the same deployment on a
third independent payload — while the sibling is not failing, which is why the
alias reads as ordinary everywhere else. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-latency-view.ts`.

`apps/api/scripts/verify-gateway-slow-responses-view.ts` covers what the *page*
does with the hang counts, and its centre of gravity is again the join — for the
opposite reason to the latency one. The **pure** half keeps the three silences
apart, pins the window as the tail of the trimmed spine under the route's own
cap, and checks the roll-up the card draws: one endpoint answering two aliases
is one row with both aliases kept and the counts *added*, the gateway rate is
the sweep's own, the per-key shares of all hangs sum to one, and the row with
the most hangs and the row with the highest hang *share* are asserted to be
different rows, since scaling the bars by the first would flatten the second.
Both badge gates are driven from both sides on a fixture built so the gateway
rate is not itself dragged by the key under test: a key 7.5× the rate over 400
hangs is badged, the highest share in the window (two of three calls) is refused
by the minimum-count floor, a key that is *certainly* worse and only 1.13× is
refused by the ratio, and a key below the gateway rate is refused by the
interval — with `slowResponseBadgeReason` asserted to name a different gate in
each case. The ledger comparison is checked to move nothing on the card, to read
past 100% unclamped, and to be absent rather than zero where the spine does not
cover the window. The join gets five states, and the one this route forces is
the point: the `api_base`-less bucket reads **`unkeyed`** even when the health
reading carries a deployment with no `api_base` of its own, which would
otherwise look exactly like a match. The **mock** half drives
`fetchModelSlowResponses` and `fetchHealth` together: the refusing PTU pool is
the one badged key and the reading names the same endpoint (a third independent
payload about one deployment, after the error log and the latency aggregate),
the two-day incident averages away below the badge, the whole Bedrock fleet
arrives as one unattributable bucket, and the sweep's denominator is *short* of
the ledger's requests for the same days. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-slow-responses-view.ts`.

`apps/api/scripts/verify-gateway-slow-response-history.ts` covers the **stored**
roll-up, which is the same counts asked a different question. The **pure** half
drives `summarizeSlowResponseHistory` over constructed readings: two aliases
swept the same night are one day of the series with their counts added and the
night reporting one key and two aliases, a night with a reading and no hangs is
*observed* rather than a gap, the worst night is the highest share rather than
the highest count, and the signed excess still sums to zero across the keys. Both
badge gates are driven from all four sides over pooled counts on a fixture whose
baseline keys carry the traffic — the trap iterations 42, 43 and 45 each hit with
a median and a share. The unobserved-day arithmetic is checked in three
directions (gaps counted forward from `recordingSince`, a window that mostly
predates the recording reporting none, a recording starting after the window
reporting none), and the trend in five: withheld under
`SLOW_RESPONSE_TREND_MIN_DAYS`, split into adjacent halves of observed nights
with the odd one going to the recent half, measured in percentage points, and —
on a fixture built so the two disagree in *sign* — pooled rather than averaged
across nights. The **mock** half simulates twelve nightly syncs by asking
`fetchModelSlowResponses` for one day at a time exactly as `readSlowResponses`
does, over a run of nights chosen to contain the planted regional incident: the
nights add back up to what one sweep of the same window reports, the refusing PTU
pool is still the only badged key over the accumulated window, and the incident
nights read materially worse than the ordinary ones — which is the finding the
table exists for, since a month-long window averages them into the provider's
ordinary rate. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-slow-response-history.ts`.

`apps/api/scripts/verify-gateway-exception-history.ts` covers the **stored**
exception roll-up (56 checks). Most of the pure half restates the hang history's
arithmetic over a different quantity — counts pooling across aliases, deployments
and nights, shares summing to one on both cuts, gaps counted forward from
`recordingSince`, halves split on observed nights — and the checks concentrate on
the two things that are this layer's own. The **receipt** is driven from three
sides: a night swept with nothing found reads as `clean` with a total of zero and
is an observed night, a night with neither rows nor receipt is absent from the
series and counted as a gap, and rows arriving without a receipt are still taken
as evidence the sweep ran. The **mix shift** is driven from six: withheld under
`EXCEPTION_TREND_MIN_DAYS`, withheld when a half recorded nothing at all,
measured in percentage points that sum to zero across the classes, ordered by the
size of the move, reported identically by the trend and the per-class rows, and —
the property the whole design rests on — *unchanged* when the recent half's
counts are multiplied by ten, which is what a count trend on a denominator-less
table would get wrong. The **mock** half simulates twelve nightly sweeps by
asking `fetchModelExceptions` for one day at a time exactly as `readExceptions`
does, over a run of nights containing the planted regional incident: the nights
add back up to one sweep of the same window within rounding, the refusing PTU
pool is 96% rate limits, and the incident nights carry a materially larger
*backend* share of the mix — a change in what broke rather than in how much,
which a month-long window dissolves. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-exception-history.ts`.

`apps/api/scripts/verify-gateway-latency-history.ts` covers the **stored**
latency roll-up (49 checks), and what it exists to prove is that this table's
narrower licence holds in the arithmetic rather than only in the prose. The
**pure** half drives `summarizeLatencyHistory` over constructed readings: a
night's figure is the median across the pairs that reported and provably not
their sum, two aliases behind one endpoint stay two rows (the opposite of the
hang history, asserted as such), a night swept twice keeps the later reading and
never the mean of the two, a pair reads at the median of its nights so one
incident night is not its standing rate, and a zero, a negative and a NaN are all
dropped rather than read as instant deployments. The **badge** is driven from
three sides over a fixture with five baseline pairs — so the median the ratios
are taken against is not dragged by the rows under test, the trap every badged
layer in this repo has now hit five times — and the gap arithmetic from three:
inside a pair's own first-to-last span, across the window, and forward from
`recordingSince`. The **trend** is driven from five, including the property the
design rests on: a night reported by six keys reads *exactly* as a night reported
by one carrying the same values, since a sample with no weights cannot be pooled
— which is the same shape of check as the exception layer's "multiply the recent
half by ten" and the arithmetic reason this table stores no totals. The **mock**
half sweeps `fetchModelLatency` one night at a time exactly as `readLatency`
does, round-trips every reading through the nano encoding the column stores, and
then checks the claim the table exists for: the two-day regional incident is
visible as its own nights while the same days average away inside a month-long
window read, the refusing reserved pool is the badged key while its sibling
behind the same alias is not, and the deliberately slower reasoning deployment
reads above the median and stays under the badge. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-latency-history.ts`.

`apps/api/scripts/verify-gateway-slow-response-history-view.ts` covers what the
*card* does with those stored nights, and nothing the shared roll-up already
states. The **pure** half asserts the summary is passed through verbatim (deep
equality against `summarizeSlowResponseHistory`, so the "no rule about the
gateway" claim is checked rather than conventional), keeps the two silences apart
(a query in flight claims nothing; an empty table has *answered* and stands the
card down rather than drawing the strip a quiet gateway would draw), pins the
spine in both directions (a 60-night window on a four-night recording draws four;
a recording older than the window leaves the window alone and its unread nights
are counted as missed), and drives the three cell states including the one that
matters — an unread night carries no share and no denominator, and the same hole
appears in the gateway strip. Two aliases behind one endpoint on one night are
asserted to *add* into one cell, and every row to pool to exactly what its own
cells carry, so the strip and the number cannot disagree. `tooShort` is checked
on both sides of `SLOW_RESPONSE_TREND_MIN_DAYS` and against a sparse window,
where the gate counts nights *read* rather than nights elapsed. All four badge
branches are driven on a fixture whose baseline keys carry the traffic — the trap
iterations 42, 43, 45 and 46 each hit — with `hangBadgeReason` asserted to
produce four distinct sentences, since "not badged" means "inside the noise",
"not material" or "barely seen". The **mock** half simulates twelve nightly syncs
exactly as `readSlowResponses` does and draws the result: one cell per drawn
night on every row, the rows pooling to their cells and the nights to the window,
the refusing PTU pool the only badged endpoint, and the worst night one of the
two the mock plants a regional incident on. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-slow-response-history-view.ts`.

`apps/api/scripts/verify-gateway-latency-history-view.ts` covers what the *page*
does with the stored readings, and only that: `verify-gateway-latency-history.ts`
already pins the recording and the shared median rule. Fifty-four checks in two
halves. The pure half asserts the summary passes through as deep equality; the
spine clamped forward to `recordingSince` and refusing to stretch backwards past
the window; the three cell states with the unread night carrying no reading at
all (`fast, fast, slow, unread`, where the slow cell is measured against the
pair's own median); the pair grain, where two aliases behind one endpoint stay
two rows carrying their own readings rather than one row carrying the endpoint
mean; a night swept twice drawing the later reading and never the mean of the
two; `tooShort` on both sides of `LATENCY_TREND_MIN_DAYS` and against a sparse
month-long spine, with the withheld sentence naming which silence it is; both
badge gates from both sides over a fixture whose five baseline pairs own the
gateway median, producing three distinct reason sentences; and the health join in
all four states including `mixed`. The mock half sweeps twelve nights one at a
time exactly as `readLatency` does, then draws them: every row's median is the
median of exactly its own drawn cells, every night reports how many pairs and
aliases produced it, no reading round-trips to zero, and every pair the nightly
sweeps stored is a pair the same window answered in one call. Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-latency-history-view.ts`.

`apps/api/scripts/verify-gateway-exception-history-view.ts` covers what the
*card* adds over the recording, and only that — `verify-gateway-exception-history.ts`
already pins the stored sweep and the shared summarizer. 48 checks in two halves.
The pure half constructs the histories a dev database does not have: the three
silences (in flight, nothing ever swept, and a run of swept-but-clean nights,
which is the one this layer can *report*); the summary passing through as deep
equality; the spine clamped forward and refusing to stretch backwards; a
four-night run reading recorded / clean / recorded / unread in the gateway strip
and in a class's own strip; every class's cells summing to its window count;
`tooShort` on both sides of `EXCEPTION_TREND_MIN_DAYS` and against a window swept
five nights of nine; four distinct withheld-or-stated sentences; and the health
join in all three states, with `unread` never reading as healthy. The mock half
sweeps twelve nights one at a time exactly as `readExceptions` does, filing a
receipt per night, and proves the planted 17th/18th regional incident is the
window's worst night, reads as a **backend**-class night rather than as more of
everything, and that the nights and the classes both sum back to the window total.
Run it with
`set -a; . ./.env; set +a; node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-exception-history-view.ts`.

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

17. **Does this proxy write error logs, and is `/model/metrics/exceptions`
    granted to this credential?** `disable_error_logs` is the twin of
    `disable_spend_logs`, the route is admin-scoped, and both answers are
    legitimate — but they are indistinguishable from the outside once the route
    answers: a proxy that logs no errors and a gateway with no errors both
    return an empty list. If error logging is off, the exception layer says
    nothing and the reliability card remains the only reliability reading there
    is.

18. **Does `total_exceptions` still count classes rather than exceptions?** It
    does in the current source (a `COUNT(*)` over a CTE already grouped by
    class), and the client therefore sums the class counts itself. If a later
    version fixes it, nothing here breaks — the field is carried as evidence and
    never read as a total — but the two figures agreeing would become the
    signal that the upstream bug is gone.

19. **Does `/model/metrics` answer fast enough on a corporate gateway, and does
    it still key by `api_base`?** The query is a grouped scan of
    `LiteLLM_SpendLogs` — the largest table the proxy keeps — filtered to one
    `model_group` and a window of weeks, so a sweep is a dozen of them back to
    back. The client gives each call a minute and the API caps the window at 31
    days, but whether that is generous or hopeless on a gateway with a hundred
    million log rows is not answerable from here. The second half matters more
    for what the numbers *mean*: two deployments behind one Azure endpoint
    collapse onto one key upstream, so on a proxy that fronts several models per
    endpoint the per-deployment reading is really a per-endpoint one. The way to
    tell is to compare the key count here against the deployment count in
    `/health` on the same proxy.

20. **Is the per-token average comparable across this gateway's workloads?** It
    is a mean of per-request ratios, so a deployment answering one-token
    classifications reads slower per token than the same hardware writing long
    documents, and the difference is the connection overhead rather than the
    model. That is fine for comparing a deployment against itself over time and
    against its siblings behind the same alias — which is what the badge does —
    and it is why nothing here ranks two *aliases* against each other as "the
    slow one". Whether the corporate mix is uniform enough that the ranking
    reads sensibly anyway is a question for a real payload.

21. **What is this proxy's `alerting_threshold`, and has anybody set one?**
    `/model/metrics/slow_responses` compares against
    `slack_alerting_instance.alerting_threshold` and falls back to 300 seconds,
    and the response says nothing about which was used. A gateway whose Slack
    alerting was never configured is therefore counting five-minute calls, which
    on a corporate proxy fronting reasoning models may be a handful a month or
    may be a whole workload. The number is knowable from the proxy's config
    rather than from the API, so it is a question to ask the person who runs it
    — and until somebody has, nothing on this side may print a duration beside
    the count.

22. **Does `api_base`-only grouping leave anything unnamed that matters?** Every
    deployment without a URL collapses into one bucket per alias, which on this
    draft's mock means the entire Bedrock fleet. If the real gateway's Bedrock
    and Vertex traffic is a large share of the bill, the most interesting row on
    the card is also the one row that cannot be attributed to a deployment — and
    the only routes that can split it (`/spend/logs`' `model_id`, `/health`'s own
    rows) are a sample and a snapshot rather than a window.

## Not yet built

Governance is now rendered end to end across all four scopes
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

- **Per-user governance beyond the caps somebody set.** `/user/list` now feeds
  a fourth budget scope, but only for users carrying an actual limit — an
  uncapped user is a person, not a governance object, and the roster is the staff
  directory. What that leaves unbuilt is any read of the *ungoverned* population
  from this route: `user_role`, team membership and the key count each user
  holds are all on the payload and none of them are stored, because they are
  identity facts rather than governance ones and the place they would belong is
  the cost-centre join that open questions 2 and 4 block. The `user` usage
  dimension already answers "who spent what".

- **Budget history beyond what we recorded.** `gateway_budget_history` now
  answers "was this key already over last week" — but only back to the first
  sync that wrote it, and only at daily resolution. Neither limit can be lifted
  from here: the proxy serves current state and has nothing older to give, and a
  finer sample would mean syncing more often for no other reason.
- **Alerting beyond the two tables.** Budget findings and deployment-health
  findings now leave the dashboard: every full sync evaluates both snapshots,
  records each finding as an episode in `gateway_notification`, and POSTs the
  undelivered ones to `GATEWAY_ALERT_WEBHOOK_URL`. The remaining digest sources
  cannot follow them there, and the reason is structural rather than a missing
  feature: anomalies, reliability, cache churn and coverage gaps are derived in
  the *browser* from the usage payload over the range on screen, so sending them
  would mean either running those derivations server-side (a second
  implementation of four modules, i.e. precisely the two-answers failure the
  digest exists to prevent) or moving them into `@dash/shared` and giving the API
  a range to evaluate them over — which is a real design question, since "what
  range" has no obvious answer for a nightly job. Two things are deliberately
  *not* sent from the sources that do travel: a recovery ("the key is under its
  cap again", "the region is back"), and a standing fault from
  `gateway_deployment_health_history`, which would name a deployment tonight's
  snapshot is already reporting. Delivery itself is also deliberately thin: one
  URL, one POST, no per-recipient routing, no severity filter and no quiet hours.
  Each of those is a policy somebody has to actually want before it is worth
  encoding.
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

- **A view on the outage history.** Built: `Deployment health over time`
  (`lib/metrics/gatewayHealthHistory.ts` over
  `GET /api/gateway/health/history`) draws the recording under the snapshot
  card, so "was this deployment already failing last Tuesday" is now answered on
  the page. What it cannot do is answer it further back than the first sync that
  wrote a row — there is no backfill and cannot be one, since the proxy serves
  current state only, which is why the spine is clamped forward and a short
  recording says so rather than reporting a clean sheet.

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

- **Alerting on a reason.** The stored roll-up now exists:
  `gateway_exception_daily` holds one night per (alias, deployment, type),
  `gateway_exception_sweep` records that the sweep ran at all, the full sync
  appends yesterday's sweep to both, and
  `GET /api/gateway/exceptions/history` serves them through
  `summarizeExceptionHistory` with a per-night series, both roll-ups and a
  half-over-half **mix shift**. That crosses the boundary the latency layer is
  still on the wrong side of — there is now a *table* for
  `services/gateway-notify.ts` to assess after a sync.

  The **view** on those nights is now built too: `What broke over time`
  (`lib/metrics/gatewayExceptionHistory.ts`) draws the recording under the live
  card — a spine clamped forward to `recordingSince`, a night with no sweep as a
  hole against a swept-but-clean night as a drawn zero, one strip per class, and
  the mix shift in points with the withheld case saying which silence it is.

  What remains is the finding that *travels*, and it is the real question rather
  than a missing feature — the one the mix shift exists to answer: whether a
  corporate gateway's error mix is stable enough night to night that a move in it
  is worth waking somebody, or whether it follows the workload closely enough
  that a team shipping a new prompt would page the on-call. The stored trend is
  the evidence and it needs a real proxy behind it. Note what would *not* be
  alertable either way: a rise in the count. The layer has no denominator, so more
  exceptions is indistinguishable from more traffic — and a standing fault would
  name the deployment tonight's health snapshot is already reporting, which is the
  rule that keeps the health *history* out of the digest as well.

  Two smaller things the live card deliberately leaves out and the stored one
  does not change: there is no per-class daily strip on it (the route answers a
  window, not a series — the *history* is where a series comes from), and no
  `elevated` badge anywhere in either, because significance would have to be
  borrowed from the ledger and a badge whose numbers come from a different table
  is exactly the disagreement the digest rule exists to prevent.

- **Alerting on how slow something is, and a latency trend.** The latency layer
  is now read end to end — `GET /api/gateway/latency` sweeps the window's
  aliases, and the `How slowly the backends answered` card renders the per-day
  median, the deployment keys ranked slowest first and the join to tonight's
  health reading. What remains is bounded by the layer rather than pending.

  The nightly roll-up now exists: `gateway_latency_daily` holds one reading per
  (night, alias, deployment key), the full sync appends the window's last day to
  it, and `GET /api/gateway/latency/history` serves it through
  `summarizeLatencyHistory`. That crosses the boundary this layer was on the
  wrong side of — there is now a *table* for `services/gateway-notify.ts` to
  assess after a sync — and it settles the *trend* limitation too: the route
  answers a window, but a sequence of nightly windows is a series, which is where
  the half-over-half ratio comes from.

  The **view** on the recording now exists too: `Latency over time`
  (`lib/metrics/gatewayLatencyHistory.ts`) draws the nightly medians under the
  live card with the three drawing rules the sibling histories forced — a spine
  clamped forward to `recordingSince`, an unread night as a hole rather than a
  fast cell, and a withheld trend that says which silence it is. What is still
  not built is the one thing that is a decision rather than a drawing: no finding
  **travels**: an episode key would be `latency:model:<endpoint>`, and
  the first question a latency alert raises is the one the stored trend exists to
  answer — whether a corporate gateway's per-token rate is stable enough night to
  night that a change in it is a finding, or whether it moves with the workload
  mix (a team shipping a classifier that answers in one token drags the average
  without anything having got slower), which is open question 20 and needs a real
  proxy.

  What the storage deliberately does *not* buy is any arithmetic the payload
  refuses. The readings are kept to be compared, never pooled: there is no total,
  no weighted mean, no "requests behind this number", because the proxy discarded
  the counts before answering — which is why every figure the summariser reports
  is a median and why two aliases behind one endpoint stay two rows.

  What structurally cannot come from this route: a percentile, a request
  duration, an SLA figure, or a comparison between two gateways. The proxy
  averaged the per-request ratios before answering, and the sample that does
  carry real durations (`/spend/logs`) is the head of the window rather than a
  draw from it.

- **Alerting on hangs.** The stored roll-up now exists:
  `gateway_slow_response_daily` holds one night per (alias, endpoint key), the
  full sync appends yesterday's sweep to it, and
  `GET /api/gateway/slow-responses/history` serves it through
  `summarizeSlowResponseHistory` with the same two gates and a pooled
  half-over-half trend. That crosses the boundary the exception and latency
  layers are still on the wrong side of — there is now a *table* for
  `services/gateway-notify.ts` to assess after a sync.

  The view now exists too: `GatewaySlowResponseHistoryCard` draws the stored
  nights under the live card, with the trend, the per-night strip and a
  three-state strip per endpoint. What is still not built is the thing that
  crosses the boundary — **no finding travels**, and that is a real question
  rather than a missing file. An episode key would have to be
  `slow-responses:model:<endpoint>` to obey the one-per-episode rule, and the
  first thing a hang alert raises is whether a corporate gateway's hang rate is
  stable enough night to night that a change in it is a finding — or whether it
  moves with the workload, so a team shipping a long-context job would page
  somebody for working as designed. That needs a real proxy, and the trend the
  card now renders is the evidence that would answer it. It is also why the card
  raises nothing on the digest yet: a finding there would need a threshold on a
  count against a duration nobody here can see.

  What structurally cannot come from this route however it is stored: a
  duration, a percentile, a comparison against another proxy's counts, a share
  of gateway traffic, or a hang attributed to a deployment inside the
  `api_base`-less bucket. The first three are the missing threshold, the fourth
  is the route's own denominator, and the last is the `GROUP BY`.

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
