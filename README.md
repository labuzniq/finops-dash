# RBCZ FinOps Dashboard

GitHub Copilot spend dashboard. React + TypeScript frontend, Fastify + Postgres backend,
in a pnpm monorepo.

Built from the design handoff in [`docs/handoff.md`](docs/handoff.md); the visual reference
prototype lives in `.claude/design/` and the Nocturne design system in `.claude/design-system/`.

## Quick start

First time only:

```bash
cp .env.example .env             # required — the API reads it
pnpm install
```

Then, to start everything:

```bash
pnpm dev
```

That starts Postgres in Docker, waits for it to be healthy, and runs the API (`:4000`)
and the web app (`:5173`) in watch mode. Open **http://localhost:5173**.

The API migrates on boot and, finding an empty database, seeds itself with 1,000 mock
seats — so this works with no GitHub credentials.

> `pnpm dev` runs the API **locally** for watch mode. Don't also run the API container:
> both bind port 4000. `docker compose up` deliberately starts Postgres only — the API
> container is behind the `full` profile, and `pnpm stack:up` is how you start it.

### Running the API in its container instead

```bash
pnpm stack:up                   # Postgres + API container on :4000
pnpm dev:web                     # web only, on :5173
```

Use this to exercise the real container — no local API, so no port clash. `pnpm stack:down`
stops it.

## Layout

```
apps/
  api/           Fastify + drizzle + Postgres. Containerised.
    src/copilot/   the data-source adapter — mock.ts and github.ts behind one interface
    src/services/  refresh (the async job) and dashboard (the read paths)
    src/routes/    HTTP surface
  web/           Vite + React. CSS Modules, no UI framework.
    src/lib/metrics/  pure derivations — filter, spend, chart, utilization, table, idle
    src/hooks/        data fetching + the memoised metrics pipeline
    src/components/   one folder-level component per design panel
packages/
  shared/        types + the cost model, imported by both apps
```

`packages/shared` is the contract: `CopilotSeat`, `SpendPoint`, `RefreshJob`, and the
cost model (plan prices, premium-request allowances, the $0.04 overage rate). Both sides
import it, so a price change lands in exactly one file.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | **starts everything** — Postgres, then api + web locally in watch mode |
| `pnpm db` | Postgres alone, if you want it without the apps |
| `pnpm dev:web` | web only — pair with `pnpm stack:up` when the API runs in its container |
| `pnpm stack:up` / `pnpm stack:down` | start / stop the full container stack (Postgres + API) |
| `pnpm build` | builds every package in dependency order |
| `pnpm typecheck` | typechecks the whole workspace |
| `pnpm db:generate` | regenerates SQL migrations after editing `schema.ts` |
| `pnpm db:migrate` | applies migrations (the API also does this on boot) |

Local commands read `.env` via node's `--env-file`; the container gets its environment
from compose. Both need `.env` to exist — copy it from `.env.example` first.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | liveness + which data source is active |
| `GET /api/seats` | every seat (~1,000 rows; the client filters and pages) |
| `GET /api/spend?days=90` | daily spend, split license vs premium overage |
| `POST /api/refresh` | start a sync → `202` + the job to poll |
| `GET /api/refresh/:id` | one job's status |
| `GET /api/refresh/latest` | last job of any status — drives the "synced 2h ago" note |
| `GET /api/telemetry/rollup?days=90` | Claude Code telemetry, rolled up per (day, user, model, metric, type) |
| `POST /v1/metrics` / `POST /v1/logs` | **OTLP/HTTP ingest** (JSON encoding) — see below |

## OTLP ingest (Claude Code telemetry)

The API doubles as an OTLP/HTTP server on the standard exporter paths, so Claude Code
clients can stream their metrics straight into the dashboard. These are the only
endpoints outside the login gate — exporters are headless. Protect them with
`OTLP_INGEST_TOKEN` (bearer auth); unset means open, for local development.

Point a Claude Code install at it:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json     # this ingest speaks JSON, not protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4000
# with OTLP_INGEST_TOKEN set:
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"
```

Datapoints land in `otlp_metric_points` (cumulative counters are normalised to deltas
at ingest, so reads are plain SUMs); events land in `otlp_log_records`. The **Claude
Code** page in the sidebar renders the rollup — cost, tokens, sessions and per-user
activity, filterable by user and model.

### The refresh is asynchronous

`POST /api/refresh` inserts a job row, returns `202` immediately, and syncs in the
background. The client polls the job until it reaches `succeeded` or `failed`, then
invalidates its data queries. There is no broker: the job table *is* the queue, the audit
log, and the UI's status source.

Two guarantees worth knowing:

- **A refresh already in flight is returned rather than duplicated** — double-clicking
  Import cannot start two concurrent syncs.
- **A failed fetch leaves existing data untouched.** Seats are replaced inside a
  transaction only after every upstream call has succeeded.

In the UI the sync is triggered from **+ Add data → Connected sources → Import**.

## Data sources

Set by `COPILOT_SOURCE`:

- **`mock`** (default) — a seeded 1,000-seat generator ported from the design prototype.
  No credentials; deterministic roster; activity dates anchored to today.
- **`github`** — the live Copilot APIs. Requires `GITHUB_TOKEN` (scope
  `manage_billing:copilot`) and `GITHUB_ORG`. The API refuses to boot if either is
  missing.

Both implement one `CopilotClient` interface, so nothing outside `src/copilot/` knows
which is in use.

**Important:** GitHub does not expose everything the design shows. See
[`docs/handoff.md` → Data gaps](docs/handoff.md#data-gaps-github-vs-the-design) for what
`github` can and cannot fill, and why some cells render `—`.

## Conventions

- **Every colour, radius and font comes from `src/styles/tokens.css`** — the Nocturne
  token layer. No hex literals in components.
- **Metrics are derived, never stored.** `useDashboardMetrics` memoises a pipeline of
  pure functions from `src/lib/metrics/`; at 1,000 seats it runs in ~10ms.
- **Charts are hand-rolled SVG**, not a charting library — the prototype's path maths
  ports directly and keeps the design pixel-exact with zero dependencies.
- **Money is stored as integer cents.** Postgres `numeric` round-trips as a string and
  floats drift.
- **Nulls mean "unknown", not zero**, and render as `—`.
