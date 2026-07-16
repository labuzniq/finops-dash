# Claude Code Telemetry — Visibility Expansion

**Date:** 2026-07-17
**Status:** Approved

## Goal

Expand the Claude Code dashboard (`ClaudeCodePage`) with deeper visibility into token
usage and engineering output: input/output token distinction over time, top users by
token usage, and org-wide lines-of-code / commit / pull-request totals.

## Scope decisions (from brainstorming)

- **Code by language: out of scope.** Claude Code's OTLP metrics carry no language
  attribute on `claude_code.lines_of_code.count`; the only proxy is `language` on
  `code_edit_tool.decision` log events, which are stored audit-only. Deliberately
  skipped rather than shipping a misleading approximation.
- **Top users by tokens:** separate leaderboard card; the per-user table stays
  cost-ranked.
- **Input/output distinction:** daily stacked chart (input / output / cache).
- **LoC / commits / PRs:** org-wide summary tiles plus a PRs column in the per-user
  table (LoC and commits columns already exist).

## Approach

Client-side derivation only. `GET /api/telemetry/rollup` already returns
per-(day, user, model, metric, type) rows for every needed metric —
`claude_code.token.usage` (types `input`/`output`/`cache`),
`claude_code.lines_of_code.count` (types `added`/`removed`),
`claude_code.commit.count`, `claude_code.pull_request.count`. No API, schema, or
shared-type changes. This follows the repo invariant: fetch once, derive the rest in
`lib/metrics/`.

## Design

### Data layer — `apps/web/src/lib/metrics/telemetry.ts`

`deriveTelemetry()` gains, all respecting the existing user/model filters and range:

- `dailyTokens: { date: string; input: number; output: number; cache: number }[]` —
  zero-filled across the selected range, from `claude_code.token.usage` rows keyed by
  `type`.
- `topUsersByTokens: { user: string; input: number; output: number; cache: number; total: number }[]` —
  top 8 users sorted by total tokens descending.
- Range-scoped totals: `linesAdded`, `linesRemoved`, `commits`, `pullRequests`.
- Existing per-user table rows gain a `pullRequests` field.

### Components — `apps/web/src/components/claude/`

- **`TokenUsageChart`** — daily stacked SVG bars (input / output / cache), hand-rolled
  like `SpendTrendChart` (no charting library, per repo invariant). Legend and hover
  values. Rendered beside the cost trend chart.
- **`TokenLeaderboard`** — card listing the top 8 users with horizontal bars segmented
  input / output / cache, plus formatted totals.
- **Summary tiles** — three new tiles: Lines of code (one tile, `+added / −removed`),
  Commits, PRs. Same tile component/style as the existing tiles.
- **Per-user table** — new `PRs` column after `Commits`, `—` (`EMPTY`) when null/absent.

### Styling

Every colour/radius/font from `apps/web/src/styles/tokens.css` (Nocturne). No hex
literals in components. CSS Modules. Input/output/cache series colours chosen from the
existing token palette.

### Error handling / empty states

- Missing metrics (e.g., an exporter that never sends `pull_request.count`) render as
  `—` via `EMPTY`, never zero-filled per-user — null means unknown. Org-wide tiles sum
  what exists; a metric with no rows at all shows `—`.
- Chart with no token rows in range renders the existing empty-chart treatment.

### Verification

`pnpm typecheck` (the repo's only automated gate), then drive the app with the mock
source (`pnpm dev`) and verify: chart stacks and filters correctly, leaderboard ranks
by total tokens, tiles and PR column react to range/user/model filters. Check the mock
generator emits commit / PR / LoC metrics; extend the mock (only) if it does not.

## Not touched

API routes, DB schema, OTLP ingest, `packages/shared` types — the rollup row shape is
already sufficient.
