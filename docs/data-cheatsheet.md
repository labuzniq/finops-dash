# Data cheatsheet

What is stored, who writes it, and the SQL behind every number on screen.

Params used throughout: `:from` / `:to` (inclusive ISO dates), `:days` (range length),
`:login` / `:dept` (filters), `:dim` (gateway dimension). Money columns are `bigint` nano-dollars —
divide by `1e9`. Tables are unqualified; the connection sets `search_path` to `DB_SCHEMA`.

Every query below returns exactly what the UI renders. Where the UI derives in the browser from a
fetch-once payload, the SQL reproduces that derivation end to end.

---

## 1. Rules

| Rule | Consequence |
|---|---|
| Money is integer nano-dollars (USD × 1e9) | CSVs carry 9 decimals, LiteLLM reports ~1e-8; cents lose it, floats drift. `/1e9` once, at the edge |
| No foreign keys anywhere | Joins are done in code at read time; a login may be billed before the roster names it |
| Absence means one of three things, per table | **unknown** (Copilot per-user metrics, gateway limits, catalogue prices — nullable, render `—`); **zero** (gateway counters, org daily — source omits what never happened); **unread** (all gateway history/sample tables — nobody looked; never interpolate) |
| Gateway dimensions overlap | `model`/`provider`/`api_key`/`team`/`tag`/`user` re-slice the same dollar; `mcp_server` is a subset. Sum within one, never across |
| Report 1 ≠ Report 2 | `billing_daily` is the only money; `model_spend_daily` is per-model statistics and never enters a money total |
| Three cost currencies | Copilot `net` (invoiced), gateway `spend` (proxy-recorded), Claude Code `cost` (client-estimated). Never add them |

## 2. Tables

| Table | Grain | Written by | Mode | Gotchas |
|---|---|---|---|---|
| `copilot_seats` | login | copilot refresh 07:00 | upsert, then delete logins missing from snapshot | `premium_requests_28d` is `ai_credits_used`, fixed 28d window. `last_activity_at` stored as timestamp, "days ago" derived at read. Nullable metric columns only overwrite when incoming is non-null |
| `org_daily` | date | copilot refresh | upsert per day | All columns `not null`, zero-filled at parse. DAU/WAU/MAU are GitHub's, not derived |
| `usage_breakdown_daily` | date, dimension, key | copilot refresh | delete-then-insert per fetched day | 4 dimensions in one table. GitHub noise buckets (`others`/`unknown`/`none`) dropped at parse — series sum < org total. `model` here is from `totals_by_model_feature` |
| `adoption_phase_daily` | date, phase_number | copilot refresh | delete-then-insert per day | Every metric except `engaged_users` is already an average per engaged user — never sum |
| `user_daily` | date, login | copilot refresh | delete-then-insert per day + purge non-roster logins | Live GitHub only fills the trailing 28 days; the mock fills everything. `interactions` and all LOC columns exist only inside per-IDE totals and are summed there |
| `model_daily` | date, model | copilot refresh | delete-then-insert per day | From `totals_by_language_model` — code completions only, so it disagrees with the `model` breakdown by design |
| `billing_daily` | date, login, sku | billing sync (yesterday + day before) **and** Report 2 CSV | sync: delete-then-insert AI-credit rows only. CSV: upsert | **Sole money authority.** Licences (`copilot_for_business`) have no API and are CSV-only. Repeated keys in the file are summed, not overwritten |
| `model_spend_daily` | date, login, model | billing sync **and** Report 1 CSV | sync: replace day. CSV: upsert | Only `copilot_ai_credit` rows land; `copilot_premium_request` is a request count at another unit price and is skipped |
| `github_users` | login | members sync 07:00, both CSV imports, billing sync | upsert; never deleted | `active` is **sticky** — "seen in a billing report", never cleared. `saml_name_id` written `coalesce(excluded, existing)`; ids past `varchar(40)` skipped, never truncated |
| `jira_people` | saml_name_id (uppercase) | jira sync 07:00 | upsert | Matched case-insensitively |
| `gateway_daily` | date | gateway sync 07:00 | replace fetched days | Window is 90 days **ending yesterday** — today is still accruing. `prompt_tokens` is the whole input; both cache counters are inside it |
| `gateway_breakdown_daily` | date, dimension, key | gateway sync | replace fetched days | `label` = resolved alias, null renders `—` |
| `gateway_budget` | scope, key | full sync only | replace wholesale | `spend_nano` is the proxy's **enforced** counter, never re-derived. Null limit = none configured, `0` = reject everything. `tag` counter never resets (litellm#27481) |
| `gateway_budget_history` | scope, key, date | full sync only | upsert per day | Sample, not series. No row = nobody looked |
| `gateway_notification` | fingerprint `kind:scope:key` | after each full sync | upsert | Fingerprint carries no numbers, so a climbing counter is the same episode. `delivered_at` null = retry next sync |
| `gateway_model` | model alias | full sync only | replace wholesale | Nano-dollars **per million** tokens. Null price ≠ 0. `price_varies` = cheapest of several deployments, a floor |
| `gateway_deployment_health` | deployment id | full sync only | replace wholesale | Only table keyed below the alias. `model` is resolved against the catalogue fetched in the same run |
| `gateway_deployment_health_history` | id, date | full sync only | upsert per day | Counts of **readings**, never durations or uptime |
| `gateway_month` / `gateway_month_line` | month, revision (+ dimension, key) | full sync seals closed months | insert; re-seal adds a revision, supersedes the old | Payer dimensions only. Partial unique index keeps one current statement |
| `gateway_slow_response_daily` | date, model, deployment_key | full sync, yesterday only | upsert | Counts add. Threshold is the proxy's and is not in the response — no figure may carry a duration |
| `gateway_exception_daily` | date, model, deployment, exception_type | full sync, yesterday only | upsert | No denominator at all — only a *mix* may be derived. Class derived on read |
| `gateway_exception_sweep` | date | full sync | upsert | The receipt. Rows-with-receipt = clean night; neither = unread |
| `gateway_latency_daily` | date, model, deployment_key | full sync, yesterday only | upsert | Readings may be compared, **never pooled**. Rate ×1e9, never zero |
| `refresh_jobs` | id | every sync | insert + status updates | Queue, audit log and "synced 2h ago" in one. Single-flight per kind via partial unique index; `running` past 5 min is reaped |
| `import_logs` | id | CSV uploads, members sync | insert | Written on failure too; `row_count` stays 0 there |
| `otlp_metric_points` | id (append-only) | OTLP push | insert | `value` is **already delta-normalised** at ingest, so every read is a plain SUM. `raw_value` keeps the cumulative reading to diff against |
| `otlp_log_records` | id (append-only) | OTLP push | insert | Stored for drill-down; nothing reads it today |

