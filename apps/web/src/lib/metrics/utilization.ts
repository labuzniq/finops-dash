import { ACTIVE_WINDOW_DAYS, IDLE_THRESHOLD_DAYS, isActiveWithin } from '@dash/shared';
import type { CopilotSeat } from '@dash/shared';

/**
 * Seat-utilisation breakdown and the donut geometry that draws it.
 *
 * The four buckets are exclusive and cover every seat, so their fractions
 * always sum to 1 and the ring closes.
 */

/** Donut ring radius, matching the 140×140 viewbox in the component. */
const RADIUS = 56;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const RECENTLY_ACTIVE_DAYS = 7;

export type UtilizationBucketKey = 'active7' | 'active28' | 'dormant' | 'never';

export interface UtilizationBucket {
  key: UtilizationBucketKey;
  label: string;
  count: number;
  percent: number;
  /** stroke-dasharray / stroke-dashoffset for this bucket's arc. */
  dashArray: string;
  dashOffset: string;
}

export interface Utilization {
  buckets: UtilizationBucket[];
  /** Seats used within the 28-day window. */
  activeCount: number;
  totalCount: number;
  utilizedPercent: number;
}

const LABELS: Record<UtilizationBucketKey, string> = {
  active7: 'Active · 7d',
  active28: 'Active · 8–28d',
  dormant: 'Dormant · 30d+',
  never: 'Never used',
};

export function buildUtilization(seats: readonly CopilotSeat[]): Utilization {
  const total = seats.length;

  const counts: Record<UtilizationBucketKey, number> = {
    active7: seats.filter((seat) => isActiveWithin(seat, RECENTLY_ACTIVE_DAYS)).length,
    active28: seats.filter(
      (seat) =>
        seat.lastActivityDays !== null &&
        seat.lastActivityDays > RECENTLY_ACTIVE_DAYS &&
        seat.lastActivityDays < IDLE_THRESHOLD_DAYS,
    ).length,
    dormant: seats.filter(
      (seat) => seat.lastActivityDays !== null && seat.lastActivityDays >= IDLE_THRESHOLD_DAYS,
    ).length,
    never: seats.filter((seat) => seat.lastActivityDays === null).length,
  };

  const order: UtilizationBucketKey[] = ['active7', 'active28', 'dormant', 'never'];

  // Each arc starts where the previous one ended.
  let consumed = 0;
  const buckets = order.map((key) => {
    const count = counts[key];
    const fraction = total === 0 ? 0 : count / total;
    const bucket: UtilizationBucket = {
      key,
      label: LABELS[key],
      count,
      percent: total === 0 ? 0 : Math.round((count / total) * 100),
      dashArray: `${(fraction * CIRCUMFERENCE).toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`,
      dashOffset: (-consumed * CIRCUMFERENCE).toFixed(1),
    };
    consumed += fraction;
    return bucket;
  });

  const activeCount = seats.filter((seat) => isActiveWithin(seat, ACTIVE_WINDOW_DAYS)).length;

  return {
    buckets,
    activeCount,
    totalCount: total,
    utilizedPercent: total === 0 ? 0 : Math.round((activeCount / total) * 100),
  };
}
