# Data sources + Imports pages — design

Date: 2026-07-25
Status: approved

## Goal

Retire the "Add data" modal. Promote its two tabs to first-class pages under the
sidebar's DATA group: **Data sources** (master dashboard of every source, present
and future) and **Imports** (CSV uploads plus a persistent import history).

## Data source inventory (current)

| Source | Kind | Mechanism |
| --- | --- | --- |
| Copilot usage metrics API | synced (`copilot` job) | on-demand refresh |
| Copilot user management API | synced (`copilot` job, shared) | on-demand refresh |
| GitHub billing API | synced (`billing` job) | daily 07:00 schedule + on-demand |
| JIRA Insight identity | synced (`jira` job) | on-demand |
| Model usage / Cost report / User export CSVs | uploaded | `POST /api/import/billing` (both reports, told apart by header), `POST /api/import/users` |
| OTLP telemetry (Claude Code) | push | arrives on its own, no sync affordance |
| Azure Cost Management | placeholder | disabled Connect row |

## 1. Navigation

- `AppView` gains `'data-sources'` and `'imports'`. The sidebar's DATA items
  ("Data sources", "Imports") become live navigation.
- TopBar loses the "+ Add data" button everywhere. Reload, Export CSV, and the
  theme toggle remain on the Copilot pages.
- `AddDataModal` and its modal wiring are deleted: `modalOpen`, `modalTab`,
  `openModal`/`closeModal`/`setModalTab` actions in `state/dashboardState.ts`
  go away. The content of `ConnectedSourcesTab` and `UploadReportsTab` moves
  into the new pages.

## 2. Data sources page

Master dashboard, grouped by provider. One row per source, reusing today's
status-dot pattern (`syncing` / `connected` / `failed` / `idle`).

- **GitHub Copilot**
  - Copilot usage metrics API + Copilot user management API — shared refresh
    job; a single Sync button syncs both rows.
  - GitHub billing API — own Sync button; row notes the daily 07:00 scheduled
    run.
- **JIRA** — Insight identity, own Sync button.
- **Claude Code** — OTLP telemetry row. Push source: no Sync button. Status is
  derived from the latest ingested datapoint (new API: latest
  `otlp_metric_points` timestamp).
- **Azure Cost Management** — placeholder row, disabled Connect button.

Each row shows: source name, fields synced, status dot, last-sync relative
time, inline error when the last job failed. Future sources are added as new
rows or provider groups on this page.

## 3. Imports page

- The three upload slots (Model usage, Cost report, User export) with the same
  client-side header check and Import button as the modal today.
- Below the slots: import history list backed by the new backend log.

## 4. Backend: import log

- New table `import_logs`: id, slot kind, filename, row count, status, error,
  created_at. Written by `services/import.ts` and the billing import path on
  every run.
- `GET /api/imports` returns recent history (most recent first, capped at 50).
- Slot-kind enum generated from a shared const array in `packages/shared`,
  same pattern as `REFRESH_KINDS`. Migration via `pnpm db:generate`; strip
  `"public".` qualifiers from the generated SQL (see repo gotchas).
- New API for telemetry freshness: latest `otlp_metric_points` timestamp
  (cheap max() query) to drive the Claude Code row's status.

## 5. Out of scope

- No changes to Spend/Analytics page content, the cost model, or refresh
  logic.
- Azure Cost Management stays inert.
- No import-log retention/pruning policy — append-only, like `refresh_jobs`.
