# Claude Code Telemetry Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add token input/output visibility (daily stacked chart), a top-users-by-tokens leaderboard, org-wide LoC/commit/PR tiles, and a PRs table column to the Claude Code dashboard page.

**Architecture:** Client-side derivation only. `GET /api/telemetry/rollup` already returns per-(day, user, model, metric, type) rows for every metric needed. `deriveTelemetry()` in `apps/web/src/lib/metrics/telemetry.ts` gains new derived shapes; two new components render them; `ClaudeCodePage` wires everything. Zero API/DB/shared changes.

**Tech Stack:** React 18 + TypeScript, CSS Modules, hand-rolled SVG (no chart library), TanStack Query (already wired via `useTelemetryRollup`).

**Spec:** `docs/superpowers/specs/2026-07-17-claude-telemetry-visibility-design.md`

## Global Constraints

- **No test framework exists.** `pnpm typecheck` is the only automated gate (CLAUDE.md). Verify behaviour by driving the app (Task 5). Do not add a test framework.
- **No hex literals in components.** Every colour via `var(--…)` from `apps/web/src/styles/tokens.css`, or `color-mix()` of those vars.
- **No charting library.** SVG paths/rects computed in `apps/web/src/lib/metrics/`, markup in components — same split as `chart.ts` / `CostChart`.
- **Null means unknown, never zero.** A metric with no rows at all in range renders `EMPTY` (`—` from `lib/format.ts`), not `0`.
- **Series colours (decided, validated):** monochrome accent ramp — parts-of-a-whole, not independent categories, so a sequential ramp with fixed stack order is correct. Input = `var(--accent)`, output = `color-mix(in srgb, var(--accent) 55%, var(--card))`, cache = `color-mix(in srgb, var(--accent) 24%, var(--card))`. Lightness is monotonic by construction in both themes. Identity is never colour-alone: stack order is fixed (input at baseline, then output, then cache), a legend is always shown, and each bar has a value tooltip. Segment separation via `stroke: var(--card)` + `vectorEffect="non-scaling-stroke"` (the repo's existing trick for stretch-proof strokes).
- Conventional commits. Work stays on branch `worktree-telemetry-visibility`.
- If `pnpm typecheck` complains that `@dash/shared` types are stale, run `pnpm --filter @dash/shared build` first (dev does not watch it). This plan does not change `packages/shared`.

---

### Task 1: Derivation layer — tokens by day, token leaderboard, org totals, per-user PRs

**Files:**
- Modify: `apps/web/src/lib/metrics/telemetry.ts`

**Interfaces:**
- Consumes: `TelemetryRollupRow`, `TELEMETRY_METRICS` from `@dash/shared` (unchanged).
- Produces (used by Tasks 2–4):

```ts
export interface DailyTokenPoint {
  date: Date;
  input: number;
  output: number;
  cache: number;
  total: number;
}

export interface TokenLeaderboardRow {
  user: string;
  input: number;
  output: number;
  cache: number;
  total: number;
}

/** Org-wide range totals; null when the metric has no rows at all in range. */
export interface TelemetryTotals {
  linesAdded: number | null;
  linesRemoved: number | null;
  commits: number | null;
  pullRequests: number | null;
}
```

  `TelemetryUserRow` gains `pullRequests: number`. `TelemetrySummary` gains `dailyTokens: DailyTokenPoint[]` (zero-filled across range), `topUsersByTokens: TokenLeaderboardRow[]` (top 8 by total, only users with tokens), `totals: TelemetryTotals`.

- [ ] **Step 1: Add the three interfaces above** to `apps/web/src/lib/metrics/telemetry.ts` (below `TelemetryUserRow`), add `pullRequests: number;` to `TelemetryUserRow` (after `commits`), and add the three new fields to `TelemetrySummary`:

```ts
export interface TelemetrySummary {
  totalCostUsd: number;
  totalTokens: number;
  sessions: number;
  activeUsers: number;
  /** Daily cost, zero-filled across the whole range so the chart has a spine. */
  points: ScaledSpendPoint[];
  /** Daily token volumes by kind, zero-filled across the whole range. */
  dailyTokens: DailyTokenPoint[];
  /** Top users by total tokens in range — the leaderboard card. */
  topUsersByTokens: TokenLeaderboardRow[];
  /** Org-wide engineering-output totals for the KPI tiles. */
  totals: TelemetryTotals;
  users: TelemetryUserRow[];
  /** Distinct identities/models in range, unfiltered — the select options. */
  userOptions: string[];
  modelOptions: string[];
}
```

- [ ] **Step 2: Extend the accumulators.** Add a module constant near the top (after `ALL` import lines):

```ts
/** Leaderboard depth — enough to show the shape without scrolling. */
const TOP_USERS_LIMIT = 8;
```

In `emptyUserRow`, add `pullRequests: 0,` after `commits: 0,`. In `accumulateUser`, add a case before `default`:

```ts
    case TELEMETRY_METRICS.pullRequests:
      acc.pullRequests += row.value;
      break;
```

- [ ] **Step 3: Accumulate daily tokens and totals in `deriveTelemetry`.** After the existing `const costByDate = …` line add:

```ts
  const tokensByDate = new Map<string, { input: number; output: number; cache: number }>();
  let linesAdded: number | null = null;
  let linesRemoved: number | null = null;
  let commits: number | null = null;
  let pullRequests: number | null = null;
```

Inside the `for (const row of filtered)` loop, extend the metric branches (keep the existing cost/tokens/sessions logic; the token branch grows, and two new branches are appended):

```ts
    } else if (row.metric === TELEMETRY_METRICS.tokens) {
      totalTokens += row.value;
      const day = tokensByDate.get(row.date) ?? { input: 0, output: 0, cache: 0 };
      if (row.type === 'input') day.input += row.value;
      else if (row.type === 'output') day.output += row.value;
      else day.cache += row.value;
      tokensByDate.set(row.date, day);
    } else if (row.metric === TELEMETRY_METRICS.sessions) {
      sessions += row.value;
    } else if (row.metric === TELEMETRY_METRICS.linesOfCode) {
      if (row.type === 'removed') linesRemoved = (linesRemoved ?? 0) + row.value;
      else linesAdded = (linesAdded ?? 0) + row.value;
    } else if (row.metric === TELEMETRY_METRICS.commits) {
      commits = (commits ?? 0) + row.value;
    } else if (row.metric === TELEMETRY_METRICS.pullRequests) {
      pullRequests = (pullRequests ?? 0) + row.value;
    }
```

Note the null-start pattern: a metric that never appears stays `null` (unknown), one that appears sums from zero. `added`/`removed` are the only `lines_of_code` types Claude Code emits; anything else lands in `added` to match `accumulateUser`. Non-input/output token types (`cacheRead`, `cacheCreation`) bucket into `cache`, matching `accumulateUser`.

- [ ] **Step 4: Build the zero-filled daily token series** next to the existing `points` loop (same shape, same helpers):

```ts
  const dailyTokens: DailyTokenPoint[] = [];
  for (let daysBack = rangeDays - 1; daysBack >= 0; daysBack -= 1) {
    const iso = isoDaysAgo(daysBack);
    const day = tokensByDate.get(iso) ?? { input: 0, output: 0, cache: 0 };
    dailyTokens.push({
      date: parseIsoDate(iso),
      ...day,
      total: day.input + day.output + day.cache,
    });
  }
```

- [ ] **Step 5: Build the leaderboard and return everything.** After the existing `const users = …` statement:

```ts
  const topUsersByTokens: TokenLeaderboardRow[] = users
    .filter((row) => row.tokens > 0)
    .map((row) => ({
      user: row.user,
      input: row.inputTokens,
      output: row.outputTokens,
      cache: row.cacheTokens,
      total: row.tokens,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_USERS_LIMIT);
```

Extend the return object:

```ts
  return {
    totalCostUsd,
    totalTokens,
    sessions,
    activeUsers: activeUsers.size,
    points,
    dailyTokens,
    topUsersByTokens,
    totals: { linesAdded, linesRemoved, commits, pullRequests },
    users,
    userOptions: [...userSet].sort((a, b) => a.localeCompare(b)),
    modelOptions: [...modelSet].sort((a, b) => a.localeCompare(b)),
  };
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (3 workspaces, no errors). `ClaudeCodePage.tsx` does not yet read the new fields, so nothing else changes.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/metrics/telemetry.ts
git commit -m "feat(web): derive daily token split, token leaderboard and output totals from telemetry rollup"
```

---

### Task 2: Token chart geometry + `TokenUsageChart` component

**Files:**
- Create: `apps/web/src/lib/metrics/tokenChart.ts`
- Create: `apps/web/src/components/claude/TokenUsageChart.tsx`
- Create: `apps/web/src/components/claude/TokenUsageChart.module.css`

**Interfaces:**
- Consumes: `DailyTokenPoint` from Task 1; `GridLine` from `./chart.js`; `compactCount`, `dateLabel` from `../format.js`.
- Produces: `buildTokenChartGeometry(points: readonly DailyTokenPoint[]): TokenChartGeometry` and `TOKEN_CHART_VIEWBOX: string` (lib); `TokenUsageChart({ geometry }: { geometry: TokenChartGeometry })` component (used by Task 4).

- [ ] **Step 1: Create `apps/web/src/lib/metrics/tokenChart.ts`:**

```ts
import { compactCount, dateLabel } from '../format.js';
import type { GridLine } from './chart.js';
import type { DailyTokenPoint } from './telemetry.js';

/**
 * Daily-token stacked-bar geometry — the spend-trend treatment applied to
 * bars. Same fixed 900×240 space stretched by preserveAspectRatio="none";
 * segment separation comes from a non-scaling surface-coloured stroke on the
 * rects, not from gaps computed here, so stretching can't distort it.
 */

const VIEWBOX_WIDTH = 900;
const VIEWBOX_HEIGHT = 240;

/** The plot floor sits just inside the viewbox so strokes aren't clipped. */
const PLOT_BOTTOM = 234;
const PLOT_HEIGHT = 220;

/** Headroom above the peak so the tallest bar never touches the top gridline. */
const HEADROOM = 1.12;

const GRID_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;
const X_LABEL_COUNT = 5;

/** Fraction of each day's slot the bar occupies; the rest is breathing room. */
const BAR_FILL = 0.68;

export type TokenKind = 'input' | 'output' | 'cache';

/** Baseline-up stack order; also the legend order. */
export const TOKEN_STACK: readonly TokenKind[] = ['input', 'output', 'cache'];

export interface TokenBarSegment {
  kind: TokenKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TokenBar {
  segments: TokenBarSegment[];
  /** Native-tooltip text: date plus the per-kind volumes. */
  title: string;
}

export interface TokenChartGeometry {
  bars: TokenBar[];
  gridLines: GridLine[];
  xLabels: string[];
}

const EMPTY_GEOMETRY: TokenChartGeometry = { bars: [], gridLines: [], xLabels: [] };

export function buildTokenChartGeometry(points: readonly DailyTokenPoint[]): TokenChartGeometry {
  if (points.length < 2) return EMPTY_GEOMETRY;

  const peak = Math.max(...points.map((point) => point.total)) * HEADROOM || 1;
  const slot = VIEWBOX_WIDTH / points.length;
  const barWidth = slot * BAR_FILL;

  const bars = points.map((point, index) => {
    const x = index * slot + (slot - barWidth) / 2;
    const segments: TokenBarSegment[] = [];
    let floor = PLOT_BOTTOM;
    for (const kind of TOKEN_STACK) {
      const height = (point[kind] / peak) * PLOT_HEIGHT;
      if (height > 0) {
        segments.push({ kind, x, y: floor - height, width: barWidth, height });
        floor -= height;
      }
    }
    return {
      segments,
      title: `${dateLabel(point.date)} · in ${compactCount(point.input)} · out ${compactCount(point.output)} · cache ${compactCount(point.cache)}`,
    };
  });

  const y = (value: number): number => PLOT_BOTTOM - (value / peak) * PLOT_HEIGHT;

  return {
    bars,
    gridLines: GRID_FRACTIONS.map((fraction) => ({
      topPercent: `${((y(peak * fraction) / VIEWBOX_HEIGHT) * 100).toFixed(1)}%`,
      label: compactCount(peak * fraction),
    })),
    xLabels: Array.from({ length: X_LABEL_COUNT }, (_, i) => {
      const index = Math.round((i * (points.length - 1)) / (X_LABEL_COUNT - 1));
      const point = points[index];
      return point ? dateLabel(point.date) : '';
    }),
  };
}

export const TOKEN_CHART_VIEWBOX = `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`;
```

Note: `GridLine` must be exported from `./chart.js` — it already is (`export interface GridLine`).

- [ ] **Step 2: Create `apps/web/src/components/claude/TokenUsageChart.module.css`:**

```css
/* Daily-token stacked bars — the CostChart plot treatment, bar-shaped. */

.chartHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.chartTitle {
  font-size: 14px;
  font-weight: 600;
}

.legend {
  display: flex;
  align-items: center;
  gap: 12px;
  font-weight: 500;
  font-size: 11px;
  color: var(--muted);
}

.legendItem {
  display: flex;
  align-items: center;
  gap: 5px;
}

.swatch {
  width: 9px;
  height: 9px;
  border-radius: 3px;
}

/* Monochrome accent ramp: parts of one whole, darkest at the baseline. */
.input {
  background: var(--accent);
}

.output {
  background: color-mix(in srgb, var(--accent) 55%, var(--card));
}

.cache {
  background: color-mix(in srgb, var(--accent) 24%, var(--card));
}

.plot {
  position: relative;
  height: 250px;
  margin-top: 14px;
}

.gridLine {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border2);
}

.gridLabel {
  position: absolute;
  right: 0;
  top: -15px;
  font-weight: 500;
  font-size: 10.5px;
  color: var(--faint);
}

.svg {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  width: 100%;
  height: 240px;
  display: block;
  overflow: visible;
}

/* The surface-coloured stroke is the 2px spacer between segments and bars. */
.segment {
  stroke: var(--card);
  stroke-width: 1.5;
}

.segmentInput {
  fill: var(--accent);
}

.segmentOutput {
  fill: color-mix(in srgb, var(--accent) 55%, var(--card));
}

.segmentCache {
  fill: color-mix(in srgb, var(--accent) 24%, var(--card));
}

.xLabels {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -6px;
  display: flex;
  justify-content: space-between;
}

.xLabel {
  font-weight: 500;
  font-size: 10.5px;
  color: var(--faint);
}
```

- [ ] **Step 3: Create `apps/web/src/components/claude/TokenUsageChart.tsx`:**

```tsx
import { cx } from '../../lib/cx.js';
import { TOKEN_CHART_VIEWBOX } from '../../lib/metrics/tokenChart.js';
import type { TokenChartGeometry, TokenKind } from '../../lib/metrics/tokenChart.js';
import { Card } from '../Card.js';
import styles from './TokenUsageChart.module.css';

/**
 * Daily token volumes as stacked bars — input at the baseline, output and
 * cache above it. Identity never rides on colour alone: the stack order is
 * fixed, the legend is always present and each bar carries a value tooltip.
 */

const SEGMENT_CLASS: Record<TokenKind, string> = {
  input: styles.segmentInput ?? '',
  output: styles.segmentOutput ?? '',
  cache: styles.segmentCache ?? '',
};

const LEGEND: readonly { kind: TokenKind; label: string }[] = [
  { kind: 'input', label: 'Input' },
  { kind: 'output', label: 'Output' },
  { kind: 'cache', label: 'Cache' },
];

export function TokenUsageChart({ geometry }: { geometry: TokenChartGeometry }) {
  return (
    <Card>
      <div className={styles.chartHeader}>
        <div className={styles.chartTitle}>Daily tokens</div>
        <div className={styles.legend}>
          {LEGEND.map(({ kind, label }) => (
            <span key={kind} className={styles.legendItem}>
              <span className={cx(styles.swatch, styles[kind])} />
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className={styles.plot}>
        {geometry.gridLines.map((line) => (
          <div key={line.topPercent} className={styles.gridLine} style={{ top: line.topPercent }}>
            <span className={styles.gridLabel}>{line.label}</span>
          </div>
        ))}
        <svg className={styles.svg} viewBox={TOKEN_CHART_VIEWBOX} preserveAspectRatio="none" role="img" aria-label="Daily token usage by kind">
          {geometry.bars.map((bar, index) => (
            // Range slicing recomputes the whole array; index is the identity.
            <g key={index}>
              <title>{bar.title}</title>
              {bar.segments.map((segment) => (
                <rect
                  key={segment.kind}
                  className={cx(styles.segment, SEGMENT_CLASS[segment.kind])}
                  x={segment.x}
                  y={segment.y}
                  width={segment.width}
                  height={segment.height}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          ))}
        </svg>
        <div className={styles.xLabels}>
          {geometry.xLabels.map((label, index) => (
            <div key={`${label}-${index}`} className={styles.xLabel}>
              {label}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
```

Note on `styles[kind]`: with `noUncheckedIndexedAccess`, CSS-module lookups type as `string | undefined` — `cx` already accepts falsy members (check `lib/cx.ts`; if its signature is narrower, use `cx(styles.swatch ?? '', styles[kind] ?? '')`).

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (Component not yet mounted; that's Task 4.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/metrics/tokenChart.ts apps/web/src/components/claude/TokenUsageChart.tsx apps/web/src/components/claude/TokenUsageChart.module.css
git commit -m "feat(web): stacked daily token chart (input/output/cache)"
```

---

### Task 3: `TokenLeaderboard` component

**Files:**
- Create: `apps/web/src/components/claude/TokenLeaderboard.tsx`
- Create: `apps/web/src/components/claude/TokenLeaderboard.module.css`

**Interfaces:**
- Consumes: `TokenLeaderboardRow` from Task 1; `compactCount` from `../../lib/format.js`; `Card`.
- Produces: `TokenLeaderboard({ rows }: { rows: readonly TokenLeaderboardRow[] })` (used by Task 4).

- [ ] **Step 1: Create `apps/web/src/components/claude/TokenLeaderboard.module.css`:**

```css
/* Top users by tokens — horizontal segmented bars, table-card voice. */

.card {
  overflow: hidden;
}

.header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 16px 20px 12px;
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.sub {
  font-size: 11.5px;
  color: var(--faint);
}

.legend {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px 10px;
  font-weight: 500;
  font-size: 11px;
  color: var(--muted);
}

.legendItem {
  display: flex;
  align-items: center;
  gap: 5px;
}

.swatch {
  width: 9px;
  height: 9px;
  border-radius: 3px;
}

.rows {
  display: grid;
  gap: 10px;
  padding: 4px 20px 18px;
}

.row {
  display: grid;
  grid-template-columns: minmax(140px, 0.9fr) 3fr auto;
  gap: 12px;
  align-items: center;
  font-size: 12.5px;
}

.user {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bar {
  display: flex;
  gap: 2px;
  height: 14px;
}

.segment {
  border-radius: 3px;
  min-width: 2px;
}

/* The chart's monochrome accent ramp, same order: input darkest. */
.input {
  background: var(--accent);
}

.output {
  background: color-mix(in srgb, var(--accent) 55%, var(--card));
}

.cache {
  background: color-mix(in srgb, var(--accent) 24%, var(--card));
}

.total {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

.empty {
  padding: 32px 20px;
  text-align: center;
  font-size: 12.5px;
  color: var(--muted);
}
```

- [ ] **Step 2: Create `apps/web/src/components/claude/TokenLeaderboard.tsx`:**

```tsx
import { cx } from '../../lib/cx.js';
import { compactCount } from '../../lib/format.js';
import type { TokenLeaderboardRow } from '../../lib/metrics/telemetry.js';
import { Card } from '../Card.js';
import styles from './TokenLeaderboard.module.css';

/**
 * Top users by token volume. Bars are scaled to the heaviest user so ratios
 * read at a glance; segments reuse the daily chart's ramp and order, and each
 * segment carries its own value tooltip.
 */

const SEGMENTS = ['input', 'output', 'cache'] as const;

const LEGEND: readonly { kind: (typeof SEGMENTS)[number]; label: string }[] = [
  { kind: 'input', label: 'Input' },
  { kind: 'output', label: 'Output' },
  { kind: 'cache', label: 'Cache' },
];

export function TokenLeaderboard({ rows }: { rows: readonly TokenLeaderboardRow[] }) {
  const max = rows[0]?.total ?? 0;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Top users by tokens</div>
        <div className={styles.sub}>heaviest token consumers in range</div>
      </div>
      <div className={styles.legend}>
        {LEGEND.map(({ kind, label }) => (
          <span key={kind} className={styles.legendItem}>
            <span className={cx(styles.swatch, styles[kind])} />
            {label}
          </span>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className={styles.empty}>No token usage matches these filters.</div>
      ) : (
        <div className={styles.rows}>
          {rows.map((row) => (
            <div key={row.user} className={styles.row}>
              <div className={styles.user}>{row.user}</div>
              <div className={styles.bar}>
                {SEGMENTS.map((kind) =>
                  row[kind] > 0 && max > 0 ? (
                    <div
                      key={kind}
                      className={cx(styles.segment, styles[kind])}
                      style={{ width: `${(row[kind] / max) * 100}%` }}
                      title={`${kind}: ${compactCount(row[kind])}`}
                    />
                  ) : null,
                )}
              </div>
              <div className={styles.total}>{compactCount(row.total)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
```

(Same `noUncheckedIndexedAccess` caveat as Task 2 for `styles[kind]`.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/claude/TokenLeaderboard.tsx apps/web/src/components/claude/TokenLeaderboard.module.css
git commit -m "feat(web): top-users-by-tokens leaderboard card"
```

---

### Task 4: Wire the page — output KPI tiles, chart row, leaderboard, PRs column

**Files:**
- Modify: `apps/web/src/components/claude/ClaudeCodePage.tsx`
- Modify: `apps/web/src/components/claude/ClaudeCodePage.module.css`

**Interfaces:**
- Consumes: everything produced by Tasks 1–3.

- [ ] **Step 1: CSS — add to `ClaudeCodePage.module.css`.** After the `.kpiRow` media-query block (around line 104), add:

```css
/* Second KPI row — engineering output (LoC / commits / PRs). */
.kpiRowOutput {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

@media (max-width: 1100px) {
  .kpiRowOutput {
    grid-template-columns: 1fr;
  }
}

/* Cost + token charts side by side; stacked when narrow. */
.chartRow {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: stretch;
}

@media (max-width: 1100px) {
  .chartRow {
    grid-template-columns: 1fr;
  }
}
```

Change the table grid (line ~200) from:

```css
  grid-template-columns: 1.7fr 1.1fr 0.7fr 0.7fr 0.6fr 0.9fr 0.6fr 0.8fr;
```

to (one extra `0.5fr` slot for PRS between COMMITS and LAST ACTIVE):

```css
  grid-template-columns: 1.7fr 1.1fr 0.7fr 0.7fr 0.6fr 0.9fr 0.6fr 0.5fr 0.8fr;
```

- [ ] **Step 2: `ClaudeCodePage.tsx` imports and `KpiCard` value type.** Extend imports:

```tsx
import { buildTokenChartGeometry } from '../../lib/metrics/tokenChart.js';
import { TokenLeaderboard } from './TokenLeaderboard.js';
import { TokenUsageChart } from './TokenUsageChart.js';
```

Change `KpiCard`'s `value` prop from `string` to `ReactNode` (the LoC tile renders coloured spans):

```tsx
function KpiCard({ kicker, value, children }: { kicker: string; value: ReactNode; children: ReactNode }) {
```

- [ ] **Step 3: Derive the token chart geometry.** Below the existing `const chart = useMemo(…)` line:

```tsx
  const tokenChart = useMemo(() => buildTokenChartGeometry(summary.dailyTokens), [summary.dailyTokens]);
```

- [ ] **Step 4: Render the output KPI row.** Directly after the existing `</div>` that closes `styles.kpiRow` (after the ACTIVE USERS card), insert:

```tsx
          <div className={styles.kpiRowOutput}>
            <KpiCard
              kicker={`LINES OF CODE · ${range}d`}
              value={
                summary.totals.linesAdded === null && summary.totals.linesRemoved === null ? (
                  EMPTY
                ) : (
                  <>
                    <span className={styles.linesAdded}>+{compactCount(summary.totals.linesAdded ?? 0)}</span>{' '}
                    <span className={styles.linesRemoved}>−{compactCount(summary.totals.linesRemoved ?? 0)}</span>
                  </>
                )
              }
            >
              added / removed by Claude Code
            </KpiCard>
            <KpiCard
              kicker={`COMMITS · ${range}d`}
              value={summary.totals.commits === null ? EMPTY : count(Math.round(summary.totals.commits))}
            >
              commits created via Claude Code
            </KpiCard>
            <KpiCard
              kicker={`PULL REQUESTS · ${range}d`}
              value={summary.totals.pullRequests === null ? EMPTY : count(Math.round(summary.totals.pullRequests))}
            >
              PRs opened via Claude Code
            </KpiCard>
          </div>
```

- [ ] **Step 5: Chart row + leaderboard.** Replace the lone `<CostChart chart={chart} />` with:

```tsx
          <div className={styles.chartRow}>
            <CostChart chart={chart} />
            <TokenUsageChart geometry={tokenChart} />
          </div>

          <TokenLeaderboard rows={summary.topUsersByTokens} />
```

- [ ] **Step 6: PRs column.** `UserRow` gains a flag so absent org-wide PR data reads as unknown, not zero:

```tsx
function UserRow({ row, hasPrData }: { row: TelemetryUserRow; hasPrData: boolean }) {
```

Insert between the COMMITS cell and the LAST ACTIVE cell:

```tsx
      <div className={styles.right}>{hasPrData ? count(Math.round(row.pullRequests)) : EMPTY}</div>
```

In the header strip, insert `<div className={styles.right}>PRS</div>` after `<div className={styles.right}>COMMITS</div>`. Update the render call:

```tsx
              summary.users.map((row) => (
                <UserRow key={row.user} row={row} hasPrData={summary.totals.pullRequests !== null} />
              ))
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/claude/ClaudeCodePage.tsx apps/web/src/components/claude/ClaudeCodePage.module.css
git commit -m "feat(web): output KPI tiles, token chart row, leaderboard and PRs column on Claude Code page"
```

---

### Task 5: Drive the app and verify

There is no telemetry mock source — the page only shows what has been ingested over OTLP. Seed synthetic data through the real ingest path, then verify visually.

**Files:**
- Create: `<scratchpad>/seed-telemetry.mjs` (temporary, NOT committed to the repo)

- [ ] **Step 1: Start the stack**

Run: `cp .env.example .env` (if `.env` missing), then `pnpm dev` in the background. Wait for the API on :4000 and web on :5173.

- [ ] **Step 2: Seed telemetry via OTLP.** Write `<scratchpad>/seed-telemetry.mjs`; it POSTs delta-temporality sums (`aggregationTemporality: 1`, so no cumulative diffing is involved) for 3 users × 14 days across the seven metrics:

```js
const ENDPOINT = 'http://localhost:4000/v1/metrics';
const USERS = [
  { email: 'ada@rbcz.example', id: 'u-ada' },
  { email: 'ben@rbcz.example', id: 'u-ben' },
  { email: 'eva@rbcz.example', id: 'u-eva' },
];
const MODELS = ['claude-fable-5', 'claude-haiku-4-5'];

const attr = (key, value) =>
  typeof value === 'number'
    ? { key, value: { intValue: String(Math.round(value)) } }
    : { key, value: { stringValue: value } };

function dataPoint(value, timeMs, attrs) {
  return {
    asDouble: value,
    timeUnixNano: String(timeMs) + '000000',
    startTimeUnixNano: String(timeMs - 60_000) + '000000',
    attributes: attrs,
  };
}

function metric(name, dataPoints) {
  return { name, sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints } };
}

// Deterministic pseudo-random so reruns look the same.
let seed = 42;
const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;

const metrics = [];
const now = Date.now();
for (let daysBack = 13; daysBack >= 0; daysBack -= 1) {
  const t = now - daysBack * 86_400_000;
  for (const user of USERS) {
    const base = [attr('user.email', user.email), attr('user.account_uuid', user.id), attr('session.id', `s-${user.id}-${daysBack}`)];
    for (const model of MODELS) {
      const m = [...base, attr('model', model)];
      metrics.push(
        metric('claude_code.token.usage', [
          dataPoint(200_000 + rand() * 900_000, t, [...m, attr('type', 'input')]),
          dataPoint(30_000 + rand() * 120_000, t, [...m, attr('type', 'output')]),
          dataPoint(500_000 + rand() * 3_000_000, t, [...m, attr('type', 'cacheRead')]),
        ]),
        metric('claude_code.cost.usage', [dataPoint(2 + rand() * 18, t, m)]),
      );
    }
    metrics.push(
      metric('claude_code.session.count', [dataPoint(1 + Math.round(rand() * 4), t, base)]),
      metric('claude_code.lines_of_code.count', [
        dataPoint(50 + rand() * 800, t, [...base, attr('type', 'added')]),
        dataPoint(rand() * 300, t, [...base, attr('type', 'removed')]),
      ]),
      metric('claude_code.commit.count', [dataPoint(Math.round(rand() * 6), t, base)]),
      metric('claude_code.pull_request.count', [dataPoint(Math.round(rand() * 2), t, base)]),
    );
  }
}

const body = {
  resourceMetrics: [
    {
      resource: { attributes: [attr('service.name', 'claude-code')] },
      scopeMetrics: [{ metrics }],
    },
  ],
};

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(res.status, await res.text());
```

Run: `node <scratchpad>/seed-telemetry.mjs`
Expected: `200 {"partialSuccess":{}}` or similar with `rejectedDataPoints` absent/0. If `OTLP_INGEST_TOKEN` is set in `.env`, add an `authorization: Bearer <token>` header.

Before relying on the payload shape, cross-check attribute keys against `apps/api/src/otlp/ingest.ts` (`extractColumns` — `user.email`, `user.account_uuid`, `session.id`, `model`, `type`) and adjust the script if they differ.

- [ ] **Step 3: Verify the rollup.** Log in and pull the rollup (token from `.env` `STATIC_LOGIN_TOKEN`):

```bash
TOKEN=$(grep '^STATIC_LOGIN_TOKEN=' .env | cut -d= -f2)
curl -s -c /tmp/dash-cookies -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" http://localhost:4000/api/auth/login
curl -s -b /tmp/dash-cookies 'http://localhost:4000/api/telemetry/rollup?days=14' | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const rows=JSON.parse(d);
const by={};for(const r of rows) by[r.metric+(r.type?':'+r.type:'')]=(by[r.metric+(r.type?':'+r.type:'')]??0)+r.value;
console.log(by)})"
```

Expected: non-zero sums for `claude_code.token.usage:input`, `:output`, `:cacheRead`, `lines_of_code.count:added`/`:removed`, `commit.count`, `pull_request.count`, `session.count`, `cost.usage`.

- [ ] **Step 4: Verify the page.** Open `http://localhost:5173`, log in, go to the Claude Code page. Check every item; a screenshot per state is ideal (browser tooling if available, otherwise ask the user to eyeball):
  - Daily tokens chart: stacked bars, input darkest at baseline, legend, native tooltip on hover, y-axis labels in compact counts.
  - Range 7d/14d/30d re-slices the bars; a user filter shrinks them; a model filter shrinks tokens but NOT commits/LoC/PRs (model-less rows pass through — existing behaviour).
  - Leaderboard: ≤8 rows, sorted, bars proportional to the top user, segment tooltips.
  - Output KPI row: LoC `+x −y` coloured, commits, PRs — all react to range/user filters.
  - Table: PRS column between COMMITS and LAST ACTIVE, numbers align right.
  - Empty-state check: filter to a user+model combination with no tokens — leaderboard shows its empty message, chart renders without bars, page doesn't crash.
- [ ] **Step 5: Dark/light check.** Toggle the theme; segments must remain distinguishable in both (they will — the ramp mixes against `--card`).
- [ ] **Step 6: Fix anything found, re-run `pnpm typecheck`, commit fixes** (`fix(web): …`). Delete nothing from the DB — seeded rows are harmless dev data, but note them in the PR description.

---

## Self-review notes

- **Spec coverage:** token split chart (Task 2+4), leaderboard (Task 3+4), tiles + PRs column (Task 4), derivations (Task 1), null-means-unknown (Task 1 null-start totals + Task 4 `hasPrData`/`EMPTY`), verification (Task 5). Language: out of scope per spec. ✔
- **Type consistency:** `DailyTokenPoint`/`TokenLeaderboardRow`/`TelemetryTotals` defined once in Task 1, consumed by name in Tasks 2–4; `buildTokenChartGeometry`/`TOKEN_CHART_VIEWBOX`/`TokenChartGeometry` defined in Task 2, consumed in Task 4. ✔
- **No placeholders:** every code step carries the full code. ✔