## 3. Writers

| Job | Kind | Window | Skips |
|---|---|---|---|
| Copilot refresh | `copilot` | 90 days back from the newest settled report day | 204/403 days are skipped; >5 blocked days fails the run |
| Billing sync | `billing` | yesterday + the day before (N+1: one request per login per day) | Licence accrual — no per-user API |
| Members sync | `members` | full roster | SAML-linked members only; never deletes, never touches `active` |
| JIRA sync | `jira` | full people set | — |
| Gateway sync | `gateway` | 90 days ending yesterday UTC | A **ranged** sync writes usage only — no budgets, catalogue, `/health` or sweeps |
| CSV import | — | whatever the file covers | All-or-nothing per file |
| OTLP ingest | — | continuous push | Malformed points counted into `partialSuccess`, never thrown |

Scheduler fires all five at 07:00 Europe/Prague, detached — it does not await, so ordering between
them is intent, not guarantee.

---

## 4. Frontend → SQL

### 4.0 Shared CTEs

```sql
-- Seats with the identity join and derived staleness. Every seat query starts here.
create temp view seat_v as
select s.*,
       coalesce(nullif(trim(concat_ws(' ', jp.first_name, jp.last_name)), ''), s.login) as display_name,
       jp.department, jp.b1_manager, jp.b2_manager,
       (jp.saml_name_id is not null)                              as mapped,
       case when s.last_activity_at is null then null
            else greatest(0, floor(extract(epoch from now() - s.last_activity_at) / 86400))::int
       end                                                        as last_activity_days
from copilot_seats s
left join github_users gu on gu.login = s.login
left join jira_people  jp on upper(jp.saml_name_id) = upper(gu.saml_name_id);
```

Filters the UI applies to `seat_v`: `editor = :editor`, `language = :language`,
`department = :dept`, `b1_manager = :b1`, `b2_manager = :b2`, `login = :login`,
`mapped = false` (Unmapped), and a case-insensitive search over `login`, `name`, `display_name`.
Append them to any query below.

### 4.1 Copilot page — KPI row

```sql
-- SEATS / SEAT UTILIZATION / IDLE SEATS
select count(*)                                                              as seats,
       count(*) filter (where last_activity_days <= 28)                      as active_28d,
       round(count(*) filter (where last_activity_days <= 28)::numeric * 100
             / nullif(count(*), 0))                                          as utilized_pct,
       -- what the KPI actually counts:
       count(*) filter (where last_activity_days is null
                           or last_activity_days > 28)                       as idle_as_coded,
       -- what its "30d+ or never" subtitle claims, and what the roster below shows:
       count(*) filter (where last_activity_days is null
                           or last_activity_days >= 30)                      as idle_as_labelled
from seat_v;
```

```sql
-- AI CREDITS USED · :days   (an extrapolation — see F1)
select round(sum(coalesce(premium_requests_28d, 0)) * :days / 28.0) as ai_credits_used
from seat_v;
```

