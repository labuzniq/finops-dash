# Data cheatsheet

What is stored, who writes it, and the SQL behind every number on screen.

Params used throughout: `:from` / `:to` (inclusive ISO dates), `:days` (range length),
`:login` / `:dept` (filters). Money columns are `bigint` nano-dollars —
divide by `1e9`. Tables are unqualified; the connection sets `search_path` to `DB_SCHEMA`.

Every query below returns exactly what the UI renders. Where the UI derives in the browser from a
fetch-once payload, the SQL reproduces that derivation end to end.

---

## 1. Rules

| Rule | Consequence |
|---|---|
| Money is integer nano-dollars (USD × 1e9) | CSVs carry 9 decimals; cents lose it, floats drift. `/1e9` once, at the edge |
| No foreign keys anywhere | Joins are done in code at read time; a login may be billed before the roster names it |
| Absence means one of two things, per table | **unknown** (Copilot per-user metrics — nullable, render `—`); **zero** (org daily — the source omits what never happened) |
| Report 1 ≠ Report 2 | `billing_daily` is the only money; `model_spend_daily` is per-model statistics and never enters a money total |
| Two cost currencies | Copilot `net` (invoiced) and Claude Code `cost` (client-estimated). Never add them |

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
| CSV import | — | whatever the file covers | All-or-nothing per file |
| OTLP ingest | — | continuous push | Malformed points counted into `partialSuccess`, never thrown |

Scheduler fires all four at 07:00 Europe/Prague, detached — it does not await, so ordering between
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

---

## 5. Findings

Where the rendered number does not mean what its label says. Ranked by likelihood of acting on it.

| # | Finding | Where |
|---|---|---|
| **F1** | **AI-credits KPI is an extrapolation.** `Σ premium_requests_28d × days ÷ 28` — a 90d range multiplies a measured 28d figure by 3.21. Picking a *different* 28 days returns the same number: the column is a fixed trailing aggregate. Nulls count as 0. The seat table below shows the un-prorated value, so one metric reads two ways on one screen | `useDashboardMetrics.ts:65` |
| **F2** | **"Idle" defined twice.** KPI counts `> 28`; its own subtitle and the roster beneath it use `>= 30`. A seat at 29 days is in the number and missing from the list of names behind it | `useDashboardMetrics.ts:79` vs `idle.ts:15` |
| **F3** | **"Last 28 days" is three windows.** Usage page takes the trailing 28 *distinct dates carrying data*, so report holes stretch it past 28 calendar days; spend and Claude Code use calendar windows | `usage.ts:45` |
| **F4** | **Zero-activity day counts as an active user.** `filteredActivity` increments per row present, not per row with activity. Harmless on live GitHub, wrong on the mock | `usage.ts:218` |
| **F5** | **Two "by model" charts from different arrays.** `model_daily` is `totals_by_language_model` (code only); the `model` breakdown is `totals_by_model_feature` (all features). Nothing on the page says so. Every breakdown also drops GitHub's noise buckets, so a dimension sums below the org total above it | `github.ts:656` |
| **F6** | **Licence money summed on `gross`, not `net`,** on the strength of a comment nothing validates. Any licence discount overstates every wasted-spend figure while NET beside it stays right | `spend.ts:154` |
| **F7** | **Spend trend always ends in a $0 cliff.** Zero-filled to `:to` while the billing sync only reaches yesterday | `spend.ts:161` |
| **F8** | **`measurable` is blind to *partial* Report 1 coverage.** Any credit in range flips it true, so a half-imported report yields a confident "wasted seat" list of people whose credit rows were never imported. This one names people | `spend.ts:106` |
| **F9** | **Cost-centre buckets do not partition.** `active + idle ≤ people`: someone with no credits and no licence is in neither | `costCentre.ts:117` |
| **F10** | **One person can appear twice in telemetry.** `user_email ?? user_id` — an exporter that sends email on some batches and only id on others splits one human into two rows and counts them twice in ACTIVE USERS | `telemetry.ts:86` |
| **F11** | **Oldest telemetry day is partial.** `time >= now() - days*86400000` is a timestamp, not a midnight floor, so the first bar holds only the part of the day after the current clock time and is rendered as a full day | `services/telemetry.ts:13` |
| **F12** | **Filtered usage charts read as zero before the 28-day mark on live GitHub.** `user_daily` only covers the users report's trailing 28 days, so a 90d range with a seat filter draws 28 real days and 62 genuine-looking zeros | `github.ts:463` |
| **F13** | **Nothing says the two cost numbers may not be added.** Copilot net (invoiced) and Claude Code cost (client-estimated) sit on separate pages with no statement that they are different currencies | both pages |
| **F14** | **Seat `editor` can be stale.** A null dominant IDE from the users report overwrites the roster's `last_activity_editor`; `keepIfNull` then preserves whatever was stored before, so the column can hold a value from neither of today's sources | `github.ts:402` |
| **F15** | **`quantity_nano` filled from two different quantities** — the CSV's `quantity` column vs the API's `grossQuantity`. Latent: nothing reads it in a money total today | `billing-sync.ts:105` |
