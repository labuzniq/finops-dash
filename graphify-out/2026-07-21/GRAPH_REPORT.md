# Graph Report - Dash  (2026-07-21)

## Corpus Check
- 117 files · ~68,333 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1002 nodes · 1775 edges · 55 communities (53 shown, 2 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 46 edges (avg confidence: 0.77)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ca95d18c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Web Dashboard Components
- Design Prototype Runtime
- API Server & Database Schema
- Copilot Data Clients
- Web Data Hooks & API Client
- API Package Dependencies
- Web Package Dependencies
- Shared Types & Cost Model
- Base TypeScript Config
- Add Data Modal
- Root Workspace Scripts
- Shared Package Manifest
- Web TypeScript Config
- Nocturne Design System
- Prototype Metric Formatters
- Data Sources & Docker Stack
- API TypeScript Config
- Async Refresh Design
- Shared TypeScript Config
- Avatar Rendering
- Seat & Spend Data Contract
- Utilization & Wasted Spend
- Cost Model Conventions
- Postgres Container Setup
- import.ts
- chart.ts
- dashboard.ts
- schema.ts
- Nocturne design system
- Handoff: GitHub Copilot Spend Dashboard (FinOps page 1)
- Screens / Views
- AGENTS.md
- refresh.ts
- GitHub Copilot integration
- Manual import format (CSV / JSON / NDJSON)
- Theme CSS variable layer (.theme / .theme.dark / accent classes)
- Inter 400/500/600 from Google Fonts
- format.ts
- reports.ts
- Claude Code Telemetry — Visibility Expansion
- Dashboard calendar date-range picker — design
- ClaudeCodePage.tsx
- UserTable.tsx
- Global Constraints
- AGENTS.md
- ConnectedSourcesTab.tsx
- Static token login — design
- [impl] Implementation notes
- Mock dataset (CSV)
- Merged Usage Charts — Design
- export-mock-csv.ts
- Global Constraints
- TeamsPanel.tsx

## God Nodes (most connected - your core abstractions)
1. `cx()` - 27 edges
2. `count()` - 24 edges
3. `compilerOptions` - 18 edges
4. `App()` - 16 edges
5. `Card()` - 14 edges
6. `usd()` - 14 edges
7. `renderVals (all derivations + chart path maths)` - 13 edges
8. `buildApp()` - 12 edges
9. `Handoff: GitHub Copilot Spend Dashboard (FinOps page 1)` - 12 edges
10. `Global Constraints` - 12 edges

## Surprising Connections (you probably didn't know these)
- `KPI row — 4 equal cards` --shares_data_with--> `renderVals (all derivations + chart path maths)`  [INFERRED]
  docs/handoff.md → design/GitHub Copilot Spend.dc.html
- `pnpm workspace (apps/* + packages/*)` --references--> `packages/shared — the cross-app contract`  [INFERRED]
  pnpm-workspace.yaml → README.md
- `Theme CSS variable layer (.theme / .theme.dark / accent classes)` --semantically_similar_to--> `Every colour, radius and font comes from tokens.css`  [INFERRED] [semantically similar]
  design/GitHub Copilot Spend.dc.html → README.md
- `Identity-keyed memo of renderVals output` --semantically_similar_to--> `Metrics are derived, never stored`  [INFERRED] [semantically similar]
  design/GitHub Copilot Spend.dc.html → README.md
- `ago (days-since formatter, null = Never used)` --semantically_similar_to--> `Nulls mean "unknown", not zero`  [INFERRED] [semantically similar]
  design/GitHub Copilot Spend.dc.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Asynchronous refresh flow — modal trigger, job row, polling, invalidation** — docs_handoff_add_data_modal, readme_async_refresh, readme_http_api_surface, docs_handoff_three_tables, readme_refresh_dedup_guarantee, readme_transactional_seat_replace, docs_handoff_no_refresh_affordance [EXTRACTED 1.00]
- **Prototype-to-React port — renderVals split into pure memoised metric modules** — design_github_copilot_spend_dc_rendervals, docs_handoff_rendervals_port, readme_use_dashboard_metrics, readme_metrics_derived_never_stored, design_github_copilot_spend_dc_memo, docs_handoff_client_side_pipeline [EXTRACTED 1.00]

## Communities (55 total, 2 thin omitted)

### Community 0 - "Web Dashboard Components"
Cohesion: 0.07
Nodes (43): FilterBar(), FilterBarProps, syncLabel(), ConnectedSourcesTab(), ConnectedSourcesTabProps, GITHUB_SOURCES, Source, statusText() (+35 more)

### Community 1 - "Design Prototype Runtime"
Cohesion: 0.07
Nodes (49): load(), react, boot(), cdnScriptFor(), collectProps(), compileAttr(), compileTemplate(), contentKey() (+41 more)

### Community 2 - "API Server & Database Schema"
Cohesion: 0.15
Nodes (26): TrendChart(), TrendChartProps, TrendVariant, buildSections(), ChartSpec, COUNTS, PERCENTS, Section (+18 more)

### Community 3 - "Copilot Data Clients"
Cohesion: 0.14
Nodes (28): OtlpLogRecordInsert, otlpLogRecords, OtlpMetricPointInsert, asArray(), Attrs, AttrScalar, attrString(), decodeAnyValue() (+20 more)

### Community 4 - "Web Data Hooks & API Client"
Cohesion: 0.06
Nodes (55): fetchAuthStatus(), fetchLatestRefreshJob(), fetchModels(), fetchRefreshJob(), fetchSeats(), fetchSpend(), fetchUsage(), importData() (+47 more)

### Community 5 - "API Package Dependencies"
Cohesion: 0.05
Nodes (39): dependencies, @dash/shared, drizzle-orm, @elastic/ecs-pino-format, fastify, @fastify/cors, pino, postgres (+31 more)

### Community 6 - "Web Package Dependencies"
Cohesion: 0.07
Nodes (29): dependencies, @dash/shared, @phosphor-icons/react, react-dom, @tanstack/react-query, devDependencies, @types/react, @types/react-dom (+21 more)

### Community 7 - "Shared Types & Cost Model"
Cohesion: 0.07
Nodes (31): isIdle(), PLAN_PRICE, PREMIUM_ALLOWANCE, premiumOverage(), seatPeriodCost(), wastedMonthlySpend(), TELEMETRY_METRICS, TelemetryRollupRow (+23 more)

### Community 8 - "Base TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution (+11 more)

### Community 9 - "Add Data Modal"
Cohesion: 0.13
Nodes (22): Archetype, archetypeFor(), buildAdoptionDaily(), buildBreakdownDaily(), buildModelDaily(), buildOrgDaily(), buildSeats(), createRandom() (+14 more)

### Community 10 - "Root Workspace Scripts"
Cohesion: 0.11
Nodes (17): devDependencies, typescript, typescript, name, private, scripts, build, db (+9 more)

### Community 11 - "Shared Package Manifest"
Cohesion: 0.12
Nodes (16): devDependencies, typescript, exports, files, typescript, main, name, private (+8 more)

### Community 12 - "Web TypeScript Config"
Cohesion: 0.12
Nodes (15): compilerOptions, jsx, lib, noEmit, types, extends, include, ES2022 (+7 more)

### Community 13 - "Nocturne Design System"
Cohesion: 0.20
Nodes (10): API, Commands, Conventions, Data sources, Layout, OTLP ingest (Claude Code telemetry), Quick start, RBCZ FinOps Dashboard (+2 more)

### Community 14 - "Prototype Metric Formatters"
Cohesion: 0.20
Nodes (12): avc (avatar tint from rotating 3-colour set), dlbl (date axis label), ini (initials from name), kfmt (compact $k axis formatter), Identity-keyed memo of renderVals output, renderVals (all derivations + chart path maths), usd (currency formatter), renderVals() ported as pure metric modules (+4 more)

### Community 15 - "Data Sources & Docker Stack"
Cohesion: 0.19
Nodes (14): buildData (seeded mock generator), today pinned to 2026-07-14, rnd (Lehmer LCG deterministic PRNG), api service (compose, `full` profile), API container behind the `full` profile, API waits on postgres service_healthy, postgres service (compose), Data gaps: GitHub vs the design (+6 more)

### Community 16 - "API TypeScript Config"
Cohesion: 0.18
Nodes (10): compilerOptions, outDir, rootDir, sourceMap, types, extends, include, src/**/*.ts (+2 more)

### Community 17 - "Async Refresh Design"
Cohesion: 0.33
Nodes (7): Series scaled by filteredSeats/totalSeats, Client fetches all seats once and filters/sorts/pages client-side, Three tables: copilot_seats, spend_daily, refresh_jobs, Asynchronous refresh — the job table is the queue, HTTP API surface (health, seats, spend, refresh), In-flight refresh is returned, not duplicated, Seats replaced in a transaction only after every upstream call succeeds

### Community 18 - "Shared TypeScript Config"
Cohesion: 0.18
Nodes (10): compilerOptions, declaration, declarationMap, outDir, rootDir, sourceMap, extends, include (+2 more)

### Community 19 - "Avatar Rendering"
Cohesion: 0.36
Nodes (5): Avatar(), AvatarProps, avatarTint(), TINTS, initials()

### Community 20 - "Seat & Spend Data Contract"
Cohesion: 0.18
Nodes (11): ago (days-since formatter, null = Never used), costf (per-user period cost), CopilotSeat type, Cost model, premiumRequests28d / acceptanceRate / language are nullable end-to-end, SpendPoint type, Per-user usage & cost table, Cost model (plan prices, allowances, $0.04 overage) (+3 more)

### Community 21 - "Utilization & Wasted Spend"
Cohesion: 0.50
Nodes (5): Activity bucket boundaries (act7 / occ / dorm / never), Donut segments via stroke-dasharray offsets, The 29-day hole (open question), Seat utilization donut panel, Wasted spend panel

### Community 22 - "Cost Model Conventions"
Cohesion: 0.13
Nodes (22): acceptanceRate(), accumulateBreakdown(), AdoptionPhaseTotals, aggregateUserRows(), breakdownSnapshots(), dominant(), FeatureTotals, GithubSeat (+14 more)

### Community 23 - "Postgres Container Setup"
Cohesion: 0.06
Nodes (64): createCopilotClient(), Db, queryClient, adoptionPhaseDaily, AdoptionPhaseInsert, AdoptionPhaseRow, copilotSeats, modelDaily (+56 more)

### Community 26 - "import.ts"
Cohesion: 0.08
Nodes (42): buildApp(), PUBLIC_PATHS, clearSessionCookie(), hasSession(), readCookie(), setSessionCookie(), closeDb(), log (+34 more)

### Community 27 - "chart.ts"
Cohesion: 0.14
Nodes (18): ChartHoverLayer(), ChartHoverLayerProps, dateLabel(), usdCompact(), buildChartGeometry(), ChartHoverOptions, EMPTY_GEOMETRY, GRID_FRACTIONS (+10 more)

### Community 28 - "dashboard.ts"
Cohesion: 0.18
Nodes (11): addDays(), adoptionSnapshots(), formatDay(), GithubCopilotClient, mapLimit(), orgSnapshot(), parseDay(), parsePlan() (+3 more)

### Community 29 - "schema.ts"
Cohesion: 0.12
Nodes (15): API (`routes/dashboard.ts`, `services/dashboard.ts`), Bug fix folded in: users-28-day aggregation, Components, Copilot Usage Views — Design, Data flow, Data model (Drizzle, `apps/api/src/db/schema.ts`), Decisions (user-confirmed), Goal (+7 more)

### Community 30 - "Nocturne design system"
Cohesion: 0.17
Nodes (11): Color, Components, Direction, Do, Don't, Files, How to use this, Icons (+3 more)

### Community 31 - "Handoff: GitHub Copilot Spend Dashboard (FinOps page 1)"
Cohesion: 0.17
Nodes (12): About the Design Files, Architecture (suggested), Assets, Core types, Data sources (real integration targets), Design Tokens (Nocturne — full sheet in .claude/design-system/styles.css), Fidelity, Files (+4 more)

### Community 32 - "Screens / Views"
Cohesion: 0.20
Nodes (10): Add data modal, Charts row — grid `1fr 380px`, 14px gap, CSV import fills exactly the columns the API cannot provide, Filter bar, Header row, KPI row — 4 equal cards, No refresh affordance (open question), Screens / Views (+2 more)

### Community 33 - "AGENTS.md"
Cohesion: 0.19
Nodes (13): Card(), CardProps, TokenUsageChart(), DateRangePicker(), DateRangePickerProps, KpiCard(), KpiCardProps, KpiRow() (+5 more)

### Community 34 - "refresh.ts"
Cohesion: 0.13
Nodes (26): deltaPercent(), mean(), parseIsoDate(), previousWindow(), scale(), ScaledSpendPoint, shiftIso(), sliceDates() (+18 more)

### Community 35 - "GitHub Copilot integration"
Cohesion: 0.29
Nodes (6): GitHub Copilot integration, Spend is derived, not fetched, The data sources GitHub actually gives us, The reports API is indirect, Time ranges, What lands in the database

### Community 36 - "Manual import format (CSV / JSON / NDJSON)"
Cohesion: 0.33
Nodes (5): Accepted payloads, API shape, Columns, How rows are applied, Manual import format (CSV / JSON / NDJSON)

### Community 39 - "format.ts"
Cohesion: 0.19
Nodes (17): ModelTable(), ModelTableProps, SpendTrendChart(), TopBar(), TopBarProps, modelTitle(), SORTABLE_COLUMNS, UserTable() (+9 more)

### Community 40 - "reports.ts"
Cohesion: 0.22
Nodes (10): describe(), downloadNdjson(), errorClues(), fetchRetry(), GithubApi, log, ReportEnvelope, ReportResult (+2 more)

### Community 41 - "Claude Code Telemetry — Visibility Expansion"
Cohesion: 0.17
Nodes (11): Approach, Claude Code Telemetry — Visibility Expansion, Components — `apps/web/src/components/claude/`, Data layer — `apps/web/src/lib/metrics/telemetry.ts`, Design, Error handling / empty states, Goal, Not touched (+3 more)

### Community 42 - "Dashboard calendar date-range picker — design"
Cohesion: 0.18
Nodes (10): Bounds & validation, Dashboard calendar date-range picker — design, Decisions (from brainstorming), Delta ("vs previous period"), Fixed 28d-window metrics, Goal, Slicing, State model (+2 more)

### Community 43 - "ClaudeCodePage.tsx"
Cohesion: 0.20
Nodes (12): fetchTelemetryRollup(), ClaudeCodePage(), daysSinceIso(), EMPTY_ROWS, UserRow(), LEGEND, SEGMENTS, TokenLeaderboard() (+4 more)

### Community 44 - "UserTable.tsx"
Cohesion: 0.14
Nodes (13): Copilot Usage Views Implementation Plan, Global Constraints, Task 10: Verify end-to-end, Task 11: PR, Task 1: Shared types, Task 2: DB schema + migration, Task 3: Snapshot contract + github client, Task 4: Mock client parity (+5 more)

### Community 45 - "Global Constraints"
Cohesion: 0.22
Nodes (8): Claude Code Telemetry Visibility Implementation Plan, Global Constraints, Self-review notes, Task 1: Derivation layer — tokens by day, token leaderboard, org totals, per-user PRs, Task 2: Token chart geometry + `TokenUsageChart` component, Task 3: `TokenLeaderboard` component, Task 4: Wire the page — output KPI tiles, chart row, leaderboard, PRs column, Task 5: Drive the app and verify

### Community 46 - "AGENTS.md"
Cohesion: 0.25
Nodes (7): AGENTS.md, ALWAYS WORK LIKE THIS, Architecture, Commands, Design sources, Gotchas, Invariants

### Community 47 - "ConnectedSourcesTab.tsx"
Cohesion: 0.29
Nodes (7): MockCopilotClient, AdoptionPhaseDailySnapshot, BreakdownDailySnapshot, CopilotClient, ModelDailySnapshot, OffRosterPremium, OrgDailySnapshot

### Community 48 - "Static token login — design"
Cohesion: 0.29
Nodes (6): Backend (`apps/api`), Decisions, Frontend (`apps/web`), Static token login — design, Verification (no test framework in repo — drive the app), What the operator must do

### Community 49 - "[impl] Implementation notes"
Cohesion: 0.20
Nodes (8): Vite web entry document, Component (prototype DCLogic class), Architecture notes, Deviations from the spec, [impl] Implementation notes, Open questions for design, pnpm workspace (apps/* + packages/*), esbuild postinstall allowlisted

### Community 50 - "Mock dataset (CSV)"
Cohesion: 0.50
Nodes (3): Files, Loading, Mock dataset (CSV)

### Community 51 - "Merged Usage Charts — Design"
Cohesion: 0.20
Nodes (9): Component changes, Decisions (user-confirmed), Goal, Heading and label fixes (expand shortenings), Merged Usage Charts — Design, Out of scope, Resulting page layout, State (+1 more)

### Community 52 - "export-mock-csv.ts"
Cohesion: 0.25
Nodes (6): Cell, days, files, outDir, spend, RFC-4180

### Community 53 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Merged Usage Charts Implementation Plan, Task 1: Reducer state for usage metric toggles, Task 2: TrendChart variant mode, Task 3: UsageSections merge + headings, Task 4: App wiring, Task 5: Verify + PR

### Community 54 - "TeamsPanel.tsx"
Cohesion: 0.67
Nodes (3): TeamsPanel(), TeamsPanelProps, TeamStat

## Knowledge Gaps
- **375 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+370 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `request()` connect `import.ts` to `Copilot Data Clients`, `Web Data Hooks & API Client`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **Why does `load()` connect `Design Prototype Runtime` to `import.ts`?**
  _High betweenness centrality (0.090) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _375 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Web Dashboard Components` be split into smaller, more focused modules?**
  _Cohesion score 0.07372549019607844 - nodes in this community are weakly interconnected._
- **Should `Design Prototype Runtime` be split into smaller, more focused modules?**
  _Cohesion score 0.06610259122157588 - nodes in this community are weakly interconnected._
- **Should `Copilot Data Clients` be split into smaller, more focused modules?**
  _Cohesion score 0.1425287356321839 - nodes in this community are weakly interconnected._
- **Should `Web Data Hooks & API Client` be split into smaller, more focused modules?**
  _Cohesion score 0.05563093622795115 - nodes in this community are weakly interconnected._