### 4.2 Copilot page — utilisation donut

```sql
select case when last_activity_days is null      then 'never'
            when last_activity_days <= 7         then 'active7'
            when last_activity_days <= 28        then 'active28'
            else 'dormant' end                                     as bucket,
       count(*)                                                    as count,
       round(count(*)::numeric * 100 / sum(count(*)) over ())      as percent
from seat_v
group by 1;
```

Arc geometry is `dashArray = fraction × 2πr`, `dashOffset = −(cumulative fraction) × 2πr`, `r = 56`.

### 4.3 Copilot page — seat table

```sql
select display_name, login, plan, editor, top_model,
       premium_requests_28d,        -- raw 28d value, NOT the prorated KPI above
       acceptance_rate,
       last_activity_days
from seat_v
order by premium_requests_28d desc nulls last,   -- unknowns sort below every real value
         login
limit 12 offset :page * 12;
```

Other sort keys: `acceptance_rate desc nulls last`, `last_activity_days asc nulls last` (a
never-used seat sorts as infinitely stale).

### 4.4 Copilot page — idle roster

```sql
select coalesce(department, 'Unassigned') as grp,   -- or b1_manager / b2_manager
       count(*)                          as people,
       array_agg(display_name order by coalesce(last_activity_days, 2147483647) desc,
                                       display_name)                as names
from seat_v
where last_activity_days is null or last_activity_days >= 30
group by 1
order by (department is null), people desc, grp;   -- Unassigned pinned last
```

### 4.5 Copilot page — org activity charts

```sql
-- Active users / generations / acceptances / interactions / LOC, one row per day
select date, daily_active_users, weekly_active_users, monthly_active_users,
       generations, acceptances, interactions,
       loc_added, loc_deleted, loc_suggested_add, loc_suggested_delete,
       -- acceptance rate: null (line breaks) on a day with no generations
       case when generations > 0
            then acceptances::numeric * 100 / generations end       as acceptance_rate
from org_daily
where date between :from and :to
order by date;
```

```sql
-- Engaged cohorts (chat/agent, code review, cloud agent) and pull requests
select date, chat_mau, agent_mau,
       code_review_dau, code_review_wau, code_review_mau, code_review_passive_mau,
       cloud_agent_dau, cloud_agent_wau, cloud_agent_mau,
       pr_created, pr_merged, pr_created_by_copilot,
       pr_merged_created_by_copilot, pr_reviewed_by_copilot,
       pr_copilot_suggestions, pr_copilot_applied_suggestions
from org_daily
where date between :from and :to
order by date;
-- the whole PR section is hidden when every pr_* column is 0 across the window
```

### 4.6 Copilot page — "By IDE / language / feature / model" charts

Top 8 keys by range total; everything else folds into one `Other` series.

```sql
with rows as (
  select key, date, generations as metric        -- or acceptances / loc_added / interactions
  from usage_breakdown_daily
  where dimension = :dim and date between :from and :to
),
ranked as (
  select key, rank() over (order by sum(metric) desc, key) as rnk
  from rows group by key
)
select case when r.rnk <= 8 then rows.key else 'Other' end as series,
       rows.date,
       sum(rows.metric)                                    as value
from rows join ranked r using (key)
group by 1, 2
order by 2, 1;
```

### 4.7 Copilot page — filtered activity (seat filter active)

```sql
select ud.date,
       count(*)                          as active_users,   -- rows present, not rows with activity
       sum(ud.interactions)              as interactions,
       sum(ud.generations)               as generations,
       sum(ud.acceptances)               as acceptances,
       sum(ud.loc_added)                 as loc_added,
       sum(ud.loc_deleted)               as loc_deleted
from user_daily ud
where ud.date between :from and :to
  and ud.login in (select login from seat_v /* + filters */)
group by ud.date
order by ud.date;
```

### 4.8 Copilot page — teams panel and per-model table

```sql
select coalesce(team, 'No team')                                    as team,
       count(*)                                                     as seats,
       round(count(*) filter (where last_activity_days <= 28)::numeric * 100
             / nullif(count(*), 0))                                 as active_percent
from seat_v
group by 1
order by seats desc, team;
```

```sql
select model,
       sum(generations)                                             as generations,
       sum(acceptances)                                             as acceptances,
       sum(loc_added)                                               as loc_added,
       round(sum(acceptances)::numeric * 100
             / nullif(sum(generations), 0))                         as acceptance_rate
from model_daily
where date between :from and :to
group by model
order by generations desc;
```

### 4.9 Spend — KPI row

```sql
select sum(gross_nano)   / 1e9                                                   as gross,
       sum(discount_nano)/ 1e9                                                   as discount,
       sum(net_nano)     / 1e9                                                   as net,
       sum(gross_nano) filter (where sku = 'copilot_for_business') / 1e9         as licence
from billing_daily
where date between :from and :to
  and login in (select login from seat_v /* org filters */);   -- omit when unfiltered
```

