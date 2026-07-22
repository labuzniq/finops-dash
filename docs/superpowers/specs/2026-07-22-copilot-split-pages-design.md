# Copilot Spend / Analytics Page Split — Design

**Date:** 2026-07-22
**Status:** Approved

## Goal

Split the single GitHub Copilot page into two pages — **Spend** and **Analytics** — reached from a collapsible "GitHub Copilot" section in the sidebar.

## Background

Today `App.tsx` renders one Copilot view containing, top to bottom: `TopBar`, `SpendSection` (billing-report money data), `FilterBar`, KPI row, per-user/per-model table toggle, `UtilizationDonut`, and `UsageSections`. Everything below `SpendSection` is usage/adoption analytics. The page is long; spend and usage serve different questions.

## Design

### Navigation

- `AppView` union in `Sidebar.tsx` becomes `'copilot-spend' | 'copilot-analytics' | 'claude-code'`.
- Default view on app load: `'copilot-spend'`.
- The "GitHub Copilot" sidebar item becomes a collapsible parent:
  - Click toggles expand/collapse only — it does not navigate.
  - Chevron indicator reflects open/closed state; expanded by default.
  - Children **Spend** and **Analytics** render indented beneath it, navigate to their views, and use the existing active-item styling.
  - Collapse state is local `useState` inside `Sidebar` (not persisted).
- All other sidebar items unchanged.

### Pages

Both pages render the existing `TopBar` (seat count, theme toggle, Add data, Export CSV).

- **Spend page** (`copilot-spend`): `TopBar` + `SpendSection`.
- **Analytics page** (`copilot-analytics`): `TopBar` + `FilterBar`, KPI row, per-user/per-model table toggle, `UserTable`/`ModelTable`, `UtilizationDonut`, `UsageSections`, plus the existing loading/error status handling for seats/usage queries.

To keep `App.tsx` lean, `TopBar` is rendered once in `App` for both Copilot views; the Spend page renders the existing `SpendSection` directly (a `CopilotSpendPage` wrapper would add nothing), and the analytics body is extracted into `CopilotAnalyticsPage` under `components/copilot/`. The analytics page subscribes to the shared react-query hooks itself and receives only dashboard state/dispatch, the seat metrics, and refresh status as props.

### State & data

- The single `dashboardReducer` stays at `App` level; filters, ranges, and table state survive switching between pages.
- Data hooks (`useSeats`, `useUsage`, `useModels`, refresh/Jira/import hooks) stay in `App` — `TopBar` and the modal need them on both pages.
- No API, hook, or data-shape changes.

### Styling

- Child-item indent and chevron styles added to `Sidebar.module.css`, following existing item styles.

## Error handling

Unchanged — existing load-error and loading states move with the Analytics page content; `SpendSection` keeps its own internal handling.

## Testing

No test suite in the repo; `pnpm typecheck` is the verification gate. Manual check: navigate between Spend, Analytics, Claude Code; collapse/expand the Copilot section; confirm filters persist across page switches.

## Rejected alternative

React-router-based routing: new dependency and URL surface for an app with three views and an established `useState` view pattern. Not needed.
