# Graph Report - Dash  (2026-07-20)

## Corpus Check
- 104 files · ~52,097 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 866 nodes · 1508 edges · 51 communities (49 shown, 2 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 41 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `403ff056`
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

## God Nodes (most connected - your core abstractions)
1. `cx()` - 25 edges
2. `count()` - 21 edges
3. `compilerOptions` - 18 edges
4. `App()` - 15 edges
5. `usd()` - 14 edges
6. `renderVals (all derivations + chart path maths)` - 13 edges
7. `buildApp()` - 12 edges
8. `Handoff: GitHub Copilot Spend Dashboard (FinOps page 1)` - 12 edges
9. `parseMetrics()` - 11 edges
10. `Card()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `KPI row — 4 equal cards` --shares_data_with--> `renderVals (all derivations + chart path maths)`  [INFERRED]
  docs/handoff.md → design/GitHub Copilot Spend.dc.html
- `Theme CSS variable layer (.theme / .theme.dark / accent classes)` --semantically_similar_to--> `Every colour, radius and font comes from tokens.css`  [INFERRED] [semantically similar]
  design/GitHub Copilot Spend.dc.html → README.md
- `Identity-keyed memo of renderVals output` --semantically_similar_to--> `Metrics are derived, never stored`  [INFERRED] [semantically similar]
  design/GitHub Copilot Spend.dc.html → README.md
- `ago (days-since formatter, null = Never used)` --semantically_similar_to--> `Nulls mean "unknown", not zero`  [INFERRED] [semantically similar]
  design/GitHub Copilot Spend.dc.html → README.md
- `Client fetches all seats once and filters/sorts/pages client-side` --semantically_similar_to--> `Series scaled by filteredSeats/totalSeats`  [INFERRED] [semantically similar]
  docs/handoff.md → design/GitHub Copilot Spend.dc.html

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Asynchronous refresh flow — modal trigger, job row, polling, invalidation** — docs_handoff_add_data_modal, readme_async_refresh, readme_http_api_surface, docs_handoff_three_tables, readme_refresh_dedup_guarantee, readme_transactional_seat_replace, docs_handoff_no_refresh_affordance [EXTRACTED 1.00]
- **Prototype-to-React port — renderVals split into pure memoised metric modules** — design_github_copilot_spend_dc_rendervals, docs_handoff_rendervals_port, readme_use_dashboard_metrics, readme_metrics_derived_never_stored, design_github_copilot_spend_dc_memo, docs_handoff_client_side_pipeline [EXTRACTED 1.00]

## Communities (51 total, 2 thin omitted)

### Community 0 - "Web Dashboard Components"
Cohesion: 0.07
Nodes (48): FilterBar(), FilterBarProps, syncLabel(), SortableColumn, UserTableProps, BUCKET_COLOR, UtilizationDonut(), UtilizationDonutProps (+40 more)

### Community 1 - "Design Prototype Runtime"
Cohesion: 0.07
Nodes (49): load(), react, boot(), cdnScriptFor(), collectProps(), compileAttr(), compileTemplate(), contentKey() (+41 more)

### Community 2 - "API Server & Database Schema"
Cohesion: 0.32
Nodes (7): closeDb(), queryClient, migrationsFolder, runMigrations(), Env, schema, main()

### Community 3 - "Copilot Data Clients"
Cohesion: 0.19
Nodes (22): OtlpMetricPointInsert, asArray(), Attrs, AttrScalar, attrString(), decodeAnyValue(), decodeAttributes(), decodeTemporality() (+14 more)

### Community 4 - "Web Data Hooks & API Client"
Cohesion: 0.06
Nodes (54): fetchAuthStatus(), fetchLatestRefreshJob(), fetchModels(), fetchRefreshJob(), fetchSeats(), fetchSpend(), importData(), login() (+46 more)

### Community 5 - "API Package Dependencies"
Cohesion: 0.06
Nodes (35): dependencies, @dash/shared, drizzle-orm, fastify, @fastify/cors, postgres, zod, devDependencies (+27 more)

### Community 6 - "Web Package Dependencies"
Cohesion: 0.07
Nodes (29): dependencies, @dash/shared, @phosphor-icons/react, react-dom, @tanstack/react-query, devDependencies, @types/react, @types/react-dom (+21 more)

### Community 7 - "Shared Types & Cost Model"
Cohesion: 0.06
Nodes (42): SeatInsert, HEADER_ALIASES, importSeats(), isEmptyRecord(), normalise(), parseBool(), parseCsv(), ParsedRow (+34 more)

### Community 8 - "Base TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution (+11 more)

### Community 9 - "Add Data Modal"
Cohesion: 0.06
Nodes (49): acceptanceRate(), addDays(), dominant(), formatDay(), GithubCopilotClient, GithubSeat, GithubSeatsPage, IdeTotals (+41 more)

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
Cohesion: 0.17
Nodes (16): Vite web entry document, buildData (seeded mock generator), Component (prototype DCLogic class), today pinned to 2026-07-14, rnd (Lehmer LCG deterministic PRNG), api service (compose, `full` profile), API container behind the `full` profile, API waits on postgres service_healthy (+8 more)

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
Cohesion: 0.25
Nodes (8): ago (days-since formatter, null = Never used), CopilotSeat type, premiumRequests28d / acceptanceRate / language are nullable end-to-end, SpendPoint type, pnpm workspace (apps/* + packages/*), esbuild postinstall allowlisted, Nulls mean "unknown", not zero, packages/shared — the cross-app contract

### Community 21 - "Utilization & Wasted Spend"
Cohesion: 0.50
Nodes (5): Activity bucket boundaries (act7 / occ / dorm / never), Donut segments via stroke-dasharray offsets, The 29-day hole (open question), Seat utilization donut panel, Wasted spend panel

### Community 22 - "Cost Model Conventions"
Cohesion: 0.29
Nodes (7): costf (per-user period cost), Architecture (suggested), Core types, Cost model, Per-user usage & cost table, Cost model (plan prices, allowances, $0.04 overage), Money is stored as integer cents

### Community 23 - "Postgres Container Setup"
Cohesion: 0.14
Nodes (23): createCopilotClient(), copilotSeats, modelDaily, orgDaily, RefreshJobRow, refreshJobs, client, countExpr (+15 more)

### Community 26 - "import.ts"
Cohesion: 0.22
Nodes (15): buildApp(), PUBLIC_PATHS, clearSessionCookie(), hasSession(), readCookie(), setSessionCookie(), authRoutes(), loginBody (+7 more)

### Community 27 - "chart.ts"
Cohesion: 0.13
Nodes (20): ChartHoverLayer(), ChartHoverLayerProps, SpendTrendChart(), SpendTrendChartProps, usdCompact(), buildChartGeometry(), ChartGeometry, ChartHoverOptions (+12 more)

### Community 28 - "dashboard.ts"
Cohesion: 0.17
Nodes (16): ModelDailyRow, SeatRow, spendDaily, SpendRow, dateWindowQuery, daysQuery, isoDate, daysSince() (+8 more)

### Community 29 - "schema.ts"
Cohesion: 0.15
Nodes (13): Db, ModelDailyInsert, OrgDailyInsert, OrgDailyRow, OtlpLogRecordInsert, otlpLogRecords, otlpMetricPoints, planEnum (+5 more)

### Community 30 - "Nocturne design system"
Cohesion: 0.17
Nodes (11): Color, Components, Direction, Do, Don't, Files, How to use this, Icons (+3 more)

### Community 31 - "Handoff: GitHub Copilot Spend Dashboard (FinOps page 1)"
Cohesion: 0.20
Nodes (10): About the Design Files, Assets, Data sources (real integration targets), Design Tokens (Nocturne — full sheet in .claude/design-system/styles.css), Fidelity, Files, Handoff: GitHub Copilot Spend Dashboard (FinOps page 1), Interactions & Behavior (+2 more)

### Community 32 - "Screens / Views"
Cohesion: 0.20
Nodes (10): Add data modal, Charts row — grid `1fr 380px`, 14px gap, CSV import fills exactly the columns the API cannot provide, Filter bar, Header row, KPI row — 4 equal cards, No refresh affordance (open question), Screens / Views (+2 more)

### Community 33 - "AGENTS.md"
Cohesion: 0.15
Nodes (16): Card(), CardProps, LEGEND, SEGMENTS, TokenLeaderboard(), TokenUsageChart(), DateRangePicker(), DateRangePickerProps (+8 more)

### Community 34 - "refresh.ts"
Cohesion: 0.20
Nodes (15): ScaledSpendPoint, accumulateUser(), DailyTokenPoint, deriveTelemetry(), emptyUserRow(), isoDatesBetween(), isoDaysAgo(), MutableUserRow (+7 more)

### Community 35 - "GitHub Copilot integration"
Cohesion: 0.29
Nodes (6): GitHub Copilot integration, Spend is derived, not fetched, The data sources GitHub actually gives us, The reports API is indirect, Time ranges, What lands in the database

### Community 36 - "Manual import format (CSV / JSON / NDJSON)"
Cohesion: 0.33
Nodes (5): Accepted payloads, API shape, Columns, How rows are applied, Manual import format (CSV / JSON / NDJSON)

### Community 39 - "format.ts"
Cohesion: 0.27
Nodes (12): ClaudeCodePage(), ModelTable(), ModelTableProps, TopBar(), TopBarProps, compactCount(), count(), dateLabel() (+4 more)

### Community 40 - "reports.ts"
Cohesion: 0.26
Nodes (7): describe(), downloadNdjson(), fetchRetry(), GithubApi, ReportEnvelope, ReportResult, sleep()

### Community 41 - "Claude Code Telemetry — Visibility Expansion"
Cohesion: 0.17
Nodes (11): Approach, Claude Code Telemetry — Visibility Expansion, Components — `apps/web/src/components/claude/`, Data layer — `apps/web/src/lib/metrics/telemetry.ts`, Design, Error handling / empty states, Goal, Not touched (+3 more)

### Community 42 - "Dashboard calendar date-range picker — design"
Cohesion: 0.18
Nodes (10): Bounds & validation, Dashboard calendar date-range picker — design, Decisions (from brainstorming), Delta ("vs previous period"), Fixed 28d-window metrics, Goal, Slicing, State model (+2 more)

### Community 43 - "ClaudeCodePage.tsx"
Cohesion: 0.31
Nodes (5): fetchTelemetryRollup(), daysSinceIso(), EMPTY_ROWS, UserRow(), useTelemetryRollup()

### Community 44 - "UserTable.tsx"
Cohesion: 0.42
Nodes (7): modelTitle(), SORTABLE_COLUMNS, UserTable(), WastedSpendPanel(), lastActiveLabel(), optionalCount(), usd()

### Community 45 - "Global Constraints"
Cohesion: 0.22
Nodes (8): Claude Code Telemetry Visibility Implementation Plan, Global Constraints, Self-review notes, Task 1: Derivation layer — tokens by day, token leaderboard, org totals, per-user PRs, Task 2: Token chart geometry + `TokenUsageChart` component, Task 3: `TokenLeaderboard` component, Task 4: Wire the page — output KPI tiles, chart row, leaderboard, PRs column, Task 5: Drive the app and verify

### Community 46 - "AGENTS.md"
Cohesion: 0.25
Nodes (7): AGENTS.md, ALWAYS WORK LIKE THIS, Architecture, Commands, Design sources, Gotchas, Invariants

### Community 47 - "ConnectedSourcesTab.tsx"
Cohesion: 0.33
Nodes (6): ConnectedSourcesTab(), ConnectedSourcesTabProps, GITHUB_SOURCES, Source, statusText(), SyncState

### Community 48 - "Static token login — design"
Cohesion: 0.29
Nodes (6): Backend (`apps/api`), Decisions, Frontend (`apps/web`), Static token login — design, Verification (no test framework in repo — drive the app), What the operator must do

### Community 49 - "[impl] Implementation notes"
Cohesion: 0.33
Nodes (4): Architecture notes, Deviations from the spec, [impl] Implementation notes, Open questions for design

### Community 50 - "Mock dataset (CSV)"
Cohesion: 0.50
Nodes (3): Files, Loading, Mock dataset (CSV)

## Knowledge Gaps
- **314 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+309 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `request()` connect `import.ts` to `Web Data Hooks & API Client`?**
  _High betweenness centrality (0.183) - this node is a cross-community bridge._
- **Why does `load()` connect `Design Prototype Runtime` to `API Server & Database Schema`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _314 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Web Dashboard Components` be split into smaller, more focused modules?**
  _Cohesion score 0.07393483709273183 - nodes in this community are weakly interconnected._
- **Should `Design Prototype Runtime` be split into smaller, more focused modules?**
  _Cohesion score 0.06610259122157588 - nodes in this community are weakly interconnected._
- **Should `Web Data Hooks & API Client` be split into smaller, more focused modules?**
  _Cohesion score 0.05547785547785548 - nodes in this community are weakly interconnected._
- **Should `API Package Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._