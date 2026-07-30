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

## Endpoints

| Method | Path | Answer |
| --- | --- | --- |
| `GET` | `/api/gateway?from=&to=` | `{ daily, breakdowns }` for the inclusive range — fetched once, everything derived client-side. |
| `GET` | `/api/gateway/status` | `{ source, configured }`. |
| `POST` | `/api/refresh/gateway` | `202` with the job to poll; `503` while the source is `off`. |

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
