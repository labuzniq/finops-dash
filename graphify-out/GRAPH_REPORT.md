# Graph Report - Dash  (2026-07-21)

## Corpus Check
- 131 files · ~86,478 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1190 nodes · 2167 edges · 67 communities (65 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 52 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `26687494`
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
- app.ts
- log.ts
- refresh-once.ts
- spend.ts
- Spend Data Redesign — Billing CSV Import + JIRA Identity
- Spend page layout redesign — design
- useAuth.ts
- Global Constraints
- App.tsx
- LoginScreen.tsx
- Sidebar.tsx
- exportCsv.ts

## God Nodes (most connected - your core abstractions)
1. `cx()` - 34 edges
2. `count()` - 28 edges
3. `App()` - 19 edges
4. `compilerOptions` - 18 edges
5. `Card()` - 16 edges
6. `SpendSection()` - 15 edges
7. `usd()` - 15 edges
8. `buildApp()` - 14 edges
9. `moduleLogger()` - 13 edges
10. `eventDuration()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `reclaimCandidates()` --indirect_call--> `isIdle()`  [INFERRED]
  apps/web/src/lib/metrics/idle.ts → packages/shared/src/idle.ts
- `KPI row — 4 equal cards` --shares_data_with--> `renderVals (all derivations + chart path maths)`  [INFERRED]
  docs/handoff.md → design/GitHub Copilot Spend.dc.html
- `pnpm workspace (apps/* + packages/*)` --references--> `packages/shared — the cross-app contract`  [INFERRED]
  pnpm-workspace.yaml → README.md
- `Theme CSS variable layer (.theme / .theme.dark / accent classes)` --semantically_similar_to--> `Every colour, radius and font comes from tokens.css`  [INFERRED] [semantically similar]
  design/GitHub Copilot Spend.dc.html → README.md
- `Identity-keyed memo of renderVals output` --semantically_similar_to--> `Metrics are derived, never stored`  [INFERRED] [semantically similar]
  design/GitHub Copilot Spend.dc.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Asynchronous refresh flow — modal trigger, job row, polling, invalidation** — docs_handoff_add_data_modal, readme_async_refresh, readme_http_api_surface, docs_handoff_three_tables, readme_refresh_dedup_guarantee, readme_transactional_seat_replace, docs_handoff_no_refresh_affordance [EXTRACTED 1.00]
- **Prototype-to-React port — renderVals split into pure memoised metric modules** — design_github_copilot_spend_dc_rendervals, docs_handoff_rendervals_port, readme_use_dashboard_metrics, readme_metrics_derived_never_stored, design_github_copilot_spend_dc_memo, docs_handoff_client_side_pipeline [EXTRACTED 1.00]

## Communities (67 total, 2 thin omitted)

### Community 0 - "Web Dashboard Components"
Cohesion: 0.07
Nodes (48): Avatar(), AvatarProps, FilterBar(), FilterBarProps, syncLabel(), SpendSectionProps, SORTABLE_COLUMNS, SortableColumn (+40 more)

### Community 1 - "Design Prototype Runtime"
Cohesion: 0.07
Nodes (47): load(), boot(), cdnScriptFor(), collectProps(), compileAttr(), compileTemplate(), contentKey(), createComponentFactory() (+39 more)

### Community 2 - "API Server & Database Schema"
Cohesion: 0.11
Nodes (35): MONEY_FORMAT, SpendTrendCard(), SpendTrendCardProps, TeamsPanel(), TeamsPanelProps, TrendChart(), TrendChartProps, TrendVariant (+27 more)

### Community 3 - "Copilot Data Clients"
Cohesion: 0.16
Nodes (26): OtlpMetricPointInsert, asArray(), Attrs, AttrScalar, attrString(), decodeAnyValue(), decodeAttributes(), decodeTemporality() (+18 more)

### Community 4 - "Web Data Hooks & API Client"
Cohesion: 0.20
Nodes (17): fetchModels(), fetchRefreshJob(), fetchSeats(), fetchUsage(), importBillingReport(), postCsv(), startJiraSync(), startRefresh() (+9 more)

### Community 5 - "API Package Dependencies"
Cohesion: 0.05
Nodes (39): dependencies, @dash/shared, drizzle-orm, @elastic/ecs-pino-format, fastify, @fastify/cors, pino, postgres (+31 more)

### Community 6 - "Web Package Dependencies"
Cohesion: 0.06
Nodes (31): dependencies, @dash/shared, @phosphor-icons/react, react, react-dom, @tanstack/react-query, devDependencies, @types/react (+23 more)

### Community 7 - "Shared Types & Cost Model"
Cohesion: 0.06
Nodes (32): isIdle(), BillingImportResult, BillingRow, BillingSku, ModelSpendRow, SpendPayload, SpendPerson, TELEMETRY_METRICS (+24 more)

### Community 8 - "Base TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution (+11 more)

### Community 9 - "Add Data Modal"
Cohesion: 0.10
Nodes (33): Archetype, archetypeFor(), buildAdoptionDaily(), buildBreakdownDaily(), buildMockBillingReport(), buildMockIdentity(), buildModelDaily(), buildOrgDaily() (+25 more)

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
Cohesion: 0.13
Nodes (27): fetchSpend(), ModelSpendChart(), ModelSpendChartProps, SpendKpiRow(), SpendKpiRowProps, EMPTY_BILLING, EMPTY_MODELS, EMPTY_PEOPLE (+19 more)

### Community 20 - "Seat & Spend Data Contract"
Cohesion: 0.18
Nodes (11): ago (days-since formatter, null = Never used), costf (per-user period cost), CopilotSeat type, Cost model, premiumRequests28d / acceptanceRate / language are nullable end-to-end, SpendPoint type, Per-user usage & cost table, Cost model (plan prices, allowances, $0.04 overage) (+3 more)

### Community 21 - "Utilization & Wasted Spend"
Cohesion: 0.50
Nodes (5): Activity bucket boundaries (act7 / occ / dorm / never), Donut segments via stroke-dasharray offsets, The 29-day hole (open question), Seat utilization donut panel, Wasted spend panel

### Community 22 - "Cost Model Conventions"
Cohesion: 0.12
Nodes (26): acceptanceRate(), accumulateBreakdown(), addDays(), AdoptionPhaseTotals, adoptionSnapshots(), breakdownSnapshots(), dominant(), FeatureTotals (+18 more)

### Community 23 - "Postgres Container Setup"
Cohesion: 0.08
Nodes (38): adoptionPhaseDaily, AdoptionPhaseInsert, AdoptionPhaseRow, BillingDailyRow, copilotSeats, GithubUserRow, JiraPersonInsert, modelDaily (+30 more)

### Community 26 - "import.ts"
Cohesion: 0.06
Nodes (57): BillingDailyInsert, GithubUserInsert, ModelSpendDailyInsert, SeatInsert, billing, Cell, csv(), days (+49 more)

### Community 27 - "chart.ts"
Cohesion: 0.13
Nodes (20): ChartHoverLayerProps, dateLabel(), usdCompact(), buildChartGeometry(), ChartGeometry, ChartHoverOptions, EMPTY_GEOMETRY, GRID_FRACTIONS (+12 more)

### Community 28 - "dashboard.ts"
Cohesion: 0.15
Nodes (22): createCopilotClient(), RefreshJobRow, refreshJobs, jobParams, latestQuery, refreshRoutes(), ACTIVE_STATUSES, activeOfKind() (+14 more)

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
Cohesion: 0.12
Nodes (25): Card(), CardProps, ChartHoverLayer(), TokenUsageChart(), DateRangePicker(), DateRangePickerProps, ConnectedSourcesTab(), ConnectedSourcesTabProps (+17 more)

### Community 34 - "refresh.ts"
Cohesion: 0.20
Nodes (15): ChartSeriesPoint, accumulateUser(), deriveTelemetry(), emptyUserRow(), isoDatesBetween(), isoDaysAgo(), MutableUserRow, parseIsoDate() (+7 more)

### Community 35 - "GitHub Copilot integration"
Cohesion: 0.29
Nodes (6): GitHub Copilot integration, Spend is derived, not fetched, The data sources GitHub actually gives us, The reports API is indirect, Time ranges, What lands in the database

### Community 36 - "Manual import format (CSV / JSON / NDJSON)"
Cohesion: 0.33
Nodes (5): Accepted payloads, API shape, Columns, How rows are applied, Manual import format (CSV / JSON / NDJSON)

### Community 39 - "format.ts"
Cohesion: 0.20
Nodes (13): KpiCard(), KpiCardProps, KpiRow(), KpiRowProps, ModelTable(), ModelTableProps, TopBar(), TopBarProps (+5 more)

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
Nodes (11): fetchTelemetryRollup(), ClaudeCodePage(), daysSinceIso(), EMPTY_ROWS, UserRow(), LEGEND, SEGMENTS, TokenLeaderboard() (+3 more)

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
Cohesion: 0.18
Nodes (12): aggregateUserRows(), GithubCopilotClient, mergeTotals(), parsePlan(), MockCopilotClient, AdoptionPhaseDailySnapshot, BreakdownDailySnapshot, CopilotClient (+4 more)

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
Cohesion: 0.13
Nodes (23): importUserExport(), AddDataModal(), AddDataModalProps, TABS, detectReport(), headerColumns(), outcomeText(), REPORT_SLOTS (+15 more)

### Community 53 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Merged Usage Charts Implementation Plan, Task 1: Reducer state for usage metric toggles, Task 2: TrendChart variant mode, Task 3: UsageSections merge + headings, Task 4: App wiring, Task 5: Verify + PR

### Community 54 - "TeamsPanel.tsx"
Cohesion: 0.12
Nodes (15): ATTR, chunk(), firstLabel(), firstValue(), InsightJiraClient, JiraClient, JiraPerson, JiraRequestError (+7 more)

### Community 55 - "app.ts"
Cohesion: 0.25
Nodes (14): buildApp(), PUBLIC_PATHS, clearSessionCookie(), hasSession(), readCookie(), setSessionCookie(), closeDb(), Env (+6 more)

### Community 56 - "log.ts"
Cohesion: 0.18
Nodes (12): log, migrationsFolder, runMigrations(), createJiraClient(), eventDuration(), logger, moduleLogger(), jiraRoutes() (+4 more)

### Community 57 - "refresh-once.ts"
Cohesion: 0.17
Nodes (11): Db, queryClient, otlpMetricPoints, client, countExpr, days, log, startedAt (+3 more)

### Community 58 - "spend.ts"
Cohesion: 0.18
Nodes (13): billingDaily, githubUsers, jiraPeople, JiraPersonRow, modelSpendDaily, nanoToDollars(), isoDate, rangeQuery (+5 more)

### Community 59 - "Spend Data Redesign — Billing CSV Import + JIRA Identity"
Cohesion: 0.13
Nodes (14): CSV semantics (agreed reading), Decisions made, Error handling summary, Import pipeline, JIRA sync, Mock source, Out of scope, Problem (+6 more)

### Community 60 - "Spend page layout redesign — design"
Cohesion: 0.15
Nodes (12): Equal height, Files, Goals, Non-goals, Page order, Problem, Spend by model graph, Spend page layout redesign — design (+4 more)

### Community 61 - "useAuth.ts"
Cohesion: 0.24
Nodes (8): fetchAuthStatus(), logout(), AuthGate(), AuthGateProps, AuthStatus, useAuth, container, queryClient

### Community 62 - "Global Constraints"
Cohesion: 0.20
Nodes (9): Global Constraints, Spend Data Redesign Implementation Plan, Task 1: Shared contract — spend types, billing consts, delete fake cost model, Task 2: DB schema + fresh migrations, Task 3: CSV importers (billing reports + user export), Task 4: JIRA sync job + spend read endpoint + mock + fake-spend removal (api), Task 5: Web data layer + pure spend metrics, Task 6: Web UI — spend section, filters, cost-column removal (+1 more)

### Community 63 - "App.tsx"
Cohesion: 0.36
Nodes (8): fetchLatestRefreshJob(), App(), EMPTY_MODELS, EMPTY_SEATS, useLatestJiraJob(), useLatestRefreshJob(), seatLanguages(), dashboardReducer()

### Community 64 - "LoginScreen.tsx"
Cohesion: 0.43
Nodes (5): LoginScreen(), LoginScreenProps, readStoredTheme(), Theme, useTheme

### Community 65 - "Sidebar.tsx"
Cohesion: 0.29
Nodes (6): AppView, NAV_GROUPS, NavGroup, NavItem, Sidebar(), SidebarProps

### Community 66 - "exportCsv.ts"
Cohesion: 0.48
Nodes (6): buildSeatsCsv(), downloadSeatsCsv(), escapeCell(), HEADERS, toRow(), RFC-4180

## Knowledge Gaps
- **448 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+443 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `login()` connect `import.ts` to `AGENTS.md`, `Web Data Hooks & API Client`, `ConnectedSourcesTab.tsx`, `Avatar Rendering`, `spend.ts`, `useAuth.ts`?**
  _High betweenness centrality (0.114) - this node is a cross-community bridge._
- **Why does `load()` connect `Design Prototype Runtime` to `app.ts`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `App()` (e.g. with `search()` and `dashboardReducer()`) actually correct?**
  _`App()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _448 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Web Dashboard Components` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._
- **Should `Design Prototype Runtime` be split into smaller, more focused modules?**
  _Cohesion score 0.06949152542372881 - nodes in this community are weakly interconnected._
- **Should `API Server & Database Schema` be split into smaller, more focused modules?**
  _Cohesion score 0.10661268556005399 - nodes in this community are weakly interconnected._