`licence` reads **gross**, not net, and is already inside gross and net.

### 4.10 Spend — trend chart

```sql
select d::date                                              as date,
       coalesce(sum(b.gross_nano)   / 1e9, 0)               as gross,
       coalesce(sum(b.discount_nano)/ 1e9, 0)               as discount,
       coalesce(sum(b.net_nano)     / 1e9, 0)               as net
from generate_series(:from::date, :to::date, interval '1 day') d
left join billing_daily b on b.date = d::date
group by 1
order by 1;
-- zero-filled to :to, tail NOT trimmed — days the sync has not reached plot as $0 (F7)
```

### 4.11 Spend — model breakdown chart

```sql
select model,
       sum(credits_nano)/1e9                                        as credits,
       sum(gross_nano)  /1e9                                        as gross,
       sum(gross_nano)::numeric / nullif(sum(sum(gross_nano)) over (), 0) as share
from model_spend_daily
where date between :from and :to
group by model
order by gross desc, model;
```

### 4.12 Spend — per-user table, wasted spend, cohorts, cost centres

All four read one per-login roll-up. It takes params, so paste it as a leading `WITH` rather than a
view — the queries under it refer to it as `spend_user`:

```sql
with billing as (
  select login,
         sum(gross_nano)/1e9                                                as gross,
         sum(discount_nano)/1e9                                             as discount,
         sum(net_nano)/1e9                                                  as net,
         sum(gross_nano) filter (where sku = 'copilot_for_business')/1e9    as licence
  from billing_daily where date between :from and :to group by login
),
credits as (
  select login, sum(credits_nano)/1e9 as credits
  from model_spend_daily where date between :from and :to group by login
),
last_credit as (                       -- last credit day strictly BEFORE the range
  select login, max(date) as last_credit_before
  from model_spend_daily
  where date < :from and credits_nano > 0
  group by login
),
spend_user as (
select coalesce(b.login, c.login)                                           as login,
       coalesce(nullif(trim(concat_ws(' ', jp.first_name, jp.last_name)), ''),
                coalesce(b.login, c.login))                                 as display_name,
       jp.department, jp.b1_manager, jp.b2_manager,
       (jp.saml_name_id is not null)                                        as mapped,
       coalesce(b.gross, 0) as gross, coalesce(b.discount, 0) as discount,
       coalesce(b.net, 0)   as net,   coalesce(b.licence, 0)  as licence,
       coalesce(c.credits, 0)                                               as credits,
       lc.last_credit_before
from billing b
full join credits c on c.login = b.login
left join last_credit lc on lc.login = coalesce(b.login, c.login)
left join github_users gu on gu.login = coalesce(b.login, c.login)
left join jira_people  jp on upper(jp.saml_name_id) = upper(gu.saml_name_id)
)
select * from spend_user;
```

```sql
-- Per-user table
select display_name, login, department, b1_manager, b2_manager,
       credits, gross, discount, net
from spend_user order by gross desc, login;
```

```sql
-- WASTED LICENCE SPEND card
select sum(licence) filter (where credits = 0)                              as wasted,
       count(*)     filter (where credits = 0)                              as seats,
       sum(licence)                                                         as licence,
       sum(licence) filter (where credits = 0) / nullif(sum(licence), 0)    as share,
       (select sum(credits) from spend_user) > 0                            as measurable
from spend_user where licence > 0;
```

```sql
-- Cohort split of the wasted pile (30 = IDLE_THRESHOLD_DAYS)
select case when last_credit_before is null                       then 'never'
            when :from::date - last_credit_before >= 30           then 'dormant'
            else 'lapsed' end                                     as cohort,
       count(*)                                                   as seats,
       sum(licence)                                               as amount,
       sum(licence) / nullif(sum(sum(licence)) over (), 0)        as share
from spend_user
where licence > 0 and credits = 0
group by 1;

-- floor named on the "never" row, and the guard that withholds the split entirely:
select min(date) as floor, (min(date) < :from) as prior_history from model_spend_daily;
```

```sql
-- COST CENTRES  (swap department for b1_manager / b2_manager)
select coalesce(department, 'Unassigned')                                   as label,
       count(*)                                                             as people,
       count(*) filter (where credits > 0)                                  as active_people,
       count(*) filter (where credits = 0 and licence > 0)                  as idle_people,
       sum(credits) as credits, sum(gross) as gross,
       sum(discount) as discount, sum(net) as net, sum(licence) as licence,
       sum(licence) filter (where credits = 0 and licence > 0)              as wasted,
       sum(net) / nullif(count(*), 0)                                       as net_per_person,
       sum(net) / nullif(sum(sum(net)) over (), 0)                          as share
from spend_user
group by department
order by (department is null), net desc, label;   -- Unassigned pinned last
```

### 4.13 Claude Code — every tile

