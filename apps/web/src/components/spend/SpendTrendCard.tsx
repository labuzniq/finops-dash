import { useMemo } from 'react';
import { usd, usdCompact } from '../../lib/format.js';
import type { SpendTrendDay } from '../../lib/metrics/spend.js';
import { buildMultiSeriesGeometry } from '../../lib/metrics/usage.js';
import type { SeriesFormat } from '../../lib/metrics/usage.js';
import { TrendChart } from '../usage/TrendChart.js';

/**
 * Daily Gross / Discount / Net / Licence lines on the shared multi-series
 * chart. Net keeps the KPI's meaning — non-licence skus only — and Licence is
 * the daily accrual that already sits inside Gross.
 */

const MONEY_FORMAT: SeriesFormat = {
  axis: usdCompact,
  tooltip: (value) => usd(value, 2),
};

interface SpendTrendCardProps {
  trend: readonly SpendTrendDay[];
  /** Human label of the selected spend range — "last 28d" or "Jun 3 – Jul 1". */
  subtitle: string;
}

export function SpendTrendCard({ trend, subtitle }: SpendTrendCardProps) {
  const geometry = useMemo(
    () =>
      buildMultiSeriesGeometry(
        [
          { name: 'Gross', points: trend.map((day) => ({ date: day.date, value: day.gross })) },
          {
            name: 'Discount',
            points: trend.map((day) => ({ date: day.date, value: day.discount })),
          },
          { name: 'Net', points: trend.map((day) => ({ date: day.date, value: day.net })) },
          { name: 'Licence', points: trend.map((day) => ({ date: day.date, value: day.licence })) },
        ],
        MONEY_FORMAT,
      ),
    [trend],
  );

  return (
    <TrendChart
      title="Spend trend"
      subtitle={subtitle}
      geometry={geometry}
      emptyMessage="No spend in this range"
    />
  );
}
