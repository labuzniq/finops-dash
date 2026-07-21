# Mock dataset (CSV)

The seeded demo dataset, exported to CSV. The API creates **no data** on its own —
migrations build the schema and boot leaves every table empty. These files are how a
demo database gets populated.

Regenerate (activity dates are anchored to the day of export, so refresh these when
"days ago" has gone stale):

```bash
pnpm --filter @dash/api mock:export   # optional arg: history days (default 90)
```

## Loading

**Seats** go through the import endpoint (upserts by login; also available in the UI
under *+ Add data → Import*):

```bash
curl -X POST http://localhost:4000/api/import \
  -H 'content-type: application/json' \
  --data "$(jq -Rs '{content: .}' < data/mock/seats.csv)"
```

**Spend** loads through the billing import endpoints — users first, so the billing
imports can report `unknownLogins` correctly:

```bash
curl -X POST http://localhost:4000/api/import/users \
  -H 'content-type: text/csv' \
  --data-binary @data/mock/user-export.csv
curl -X POST http://localhost:4000/api/import/billing \
  -H 'content-type: text/csv' \
  --data-binary @data/mock/AIUsageReport_1.csv
curl -X POST http://localhost:4000/api/import/billing \
  -H 'content-type: text/csv' \
  --data-binary @data/mock/AIUsageReport_2.csv
```

**JIRA people** have no CSV — with `COPILOT_SOURCE=mock` the sync generates the
same deterministic people the saml ids in `user-export.csv` point at:

```bash
curl -X POST http://localhost:4000/api/jira/sync
```

**Daily series** have no import endpoint; load them straight into Postgres — the
headers match the column names. If you run the API with a non-default `DB_SCHEMA`,
prefix each table name with it (e.g. `\copy myschema.org_daily(...)`):

```bash
psql "$DATABASE_URL" \
  -c "\copy org_daily(date,daily_active_users,weekly_active_users,monthly_active_users,interactions,generations,acceptances,loc_added,loc_deleted) FROM 'data/mock/org_daily.csv' CSV HEADER" \
  -c "\copy model_daily(date,model,generations,acceptances,loc_added,loc_deleted) FROM 'data/mock/model_daily.csv' CSV HEADER"
```

## Files

| File | Rows | Loads into | Notes |
| --- | --- | --- | --- |
| `seats.csv` | 1,000 | `copilot_seats` via `POST /api/import` | headers per `docs/import-format.md`; empty cell = unknown (`NULL`) |
| `org_daily.csv` | 90 | `org_daily` | org-aggregate activity per day |
| `model_daily.csv` | 450 | `model_daily` | per-day per-model activity |
| `AIUsageReport_1.csv` | ~25k | `model_spend_daily` via `POST /api/import/billing` | per-model AI-credit stats, real Report 1 shape — never summed into money totals |
| `AIUsageReport_2.csv` | ~40k | `billing_daily` via `POST /api/import/billing` | money authority (gross/discount/net per sku), real Report 2 shape, last 30 days |
| `user-export.csv` | 1,000 | `github_users` via `POST /api/import/users` | login → saml_name_id; a few blanks stay unmapped on purpose |