One base roll-up; everything else is a filter over it. Paste it as a leading `WITH tel as (…)`.

```sql
select to_char(time at time zone 'utc', 'YYYY-MM-DD')       as date,
       coalesce(user_email, user_id)                        as usr,
       model, metric_name as metric, type,
       sum(value)                                           as value
from otlp_metric_points
where time >= :from::timestamptz          -- floor to UTC midnight; the API uses now() - days (F11)
  and time <  (:to::date + 1)::timestamptz
group by 1, 2, 3, 4, 5;
```

```sql
-- KPI row
select sum(value) filter (where metric = 'claude_code.cost.usage')          as total_cost,
       sum(value) filter (where metric = 'claude_code.token.usage')         as total_tokens,
       sum(value) filter (where metric = 'claude_code.session.count')       as sessions,
       count(distinct usr) filter (where usr is not null)                   as active_users,
       -- null-start: a metric that never appeared renders "—", not 0
       sum(value) filter (where metric = 'claude_code.lines_of_code.count'
                            and type is distinct from 'removed')            as lines_added,
       sum(value) filter (where metric = 'claude_code.lines_of_code.count'
                            and type = 'removed')                           as lines_removed,
       sum(value) filter (where metric = 'claude_code.commit.count')        as commits,
       sum(value) filter (where metric = 'claude_code.pull_request.count')  as pull_requests
from tel;
```

```sql
-- Daily cost chart, and the four token charts
select d::date                                                              as date,
       coalesce(sum(value) filter (where metric = 'claude_code.cost.usage'), 0)  as cost,
       coalesce(sum(value) filter (where metric = 'claude_code.token.usage'
                                     and type = 'input'), 0)                as input,
       coalesce(sum(value) filter (where metric = 'claude_code.token.usage'
                                     and type = 'output'), 0)               as output,
       coalesce(sum(value) filter (where metric = 'claude_code.token.usage'
                                     and type not in ('input','output')), 0) as cache
from generate_series(:from::date, :to::date, interval '1 day') d
left join tel on tel.date = to_char(d, 'YYYY-MM-DD')
group by 1 order by 1;
```

```sql
-- Token leaderboard (top 8) and the per-user table
select usr,
       sum(value) filter (where metric='claude_code.cost.usage')            as cost,
       sum(value) filter (where metric='claude_code.token.usage')           as tokens,
       sum(value) filter (where metric='claude_code.session.count')         as sessions,
       sum(value) filter (where metric='claude_code.commit.count')          as commits,
       max(date)                                                           as last_active,
       (select t2.model from tel t2
         where t2.usr = tel.usr and t2.metric='claude_code.token.usage' and t2.model is not null
         group by t2.model order by sum(t2.value) desc limit 1)            as top_model
from tel where usr is not null
group by usr order by cost desc;
```

### 4.14 Gateway — KPI row, trend, breakdown

The spine is zero-filled between days and **trimmed** at the last reported day.

```sql
-- Trend chart + the KPI row's totals
with spine as (
  select d::date as date
  from generate_series(:from::date,
                       least(:to::date, (select max(date) from gateway_daily)),
                       interval '1 day') d
)
select s.date,
       coalesce(g.spend_nano, 0)/1e9        as spend,
       coalesce(g.requests, 0)              as requests,
       coalesce(g.successful_requests, 0)   as successful,
       coalesce(g.failed_requests, 0)       as failed,
       coalesce(g.total_tokens, 0)          as total_tokens,
       coalesce(g.prompt_tokens, 0)         as prompt_tokens,
       coalesce(g.cache_read_tokens, 0)     as cache_read
from spine s left join gateway_daily g on g.date = s.date
order by s.date;
```

```sql
-- KPI tiles: spend / requests / tokens / $ per 1M / cache hit rate / $ per request
select sum(spend_nano)/1e9                                                  as gateway_spend,
       sum(requests)                                                        as requests,
       sum(successful_requests)::numeric * 100 / nullif(sum(requests), 0)    as success_rate,
       sum(total_tokens)                                                    as tokens,
       sum(spend_nano)/1e9 * 1e6 / nullif(sum(total_tokens), 0)             as cost_per_1m,
       sum(cache_read_tokens)::numeric * 100 / nullif(sum(prompt_tokens), 0) as cache_hit_rate,
       sum(spend_nano)/1e9 / nullif(sum(requests), 0)                       as cost_per_request
from gateway_daily where date between :from and :to;
```

```sql
-- Breakdown table: share is always of GATEWAY-WIDE spend, never of the dimension's own sum
select key, max(label) as label,
       sum(spend_nano)/1e9                                                  as spend,
       sum(requests)                                                        as requests,
       sum(total_tokens)                                                    as tokens,
       sum(spend_nano)::numeric
         / nullif((select sum(spend_nano) from gateway_daily
                    where date between :from and :to), 0)                   as share
from gateway_breakdown_daily
where dimension = :dim and date between :from and :to
group by key
order by spend desc, key;
```

