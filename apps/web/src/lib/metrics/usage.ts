import type {
  AdoptionPhasePoint,
  BreakdownPoint,
  CopilotSeat,
  DateRange,
  OrgDailyPoint,
  UsageDimension,
} from '@dash/shared';
import { isoDateLabel } from '../format.js';
import type { GridLine } from './chart.js';
import type { ChartHoverPoint } from './hover.js';

/**
 * Derivations for the usage sections — slicing the fetched history to the
 * global range, pivoting breakdown rows into per-category series, and turning
 * those series into multi-line SVG geometry. Same fixed 900×240 viewbox
 * treatment as the spend chart (`chart.ts`); only the series count differs.
 */

const VIEWBOX_WIDTH = 900;
const VIEWBOX_HEIGHT = 240;
const PLOT_BOTTOM = 234;
const PLOT_HEIGHT = 220;
const HEADROOM = 1.12;
const GRID_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;
const X_LABEL_COUNT = 5;

/** Categories beyond this rank fold into 'Other'. */
const MAX_SERIES = 8;

export const OTHER_KEY = 'Other';

export interface SeriesChartInput {
  name: string;
  /** One entry per axis date; null = no datum that day (breaks the line). */
  points: ReadonlyArray<{ date: string; value: number | null }>;
}

/**
 * Rows within the selected window. Presets take the trailing N *distinct
 * dates* (rows can repeat a date), customs an inclusive calendar window —
 * the same semantics `summariseSpend` gives the spend series.
 */
export function sliceByRange<T extends { date: string }>(
  rows: readonly T[],
  range: DateRange,
): T[] {
  if (range.kind === 'custom') {
    return rows.filter((row) => row.date >= range.from && row.date <= range.to);
  }
  const dates = dateAxis(rows);
  const kept = new Set(dates.slice(Math.max(0, dates.length - range.days)));
  return rows.filter((row) => kept.has(row.date));
}

/** Sorted distinct dates of a window — the shared X axis for its charts. */
export function dateAxis(rows: ReadonlyArray<{ date: string }>): string[] {
  return [...new Set(rows.map((row) => row.date))].sort();
}

/**
 * Pivot one dimension's rows into per-key series over `dates`. Keys are
 * ranked by total metric descending; those beyond `maxSeries` merge into
 * 'Other'. Days without a row count as zero — a category absent that day.
 */
export function pivotBreakdown(
  rows: readonly BreakdownPoint[],
  dimension: UsageDimension,
  metric:
    | 'interactions'
    | 'generations'
    | 'acceptances'
    | 'locAdded'
    | 'locDeleted'
    | 'locSuggestedAdd'
    | 'locSuggestedDelete',
  dates: readonly string[],
  maxSeries: number = MAX_SERIES,
): SeriesChartInput[] {
  const totals = new Map<string, number>();
  const byKeyDate = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (row.dimension !== dimension) continue;
    totals.set(row.key, (totals.get(row.key) ?? 0) + row[metric]);
    const days = byKeyDate.get(row.key) ?? new Map<string, number>();
    days.set(row.date, (days.get(row.date) ?? 0) + row[metric]);
    byKeyDate.set(row.key, days);
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const top = ranked.slice(0, maxSeries);
  const folded = ranked.slice(maxSeries);

  const series: SeriesChartInput[] = top.map((key) => ({
    name: key,
    points: dates.map((date) => ({ date, value: byKeyDate.get(key)?.get(date) ?? 0 })),
  }));

  if (folded.length > 0) {
    series.push({
      name: OTHER_KEY,
      points: dates.map((date) => ({
        date,
        value: folded.reduce((sum, key) => sum + (byKeyDate.get(key)?.get(date) ?? 0), 0),
      })),
    });
  }

  return series;
}

/** Named org-daily fields as chart series — one line per field. */
export function orgSeries(
  rows: readonly OrgDailyPoint[],
  fields: ReadonlyArray<{ field: keyof OrgDailyPoint & string; name: string }>,
): SeriesChartInput[] {
  return fields.map(({ field, name }) => ({
    name,
    points: rows.map((row) => ({ date: row.date, value: row[field] as number })),
  }));
}

/** Daily acceptances ÷ generations as a percentage; null on idle days. */
export function acceptanceRateSeries(rows: readonly OrgDailyPoint[]): SeriesChartInput[] {
  return [
    {
      name: 'Acceptance rate',
      points: rows.map((row) => ({
        date: row.date,
        value: row.generations > 0 ? (row.acceptances / row.generations) * 100 : null,
      })),
    },
  ];
}

/** Engaged users per adoption phase over time, one line per phase. */
export function adoptionSeries(rows: readonly AdoptionPhasePoint[]): SeriesChartInput[] {
  const dates = dateAxis(rows);
  const phases = new Map<number, { name: string; byDate: Map<string, number> }>();

  for (const row of rows) {
    const phase = phases.get(row.phaseNumber) ?? { name: row.phase, byDate: new Map() };
    phase.byDate.set(row.date, row.engagedUsers);
    phases.set(row.phaseNumber, phase);
  }

  return [...phases.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, phase]) => ({
      name: phase.name,
      points: dates.map((date) => ({ date, value: phase.byDate.get(date) ?? 0 })),
    }));
}

