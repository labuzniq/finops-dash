# Graph Report - .  (2026-07-16)

## Corpus Check
- Corpus is ~26,888 words - fits in a single context window. You may not need a graph.

## Summary
- 558 nodes · 928 edges · 26 communities
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 35 edges (avg confidence: 0.79)
- Token cost: 79,799 input · 0 output

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

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 18 edges
2. `cx()` - 14 edges
3. `count()` - 13 edges
4. `renderVals (all derivations + chart path maths)` - 13 edges
5. `App()` - 11 edges
6. `useDashboardMetrics()` - 10 edges
7. `scripts` - 10 edges
8. `buildSeats()` - 9 edges
9. `usd()` - 9 edges
10. `createRuntime()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Vite web entry document` --semantically_similar_to--> `Component (prototype DCLogic class)`  [INFERRED] [semantically similar]
  apps/web/index.html → design/GitHub Copilot Spend.dc.html
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
- **CopilotClient adapter pattern — one interface, mock and github behind it** — readme_copilot_client_interface, readme_mock_source, readme_github_source, docs_handoff_data_gaps, docker_compose_api [EXTRACTED 1.00]
- **Asynchronous refresh flow — modal trigger, job row, polling, invalidation** — docs_handoff_add_data_modal, readme_async_refresh, readme_http_api_surface, docs_handoff_three_tables, readme_refresh_dedup_guarantee, readme_transactional_seat_replace, docs_handoff_no_refresh_affordance [EXTRACTED 1.00]
- **Prototype-to-React port — renderVals split into pure memoised metric modules** — design_github_copilot_spend_dc_rendervals, docs_handoff_rendervals_port, readme_use_dashboard_metrics, readme_metrics_derived_never_stored, design_github_copilot_spend_dc_memo, docs_handoff_client_side_pipeline [EXTRACTED 1.00]

## Communities (26 total, 0 thin omitted)

### Community 0 - "Web Dashboard Components"
Cohesion: 0.06
Nodes (70): Card(), CardProps, FilterBar(), FilterBarProps, syncLabel(), KpiCard(), KpiCardProps, KpiRow() (+62 more)

### Community 1 - "Design Prototype Runtime"
Cohesion: 0.07
Nodes (48): load(), react, boot(), cdnScriptFor(), collectProps(), compileAttr(), compileTemplate(), contentKey() (+40 more)

### Community 2 - "API Server & Database Schema"
Cohesion: 0.09
Nodes (39): buildApp(), createCopilotClient(), closeDb(), Db, queryClient, migrationsFolder, runMigrations(), copilotSeats (+31 more)

### Community 3 - "Copilot Data Clients"
Cohesion: 0.09
Nodes (31): GithubCopilotClient, GithubSeat, GithubSeatsPage, GithubUsageItem, GithubUsageResponse, isoDate(), parseEditor(), parsePlan() (+23 more)

### Community 4 - "Web Data Hooks & API Client"
Cohesion: 0.09
Nodes (30): fetchLatestRefreshJob(), fetchRefreshJob(), fetchSeats(), fetchSpend(), startRefresh(), App(), EMPTY_SEATS, EMPTY_SERIES (+22 more)

### Community 5 - "API Package Dependencies"
Cohesion: 0.06
Nodes (33): dependencies, @dash/shared, drizzle-orm, fastify, @fastify/cors, postgres, zod, devDependencies (+25 more)

### Community 6 - "Web Package Dependencies"
Cohesion: 0.07
Nodes (29): dependencies, @dash/shared, @phosphor-icons/react, react-dom, @tanstack/react-query, devDependencies, @types/react, @types/react-dom (+21 more)

### Community 7 - "Shared Types & Cost Model"
Cohesion: 0.11
Nodes (18): isIdle(), PLAN_PRICE, PREMIUM_ALLOWANCE, premiumOverage(), seatPeriodCost(), wastedMonthlySpend(), CopilotSeat, Editor (+10 more)

### Community 8 - "Base TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution (+11 more)

### Community 9 - "Add Data Modal"
Cohesion: 0.16
Nodes (14): AddDataModal(), AddDataModalProps, TABS, ConnectedSourcesTab(), ConnectedSourcesTabProps, GITHUB_SOURCES, Source, statusText() (+6 more)

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
Cohesion: 0.19
Nodes (13): Inter 400/500/600 from Google Fonts, Component (prototype DCLogic class), Theme CSS variable layer (.theme / .theme.dark / accent classes), Accent-to-ground tuned to 3:1 — not for body copy, 2px accent :focus-visible ring, never the browser default, .lighten image wrapper (mix-blend-mode: lighten), Mono accent scheme — accent-2 is a stand-in role, Nocturne design system (+5 more)

### Community 14 - "Prototype Metric Formatters"
Cohesion: 0.18
Nodes (13): avc (avatar tint from rotating 3-colour set), dlbl (date axis label), ini (initials from name), kfmt (compact $k axis formatter), Identity-keyed memo of renderVals output, renderVals (all derivations + chart path maths), usd (currency formatter), KPI row — 4 equal cards (+5 more)

### Community 15 - "Data Sources & Docker Stack"
Cohesion: 0.23
Nodes (12): Vite web entry document, buildData (seeded mock generator), today pinned to 2026-07-14, rnd (Lehmer LCG deterministic PRNG), api service (compose, `full` profile), API container behind the `full` profile, Data gaps: GitHub vs the design, The date is real — prototype's pinned today removed (+4 more)

### Community 16 - "API TypeScript Config"
Cohesion: 0.18
Nodes (10): compilerOptions, outDir, rootDir, sourceMap, types, extends, include, src/**/*.ts (+2 more)

### Community 17 - "Async Refresh Design"
Cohesion: 0.20
Nodes (11): Series scaled by filteredSeats/totalSeats, Accent as a line and a glow, never a flood, Add data modal (sources / CSV / manual), Client fetches all seats once and filters/sorts/pages client-side, CSV import fills exactly the columns the API cannot provide, No refresh affordance (open question), Three tables: copilot_seats, spend_daily, refresh_jobs, Asynchronous refresh — the job table is the queue (+3 more)

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
Cohesion: 0.40
Nodes (5): costf (per-user period cost), Cost model (handoff spec), Per-user usage & cost table, Cost model (plan prices, allowances, $0.04 overage), Money is stored as integer cents

### Community 23 - "Postgres Container Setup"
Cohesion: 0.67
Nodes (3): API waits on postgres service_healthy, postgres service (compose), API migrates on boot and seeds an empty database

## Knowledge Gaps
- **178 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+173 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `EDITORS` connect `Copilot Data Clients` to `Shared Types & Cost Model`?**
  _High betweenness centrality (0.207) - this node is a cross-community bridge._
- **Why does `reclaimCandidates()` connect `Web Dashboard Components` to `Shared Types & Cost Model`?**
  _High betweenness centrality (0.202) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _178 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Web Dashboard Components` be split into smaller, more focused modules?**
  _Cohesion score 0.05506549051055867 - nodes in this community are weakly interconnected._
- **Should `Design Prototype Runtime` be split into smaller, more focused modules?**
  _Cohesion score 0.06721311475409836 - nodes in this community are weakly interconnected._
- **Should `API Server & Database Schema` be split into smaller, more focused modules?**
  _Cohesion score 0.08734693877551021 - nodes in this community are weakly interconnected._
- **Should `Copilot Data Clients` be split into smaller, more focused modules?**
  _Cohesion score 0.08562367864693446 - nodes in this community are weakly interconnected._