### 4.15 Gateway — movers (comparison window)

```sql
-- window = exactly the same length, ending the day before the spine starts
with cur as (
  select key, sum(spend_nano)/1e9 as spend from gateway_breakdown_daily
  where dimension = :dim and date between :from and :to group by key),
prev as (
  select key, sum(spend_nano)/1e9 as spend from gateway_breakdown_daily
  where dimension = :dim
    and date between (:from::date - :days) and (:from::date - 1) group by key)
select coalesce(c.key, p.key)                          as key,
       coalesce(p.spend, 0)                            as before,
       coalesce(c.spend, 0)                            as now,
       coalesce(c.spend, 0) - coalesce(p.spend, 0)     as delta
from cur c full join prev p using (key)
order by delta desc;
```

### 4.16 Gateway — anomalies

Detection: trailing **median** of 14 days (≥7 required), flagged when it is ≥25% above baseline
**and** the robust z-score ≥ 3.5.

```sql
with spine as (select date, spend_nano/1e9 as spend from gateway_daily
               where date between :from and :to),
base as (
  select s.date, s.spend,
         (select percentile_cont(0.5) within group (order by t.spend)
            from spine t where t.date < s.date and t.date >= s.date - 14)   as baseline,
         (select count(*) from spine t where t.date < s.date and t.date >= s.date - 14) as days
  from spine s)
select date, spend, baseline, days,
       spend - baseline                                                     as excess,
       (spend - baseline) / nullif(baseline, 0)                             as excess_share
from base
where days >= 7 and baseline > 0
  and (spend - baseline) / baseline >= 0.25          -- relative gate
order by excess desc;
-- the z gate needs MAD: excess / (1.4826 * median(|trailing - baseline|)) >= 3.5
```

Attribution uses the trailing **mean**, not the median, because a mean is additive and the
contributor rows must reconcile to the day's overrun exactly:

```sql
select b.key, max(b.label) as label,
       sum(b.spend_nano) filter (where b.date = :day)/1e9                   as spend,
       sum(b.spend_nano) filter (where b.date < :day)/1e9 / 14              as baseline,
       sum(b.spend_nano) filter (where b.date = :day)/1e9
         - sum(b.spend_nano) filter (where b.date < :day)/1e9 / 14          as excess
from gateway_breakdown_daily b
where b.dimension = :dim and b.date > :day::date - 15 and b.date <= :day::date
group by b.key
order by excess desc;
```

### 4.17 Gateway — forecast

Calendar month, priced weekday by weekday over the trailing 28 days — never a flat run rate.

```sql
with spine as (
  select date, spend_nano/1e9 as spend from gateway_daily
  where date > date_trunc('month', :today::date)::date - 28),
profile as (                            -- trailing 28 days, one mean per weekday
  select extract(dow from date) as dow, avg(spend) as mean
  from spine where date > (select max(date) from spine) - 28 group by 1),
mtd as (
  select coalesce(sum(spend), 0) as month_to_date, max(date) as through
  from spine where date >= date_trunc('month', :today::date)::date),
remaining as (
  select sum(coalesce(p.mean, (select avg(spend) from spine))) as remaining
  from generate_series((select through from mtd) + 1,
                       (date_trunc('month', :today::date) + interval '1 month - 1 day')::date,
                       interval '1 day') d
  left join profile p on p.dow = extract(dow from d))
select month_to_date, remaining, month_to_date + remaining as projected, through from mtd, remaining;
```

### 4.18 Gateway — budgets

```sql
select scope, key, label,
       spend_nano/1e9                                                       as spend,
       max_budget_nano/1e9                                                  as max_budget,
       spend_nano::numeric * 100 / nullif(max_budget_nano, 0)               as utilization,
       case when blocked                       then 'blocked'
            when max_budget_nano = 0           then 'blocked'
            when max_budget_nano is null       then 'uncapped'
            when spend_nano >= max_budget_nano then 'over'
            when soft_budget_nano is not null
             and spend_nano >= soft_budget_nano then 'soft'
            when spend_nano::numeric / max_budget_nano >= 0.8 then 'warn'
            else 'ok' end                                                   as state,
       (tpm_limit is not null or rpm_limit is not null)                     as rate_limited,
       (scope = 'tag')                                                      as spend_is_cumulative
from gateway_budget
where scope = :scope
order by utilization desc nulls last;
-- pace (spend / fraction of period elapsed) is withheld before 1/6 of the period,
-- for a row with no period, and for EVERY tag row — its counter never resets
```

### 4.19 Gateway — chargeback statement

Lines plus an explicit `unallocated` row equal the month's gateway spend exactly. No top-N, no
pro-rata.

