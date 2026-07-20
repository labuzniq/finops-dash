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

**Daily series** have no import endpoint; load them straight into Postgres — the
headers match the column names. If you run the API with a non-default `DB_SCHEMA`,
prefix each table name with it (e.g. `\copy myschema.org_daily(...)`):

```bash
psql "$DATABASE_URL" \
  -c "\copy org_daily(date,daily_active_users,weekly_active_users,monthly_active_users,interactions,generations,acceptances,loc_added,loc_deleted) FROM 'data/mock/org_daily.csv' CSV HEADER" \
  -c "\copy model_daily(date,model,generations,acceptances,loc_added,loc_deleted) FROM 'data/mock/model_daily.csv' CSV HEADER" \
  -c "\copy spend_daily(date,license_cents,premium_overage_cents) FROM 'data/mock/spend_daily.csv' CSV HEADER"
```

## Files

| File | Rows | Loads into | Notes |
| --- | --- | --- | --- |
| `seats.csv` | 1,000 | `copilot_seats` via `POST /api/import` | headers per `docs/import-format.md`; empty cell = unknown (`NULL`) |
| `org_daily.csv` | 90 | `org_daily` | org-aggregate activity per day |
| `model_daily.csv` | 450 | `model_daily` | per-day per-model activity |
| `spend_daily.csv` | 90 | `spend_daily` | integer **cents**, derived from the roster by the shared cost model |