/** True when the window has no PR activity at all — drives the empty state. */
export function prAllZero(rows: readonly OrgDailyPoint[]): boolean {
  return rows.every(
    (row) =>
      row.prCreated === 0 &&
      row.prMerged === 0 &&
      row.prCreatedByCopilot === 0 &&
      row.prMergedCreatedByCopilot === 0 &&
      row.prReviewedByCopilot === 0 &&
      row.prCopilotSuggestions === 0 &&
      row.prCopilotAppliedSuggestions === 0,
  );
}

export interface TeamStat {
  team: string;
  seats: number;
  /** Share of the team's seats active in the last 28 days, 0–100. */
  activePercent: number;
}

const ACTIVE_WINDOW_DAYS = 28;

/** Seats grouped by assigning team, largest first. Direct assignments group as 'No team'. */
export function teamStats(seats: readonly CopilotSeat[]): TeamStat[] {
  const groups = new Map<string, { seats: number; active: number }>();

  for (const seat of seats) {
    const team = seat.team ?? 'No team';
    const group = groups.get(team) ?? { seats: 0, active: 0 };
    group.seats += 1;
    if (seat.lastActivityDays !== null && seat.lastActivityDays <= ACTIVE_WINDOW_DAYS) {
      group.active += 1;
    }
    groups.set(team, group);
  }

  return [...groups.entries()]
    .map(([team, group]) => ({
      team,
      seats: group.seats,
      activePercent: group.seats === 0 ? 0 : Math.round((group.active / group.seats) * 100),
    }))
    .sort((a, b) => b.seats - a.seats || a.team.localeCompare(b.team));
}

// --- Multi-series geometry ---------------------------------------------------

export interface MultiSeriesGeometry {
  series: Array<{ name: string; linePath: string; colorVar: string }>;
  gridLines: GridLine[];
  xLabels: string[];
  hoverPoints: ChartHoverPoint[];
  /** No line worth drawing — under two dates, or every value null/zero. */
  empty: boolean;
}

export interface SeriesFormat {
  /** Compact form for the Y-axis grid labels. */
  axis: (value: number) => string;
  /** Full form for the hover tooltip. */
  tooltip: (value: number) => string;
}

const EMPTY_GEOMETRY: MultiSeriesGeometry = {
  series: [],
  gridLines: [],
  xLabels: [],
  hoverPoints: [],
  empty: true,
};

function colorVarFor(name: string, index: number): string {
  if (name === OTHER_KEY) return 'var(--chart-other)';
  return `var(--chart-${Math.min(index + 1, MAX_SERIES)})`;
}

/** Polyline that restarts at null gaps, so unknown days don't draw as zero. */
function gappedPath(
  points: ReadonlyArray<{ value: number | null }>,
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  const parts: string[] = [];
  let pen = false;
  points.forEach((point, index) => {
    if (point.value === null) {
      pen = false;
      return;
    }
    const step = `${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`;
    parts.push(`${pen ? 'L' : 'M'}${step}`);
    pen = true;
  });
  return parts.join(' ');
}

export function buildMultiSeriesGeometry(
  input: readonly SeriesChartInput[],
  format: SeriesFormat,
): MultiSeriesGeometry {
  const first = input[0];
  if (first === undefined || first.points.length < 2) return EMPTY_GEOMETRY;

  const values = input.flatMap((series) =>
    series.points.map((point) => point.value).filter((value): value is number => value !== null),
  );
  const max = values.length > 0 ? Math.max(...values) : 0;
  if (max <= 0) return EMPTY_GEOMETRY;

  const peak = max * HEADROOM;
  const last = first.points.length - 1;
  const x = (index: number): number => (index / last) * VIEWBOX_WIDTH;
  const y = (value: number): number => PLOT_BOTTOM - (value / peak) * PLOT_HEIGHT;

  return {
    series: input.map((series, index) => ({
      name: series.name,
      linePath: gappedPath(series.points, x, y),
      colorVar: colorVarFor(series.name, index),
    })),
    gridLines: GRID_FRACTIONS.map((fraction) => ({
      topPercent: `${((y(peak * fraction) / VIEWBOX_HEIGHT) * 100).toFixed(1)}%`,
      label: format.axis(peak * fraction),
    })),
    xLabels: Array.from({ length: X_LABEL_COUNT }, (_, i) => {
      const index = Math.round((i * last) / (X_LABEL_COUNT - 1));
      const point = first.points[index];
      return point ? isoDateLabel(point.date) : '';
    }),
    hoverPoints: first.points.map((point, index) => ({
      xPercent: (x(index) / VIEWBOX_WIDTH) * 100,
      dateLabel: isoDateLabel(point.date),
      series: input.flatMap((series, seriesIndex) => {
        const value = series.points[index]?.value;
        if (value == null) return [];
        return [
          {
            label: series.name,
            value: format.tooltip(value),
            color: colorVarFor(series.name, seriesIndex),
            yPercent: (y(value) / VIEWBOX_HEIGHT) * 100,
          },
        ];
      }),
    })),
    empty: false,
  };
}

export const USAGE_CHART_VIEWBOX = `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`;
