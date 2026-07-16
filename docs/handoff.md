# Handoff: GitHub Copilot Spend Dashboard (FinOps page 1)

> **Status: implemented.** This is the original design handoff, kept verbatim below as the
> spec of record. Sections marked **[impl]** were added during implementation and record
> where reality diverged from the spec. Start at [Data gaps](#data-gaps-github-vs-the-design)
> and [Open questions](#open-questions-for-design) — both need a designer's decision.

## Overview

First page of a multi-page FinOps console ("RBCZ FinOps"). It reports GitHub Copilot spend for an org (~1,000 seats): total spend and trend, seat utilization, per-user usage & cost, and wasted spend (idle seats). Data is ingested from GitHub's Copilot APIs, with CSV upload and manual entry as fallbacks. Light/dark mode, filterable by date range, editor/IDE, language, and user search.

**Target implementation: React + TypeScript.** No existing codebase was specified — Vite + React + TS (or Next.js if server rendering is wanted) is the recommended starting point.

## About the Design Files

The files in `.claude/design/` are **design references created in HTML** — a working interactive prototype showing intended look and behavior, not production code to copy directly. Your task is to **recreate this design in React + TypeScript** using idiomatic patterns (typed components, hooks, a charting approach of your choice). `.claude/design/GitHub Copilot Spend.dc.html` opens directly in a browser (it needs `support.js` next to it); its `<script data-dc-script>` block contains the full working logic — data model, derived metrics, filtering, sorting, chart-path math — which ports almost 1:1 to TypeScript.

`.claude/design-system/` contains the **Nocturne** design system the visuals follow: `styles.css` is the token sheet (color ramps, fonts, spacing, radii, shadows), `readme.md` its usage rules. Take every color/font/radius from these tokens.

## Fidelity

**High-fidelity.** Colors, typography, spacing, and interactions are final. Recreate pixel-perfectly.

## Architecture (suggested)

```
src/
  types.ts            // CopilotSeat, SpendPoint, Filters, SortKey …
  data/mock.ts        // seeded mock generator (port of buildData())
  data/github.ts      // future: real API adapters (see Data sources)
  hooks/useCopilotMetrics.ts  // filtering + derived metrics (port of renderVals())
  components/
    Sidebar.tsx, TopBar.tsx, FilterBar.tsx, KpiCard.tsx,
    SpendTrendChart.tsx, UtilizationDonut.tsx,
    UserTable.tsx, WastedSpendPanel.tsx, AddDataModal.tsx
  theme.css           // Nocturne tokens as CSS variables (copy from design-system/styles.css)
```

### Core types

```ts
type Plan = 'Business' | 'Enterprise';            // $19/mo | $39/mo
type Editor = 'VS Code' | 'JetBrains' | 'Visual Studio' | 'Neovim' | 'Xcode';

interface CopilotSeat {
  login: string;            // user_login
  name: string;
  plan: Plan;               // plan_type from seat API
  editor: Editor;           // last_activity_editor
  language: string;         // dominant language from usage metrics
  lastActivityDays: number | null;  // days since last_activity_at; null = never used
  premiumRequests28d: number;       // ai_credits_used / premium requests, 28-day window
  acceptanceRate: number;   // % suggestions accepted
}

interface SpendPoint { date: Date; license: number; premiumOverage: number; }
```

### Cost model

- License: Business $19/seat/mo, Enterprise $39/seat/mo (blended daily = seats × avgPrice / 30).
- Premium requests: allowance 300/mo (Business) or 1,000/mo (Enterprise); overage billed at **$0.04/request**: `overage = max(0, requests − allowance) × 0.04`.
- Per-user period cost: `plan price × (range/30) + overage × (range/28)`.
- Wasted spend/mo: Σ plan price over seats idle ≥30 days or never used.
- Utilization: seats active in last 28d ÷ filtered seats.

## Data sources (real integration targets)

- **Copilot usage metrics API** — per-user 28-day reports (`user_login`, `ai_credits_used`, per-IDE and per-language totals, engagement).
- **Copilot user management API** — seats: `plan_type`, `created_at`, `last_activity_at`, `last_activity_editor`.
- **GitHub billing API** — AI-credit/premium-request usage by model, SKU, cost center.
- **CSV/NDJSON upload** — expected columns: `user_login · plan · ai_credits_used · last_activity_at · editor · language`.
- **Manual entry** — single-seat rows with the same fields.

## Screens / Views

One screen: **Copilot spend report**, full-viewport, two-column shell.

### Shell
- **Sidebar** — 238px fixed, sticky full height, `--card` background, 1px right border (`--border`). Contents top→bottom: brand row (26px accent square with "R", "RBCZ FinOps" 15px/600); group label "OVERVIEW" (10.5px/600, letter-spacing .1em, `--faint`); nav items (13.5px, 8px 10px padding, radius 8, `--muted`, hover `--card2`); groups SPEND (GitHub Copilot **active**: accent text on 10% accent tint, Cloud infrastructure, LLM APIs, SaaS licenses) and DATA (Data sources, Imports); flex spacer; user card (28px round avatar, name 12.5px/600, role 11px `--faint`). Nav icons are simple 11px geometric shapes (square/circle/diamond outlines) in `currentColor` — replace with Phosphor icons in production (Nocturne's icon set).
- **Main column** — fluid, max-width 1560px, padding 24px 30px 30px, vertical stack with 16px gap.

### Header row
Title "GitHub Copilot" (20px/600), subtitle "Spend report · Acme Corp · 1,000 seats assigned" (12.5px `--muted`). Right cluster (14px gap): theme toggle (44×24 pill, `--border` track, 18px `--card` knob, 180ms transform transition, label "Light"/"Dark" 12px `--muted`), "Export CSV" secondary button (34px h, 1px `--border`, `--card` bg, 13px/500), "+ Add data" **primary = accent outline** (1px `--accent` border, transparent bg, accent text, hover 12% accent tint — Nocturne never fills primaries).

### Filter bar
Wrapping flex row, 10px gap: segmented range control (28d/56d/90d; track `--border2` radius 9, active segment `--card` bg + shadow); editor `<select>`; language `<select>` (34px h, radius 8, 1px `--border`, `--card` bg, 12.5px); user search input (210px, 32px h, placeholder "Search user or login…", focus border `--accent`); spacer; source note "usage metrics API · synced 2h ago" (11px/500 `--faint`).

### KPI row — 4 equal cards
Card: `--card` bg, 1px `--border`, radius 14, shadow `--shadow`, padding 16px 18px. Kicker 10.5px/600 letter-spacing .08em `--faint`, value 26px/600 tabular-nums, sub 12px.
1. TOTAL SPEND · {range} — delta sub "↑ +12.4% vs prev period", red (`--neg`) when up, green (`--pos`) when down.
2. AVG COST / ACTIVE USER — sub "license + premium requests".
3. SEAT UTILIZATION — sub "{active} of {filtered} active in 28d".
4. WASTED SPEND / MO — value in `--neg`, sub "{n} idle seats · 30d+ or never used".

### Charts row — grid `1fr 380px`, 14px gap
- **Spend trend** (left): title 14px/600 + legend chips (accent = Total spend, `--faint` dashed = Premium requests). Plot 250px tall: 4 dashed horizontal gridlines with right-aligned $ labels (10.5px `--faint`); SVG (900×240 viewBox, preserveAspectRatio="none", non-scaling strokes): area fill = accent @13%, total line = accent 2px, premium line = `--faint` 1.5px dashed (4 4). 5 evenly-spaced date labels below. Footer stat strip (top border `--border2`): "License: $X · Premium request overage: $X · Premium requests used: N".
- **Seat utilization** (right): 150px donut (r 56, stroke 16, segments via stroke-dasharray, rotated −90°): Active·7d = accent; Active·8–28d = accent 45% mix; Dormant·30d+ = `--faint`; Never used = `--border`. Center: utilization % (24px/600) over "utilized" (10.5px `--faint`). Legend rows right of donut: 9px square swatch, label, "{count} · {pct}%". Footnote: "Seats from the Copilot user-management API; activity from last_activity_at."

### Table row — grid `1fr 380px`, 14px gap
- **Per-user usage & cost** (left): header row with title + page indicator "1–12 of 1,000" (11.5px `--faint`). Column header strip (`--card2` bg, 10.5px/600 `--faint`, letter-spacing .06em), grid columns `2.1fr .8fr 1fr .95fr .95fr 1fr .9fr`: USER, PLAN, EDITOR, PREM REQS↕, ACCEPT↕, LAST ACTIVE↕, COST↕ (right-aligned). Sortable headers toggle ▾/▴, default cost desc. 12 rows/page: avatar (28px circle, initials, 35% tint of #9184d9/#a7a1db/#9397ab rotating), name 12.5px/500 + login in monospace 10.5px `--faint`; plan as outlined pill chip (10.5px); numbers tabular. Row hover `--card2`. Footer: "← Prev / Next →" ghost buttons (28px h).
- **Wasted spend** (right): title, big figure in `--neg` (28px/600) + "/mo", sub with idle count; list of top-6 reclaim candidates (worst first: never-used, then longest-dormant): avatar, name, "Never used"/"63d ago" in monospace `--faint`, "$19/mo" in `--neg` 600. Bottom button "Review all idle seats" (full width, `--card2` bg, hover swaps border/text to `--neg`).

### Add data modal
Opened by "+ Add data". Fixed overlay `rgba(10,12,18,.5)`, centered 620px card (radius 16, heavy shadow), click-outside and × close. Tab strip: Connected sources / Upload CSV / Manual entry (active = accent text + 2px accent underline). Body min-height 280px.
- **Connected sources**: 3 connected rows (8px green status dot, name 13px/600, monospace field description 11px `--faint`, "Connected · 2h ago" in `--pos`): Copilot usage metrics API (`enterprise · users-28-day · ai_credits_used`), Copilot user management API (`seats · last_activity_at · plan_type`), GitHub billing API (`ai_credit usage · by model, SKU, cost center`). One dashed unconnected row: Azure Cost Management + "Connect" button.
- **Upload CSV**: 150px dashed dropzone (`--card2` bg, hover border accent, ↑ badge in 12% accent tint circle), "Drop a CSV or NDJSON export here / or click to browse — up to 25 MB". Hidden file input; on select show a confirmation chip (filename monospace + green dot + "Ready to import"). Below: expected-columns note (monospace) + "Download template" link. Production: parse the file, validate columns, preview rows before import.
- **Manual entry**: 2-col form — User login (text), Plan (select: Business — $19/mo / Enterprise — $39/mo), Premium requests (28d) (number), Last activity (date), "+ Add another row" dashed ghost button.
- Footer (`--card2` bg, top border): Cancel (secondary) + Import (accent outline primary).

## Interactions & Behavior

- **Theme toggle**: flips `dark` class on the shell root; all colors flow from CSS variables (see tokens). Default **dark** (Nocturne native). Persist choice (localStorage).
- **Range 28/56/90d**: re-slices the daily series; all KPIs, charts, per-user costs, and the delta re-derive. Delta compares to the equal-length previous window (for 90d, first half vs second half).
- **Editor/language/search filters**: filter the seat list; KPIs and charts recompute from the filtered subset (series scaled by filteredSeats/totalSeats); table and idle list re-derive. Reset page to 0 on any filter change.
- **Table sorting**: click header → sort desc; click again → toggle direction. Keys: premium requests, acceptance, last active (never = +∞), cost.
- **Pagination**: 12 rows/page, Prev/Next clamped.
- **Modal**: open/close (× / Cancel / backdrop click; content click doesn't close), tab switching, fake import (closes + clears file). Escape-to-close is a production nicety.
- **Hovers**: nav items and table rows tint to `--card2`; buttons per Nocturne (accent tint on outlined primaries); focus-visible = 2px accent outline, offset 2 (never default blue).

## State Management

Single page-level state (useReducer or useState):
`{ range: 28|56|90, editor, language, search, sortKey: 'cost'|'req'|'acc'|'last', sortDir: 1|-1, page, dark, modalOpen, modalTab: 'sources'|'csv'|'manual', pendingFile }`.
All metrics are **derived** — memoize with `useMemo` keyed on [filters, data]. The prototype's `renderVals()` shows every derivation; the 1,000-seat pipeline runs in ~10ms, so memoization per state change is sufficient.

## Design Tokens (Nocturne — full sheet in .claude/design-system/styles.css)

Dark theme (default): bg `#161826`, surface/card `#232532`, card-inset/hover `#292b31`, text `#e9e9ed`, muted `#9397ab`, faint `#75798c`, border = text @16% (`color-mix`), hairline @8%, accent `#9184d9` (light steps `#b5abfc`/`#d2cefd`), positive `#3fae76`, negative `#e2685f`, shadow `0 6px 18px rgba(0,0,0,.35)` + hairline edge.
Light theme (derived from the same ramps): bg `#f3f5fe`, card `#ffffff`, inset `#e9ecf8`, text `#292b31`, muted `#75798c`, faint `#9397ab`, borders = `#292b31` @16%/@8%, accent `#796cbf` (accent-600 for contrast on light), positive `#1a7f4e`, negative `#c23934`, shadow `0 1px 2px rgba(41,43,49,.08)`.
Accent alternative ("steel"): `#a7a1db` dark / `#7972a9` light.
Type: **Inter** (Google Fonts) 400/500/600 — headings never bolder than 500–600; numerals `font-variant-numeric: tabular-nums`. Code/logins: `ui-monospace, Menlo, monospace`.
Radii: cards 14px, controls/buttons 8px, chips/pills full. Icons: Phosphor.

## Assets

None (no images). Brand mark is a plain accent square with "M". Icons in the prototype are placeholder geometric shapes — use Phosphor icons in production.

## Files

- `.claude/design/GitHub Copilot Spend.dc.html` — the interactive hi-fi prototype (open in a browser; requires `.claude/design/support.js` beside it). Logic in the `<script data-dc-script>` block at the bottom: mock-data generator (`buildData`), cost model, filtering/sorting/derivations and SVG chart-path math (`renderVals`).
- `.claude/design/support.js` — prototype runtime only; not part of the handoff to implement.
- `.claude/design-system/styles.css` — Nocturne token sheet + component layer (source of truth for all values).
- `.claude/design-system/readme.md` — Nocturne usage rules (accent as line not flood, outlined primaries, elevation, states).

---

# [impl] Implementation notes

Added while building the repo. The spec above is unchanged.

## Data gaps: GitHub vs the design

> **Superseded (2026-07-16).** This section described the original `billing/usage` +
> seats integration. The live source was since rebuilt on the **Copilot metrics-reports
> API**, which *does* expose per-user `ai_credits_used`, editor and per-model breakdowns —
> so `premiumRequests28d`, `acceptanceRate` and model are now filled from the API, not just
> CSV. The dollar `billing/usage` endpoint returns 404 for this org, so spend is derived
> from the cost model instead. See **docs/github-integration.md** for the current design.
> The account below is kept as the historical record.

The design shows per-user data that GitHub's public APIs only partly expose. What each
source can actually fill:

| Field | Source | Live GitHub? |
| --- | --- | --- |
| `login`, `name`, `plan`, `editor`, `lastActivityAt` | `GET /orgs/{org}/copilot/billing/seats` | **Yes** — per-seat and reliable |
| daily `license` / `premiumOverage` spend | `GET /organizations/{org}/settings/billing/usage` | **Yes** — org-wide billed line items |
| `premiumRequests28d` | — | **No** |
| `acceptanceRate` | — | **No** |
| `language` | — | **No** |

The reason is that `/orgs/{org}/copilot/metrics` is **org-aggregate only** — it carries no
per-user breakdown. There is no public endpoint that attributes premium requests,
acceptance rate or dominant language to a named developer.

**Decision:** those three fields are nullable end-to-end and render as `—` (`EMPTY` in
`lib/format.ts`). They are *not* zero-filled — `0` would claim a developer made no
requests, which is a different and false statement. `premiumOverage(plan, null)` returns
0, so an unknown request count costs nothing rather than being billed as zero-usage.

The `mock` source fills all three, so local development looks exactly like the prototype.

**This is what the CSV import is for.** The design's "Upload CSV" tab expects
`user_login · plan · ai_credits_used · last_activity_at · editor · language` — precisely
the columns the API can't provide. Wiring that parser is the natural next step: it turns
the three `—` columns into real data for a live org.

## Open questions for design

1. **The 29-day hole.** Buckets are `Active · 7d` (≤7), `Active · 8–28d`, `Dormant · 30d+`
   (≥30), and utilisation is "active in 28d" (≤28). Seats last used 29 days ago fall
   between the labels. The prototype resolved this by letting the second bucket absorb
   them (`>7 && <30`), which keeps the donut closed and keeps `Dormant` consistent with
   the wasted-spend basis (`≥30`); that behaviour is preserved here. With mock data it is
   invisible (the generator emits no 26–29 day values), but with a live org the legend
   would sum to slightly more than the centre percentage. Fixing it properly means moving
   a boundary — a design call, not a code call.

2. **No refresh affordance.** The design has no control for triggering a sync, so
   **+ Add data → Connected sources → Import** performs it, and the sync note plus the
   source rows show live state (`syncing…` / `synced 2h ago` / `sync failed`) instead of
   the hardcoded "2h ago". A dedicated control may be warranted.

## Deviations from the spec

- **Nav icons are Phosphor**, per the spec's own instruction to replace the prototype's
  geometric placeholders.
- **`Export CSV` is real** — it exports the currently filtered seats, RFC 4180 quoted.
- **`Review all idle seats`** sorts the table by last-active rather than navigating; there
  is no idle-seats route yet.
- **Import is inert on the CSV and Manual tabs** (disabled, with a note). Neither has a
  write endpoint yet; the spec called the CSV parse a production task.
- **`Connect` on the Azure row is disabled** — out of scope for page 1.
- **Escape closes the modal** — the spec listed this as a production nicety.
- **The date is real.** The prototype pinned `today` to 2026-07-14; seats carry real
  `last_activity_at` timestamps and "days ago" is derived at read time, so it never
  goes stale.

## Architecture notes

- The suggested `src/` layout was split across the monorepo: `types.ts` and the cost model
  became `packages/shared` (the API needs them too); `hooks/useCopilotMetrics.ts` became
  `hooks/useDashboardMetrics.ts` over pure modules in `lib/metrics/`.
- `renderVals()` ported as pure functions, one per concern: `filter`, `spend`, `chart`,
  `utilization`, `table`, `idle`. Each is independently memoised, so paging doesn't
  re-derive the chart.
- The client fetches all ~1,000 seats and the full 90-day series once, then filters,
  sorts, pages and re-slices client-side — as the spec intends. Server-side pagination
  would mean recomputing KPIs per request for no benefit.
- Three tables: `copilot_seats` (current snapshot, replaced per refresh), `spend_daily`
  (upserted — past days are settled), `refresh_jobs`.