```sql
with total as (
  select sum(spend_nano)/1e9 as spend from gateway_daily
  where date >= :month::date and date < (:month::date + interval '1 month')),
lines as (
  select key, max(label) as label, sum(spend_nano)/1e9 as spend
  from gateway_breakdown_daily
  where dimension = :payer_dim                    -- team | tag | api_key | user only
    and date >= :month::date and date < (:month::date + interval '1 month')
  group by key)
select key, label, spend from lines
union all
select 'unallocated', null, (select spend from total) - coalesce((select sum(spend) from lines), 0)
order by spend desc;
```

```sql
-- the seal it is compared against (current revision only), and its drift
select m.month, m.revision, m.sealed_at, m.spend_nano/1e9 as sealed_spend
from gateway_month m where m.month = :month and m.superseded_at is null;
```

### 4.20 Gateway — cache, catalogue, reliability

```sql
-- CACHE card: tokens only, never dollars. prompt_tokens is the WHOLE input.
select key, max(label) as label,
       sum(prompt_tokens)                                                   as input_tokens,
       sum(cache_read_tokens)                                               as cache_read,
       sum(cache_creation_tokens)                                           as cache_write,
       greatest(0, sum(prompt_tokens) - sum(cache_read_tokens)
                   - sum(cache_creation_tokens))                            as uncached_input,
       sum(cache_read_tokens)::numeric / nullif(sum(prompt_tokens), 0)      as read_share,
       -- churning: below (1.25-1)/(1-0.1) = 0.28 reads per token written, the cache costs more
       sum(cache_read_tokens)::numeric / nullif(sum(cache_creation_tokens), 0) as reuse
from gateway_breakdown_daily
where dimension = :dim and date between :from and :to
group by key order by uncached_input desc;
```

```sql
-- CATALOGUE card: configured list rate vs what was actually billed, per model
select b.key                                                                as model,
       sum(b.spend_nano)/1e9                                                as billed,
       sum(b.spend_nano)/1e9 * 1e6 / nullif(sum(b.total_tokens), 0)         as blended_per_1m,
       m.input_per_million_nano/1e9                                         as list_input_per_1m,
       m.output_per_million_nano/1e9                                        as list_output_per_1m,
       m.price_varies                                    -- a floor: cheapest of N deployments
from gateway_breakdown_daily b
left join gateway_model m on m.model = b.key
where b.dimension = 'model' and b.date between :from and :to
group by b.key, m.input_per_million_nano, m.output_per_million_nano, m.price_varies
order by billed desc;
-- coverage = billed spend of rows with a catalogue match / gateway-wide spend
```

```sql
-- RELIABILITY card: failures per key, signed against the gateway-wide rate
with gw as (select sum(failed_requests)::numeric / nullif(sum(requests), 0) as rate
            from gateway_daily where date between :from and :to)
select key, max(label) as label,
       sum(requests) as requests, sum(failed_requests) as failed,
       sum(failed_requests)::numeric / nullif(sum(requests), 0)             as fail_rate,
       sum(failed_requests) - sum(requests) * (select rate from gw)         as excess_failures
from gateway_breakdown_daily
where dimension = :dim and date between :from and :to
group by key order by excess_failures desc;
-- the "elevated" badge needs BOTH a Wilson lower bound above the gateway rate
-- AND a 1.5x materiality ratio: at gateway volumes significance alone flags everything
```

### 4.21 Gateway — health, and the kept sweeps

```sql
-- HEALTH card: an alias is `down` only when EVERY deployment behind it fails
select coalesce(model, 'unnamed deployments')                               as model,
       count(*)                                     as deployments,
       count(*) filter (where not healthy)          as failing,
       case when count(*) filter (where not healthy) = 0        then 'up'
            when count(*) filter (where not healthy) = count(*) then 'down'
            else 'degraded' end                                             as state,
       max(checked_at)                                                      as reading_age
from gateway_deployment_health group by model order by state, model;
-- stale past 36h still reports every finding and adds a blind spot; never taken stands the card down
```

```sql
-- HEALTH HISTORY: counts of READINGS, never durations. No row = nobody looked.
select id, max(model) as model,
       count(*)                            as readings,
       count(*) filter (where not healthy) as failing_readings
from gateway_deployment_health_history
where date >= current_date - 60 group by id order by failing_readings desc;
```

```sql
-- EXCEPTION HISTORY: a night with a receipt and no rows is CLEAN; a night in neither is UNREAD
select s.date, s.exceptions,
       coalesce(sum(e.count), 0)                                            as counted,
       (s.date is not null and coalesce(sum(e.count), 0) = 0)               as clean_night
from gateway_exception_sweep s
left join gateway_exception_daily e on e.date = s.date
where s.date >= current_date - 60
group by s.date, s.exceptions order by s.date;
```

```sql
-- SLOW RESPONSES history: counts add, so they may be pooled across nights
select date, sum(slow_count) as hangs, sum(total_count) as sampled,
       sum(slow_count)::numeric / nullif(sum(total_count), 0)               as hang_share
from gateway_slow_response_daily
where date >= current_date - 60 group by date order by date;
-- the threshold behind `slow_count` is the proxy's own and is NOT in the response:
-- no figure here may carry a duration, and two proxies' counts are not comparable
```

```sql
-- LATENCY history: readings may be COMPARED, never POOLED. Every figure is a median.
select date,
       percentile_cont(0.5) within group (order by seconds_per_token_nano/1e9) as median_s_per_token
from gateway_latency_daily
where date >= current_date - 60 group by date order by date;
-- a rate, never a duration; the only claim-free transform is its reciprocal (tokens/sec)
```

Live-only reads (`/api/gateway/logs`, `/exceptions`, `/latency`, `/slow-responses`) hit the proxy
directly and store nothing — there is no SELECT for the live cards, only for the nightly samples
above.

---

## 5. Findings

Where the rendered number does not mean what its label says. Ranked by likelihood of acting on it.

| # | Finding | Where |
|---|---|---|
| **F1** | **AI-credits KPI is an extrapolation.** `Σ premium_requests_28d × days ÷ 28` — a 90d range multiplies a measured 28d figure by 3.21. Picking a *different* 28 days returns the same number: the column is a fixed trailing aggregate. Nulls count as 0. The seat table below shows the un-prorated value, so one metric reads two ways on one screen | `useDashboardMetrics.ts:65` |
| **F2** | **"Idle" defined twice.** KPI counts `> 28`; its own subtitle and the roster beneath it use `>= 30`. A seat at 29 days is in the number and missing from the list of names behind it | `useDashboardMetrics.ts:79` vs `idle.ts:15` |
| **F3** | **"Last 28 days" is four windows.** Usage page takes the trailing 28 *distinct dates carrying data*, so report holes stretch it past 28 calendar days; spend and Claude Code use calendar windows; the gateway trims its tail | `usage.ts:45` |
| **F4** | **Zero-activity day counts as an active user.** `filteredActivity` increments per row present, not per row with activity. Harmless on live GitHub, wrong on the mock | `usage.ts:218` |
| **F5** | **Two "by model" charts from different arrays.** `model_daily` is `totals_by_language_model` (code only); the `model` breakdown is `totals_by_model_feature` (all features). Nothing on the page says so. Every breakdown also drops GitHub's noise buckets, so a dimension sums below the org total above it | `github.ts:656` |
| **F6** | **Licence money summed on `gross`, not `net`,** on the strength of a comment nothing validates. Any licence discount overstates every wasted-spend figure while NET beside it stays right | `spend.ts:154` |
| **F7** | **Spend trend always ends in a $0 cliff.** Zero-filled to `:to` while the billing sync only reaches yesterday. The gateway already solves this by trimming the tail | `spend.ts:161` |
| **F8** | **`measurable` is blind to *partial* Report 1 coverage.** Any credit in range flips it true, so a half-imported report yields a confident "wasted seat" list of people whose credit rows were never imported. This one names people | `spend.ts:106` |
| **F9** | **Cost-centre buckets do not partition.** `active + idle ≤ people`: someone with no credits and no licence is in neither | `costCentre.ts:117` |
| **F10** | **One person can appear twice in telemetry.** `user_email ?? user_id` — an exporter that sends email on some batches and only id on others splits one human into two rows and counts them twice in ACTIVE USERS | `telemetry.ts:86` |
| **F11** | **Oldest telemetry day is partial.** `time >= now() - days*86400000` is a timestamp, not a midnight floor, so the first bar holds only the part of the day after the current clock time and is rendered as a full day | `services/telemetry.ts:13` |
| **F12** | **Filtered usage charts read as zero before the 28-day mark on live GitHub.** `user_daily` only covers the users report's trailing 28 days, so a 90d range with a seat filter draws 28 real days and 62 genuine-looking zeros | `github.ts:463` |
| **F13** | **A scheduler outage looks like a quiet fortnight on the gateway.** Interior days zero-fill by design; the coverage note is the only place the two can be told apart. The anomaly card compounds it — those $0 days lower the trailing median, so the first day after a gap can flag as an anomaly that never happened | `gateway.ts:97` |
| **F14** | **Nothing says the three cost numbers may not be added.** Copilot net (invoiced), gateway spend (proxy-recorded), Claude Code cost (client-estimated) sit on three pages with no statement that they are different currencies | all three pages |
| **F15** | **Seat `editor` can be stale.** A null dominant IDE from the users report overwrites the roster's `last_activity_editor`; `keepIfNull` then preserves whatever was stored before, so the column can hold a value from neither of today's sources | `github.ts:402` |
| **F16** | **`quantity_nano` filled from two different quantities** — the CSV's `quantity` column vs the API's `grossQuantity`. Latent: nothing reads it in a money total today | `billing-sync.ts:105` |
