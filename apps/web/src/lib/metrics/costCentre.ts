import type { SpendUserRow } from './spend.js';

/**
 * Cost-centre rollups over the per-user spend rows.
 *
 * The filter bar can already *scope* the page to one department or manager, but
 * scoping answers "what did this unit spend"; it cannot answer "which unit
 * spends the most", which is the question a chargeback conversation starts
 * from. These derivations group the same filtered rows the user table shows by
 * one org dimension at a time, so a rollup can never disagree with the KPIs
 * about who is being counted.
 *
 * Pure and memo-friendly, like every other module in `lib/metrics/`.
 */

/** The org dimensions a rollup can group by — the identity fields on a seat. */
export type CostCentreDimension = 'department' | 'b1Manager' | 'b2Manager';

/** Label of the bucket holding people with no value for the dimension. */
export const UNASSIGNED = 'Unassigned';

export interface CostCentreRow {
  /**
   * The dimension value, or null for the unassigned bucket. Null is what makes
   * a row undrillable — no filter can select "people with no department".
   */
  key: string | null;
  label: string;
  /** Distinct logins in the bucket. */
  people: number;
  /** Logins that recorded at least one AI credit in the range. */
  activePeople: number;
  /** Licensed logins that recorded no credits — the wasted-seat count. */
  idlePeople: number;
  credits: number;
  gross: number;
  discount: number;
  /** The real charged total for the bucket, licences included. */
  net: number;
  licence: number;
  /** Licence money of the idle logins. */
  wasted: number;
  /** net / people — the only number that compares units of different sizes. */
  netPerPerson: number;
  /** Share of the net across all buckets, 0..1. */
  share: number;
}

export interface CostCentreRollup {
  rows: CostCentreRow[];
  /** Net across every bucket — the denominator behind `share`. */
  net: number;
  /**
   * False when the range carries no credits at all, exactly as in `wastedSpend`:
   * without the per-model report an unused login and an unreported one look the
   * same, so `idlePeople` would read as "everyone".
   */
  idleMeasurable: boolean;
}

interface Accumulator {
  key: string | null;
  people: number;
  activePeople: number;
  idlePeople: number;
  credits: number;
  gross: number;
  discount: number;
  net: number;
  licence: number;
  wasted: number;
}

function emptyAccumulator(key: string | null): Accumulator {
  return {
    key,
    people: 0,
    activePeople: 0,
    idlePeople: 0,
    credits: 0,
    gross: 0,
    discount: 0,
    net: 0,
    licence: 0,
    wasted: 0,
  };
}

/**
 * Group per-user spend by one org dimension, biggest net first. The unassigned
 * bucket always sorts last regardless of its size — it is a data-quality
 * remainder, not a cost centre, and ranking it alongside real units would
 * invite reading it as one.
 */
export function costCentreRollup(
  rows: readonly SpendUserRow[],
  dimension: CostCentreDimension,
): CostCentreRollup {
  const byKey = new Map<string, Accumulator>();
  let totalNet = 0;
  let totalCredits = 0;

  for (const row of rows) {
    const raw = row[dimension];
    const key = raw === null || raw === '' ? null : raw;
    // Map keys must be strings; the sentinel can't collide with a real value
    // because a real value is never empty.
    const mapKey = key ?? '';

    const acc = byKey.get(mapKey) ?? emptyAccumulator(key);
    acc.people += 1;
    acc.credits += row.credits;
    acc.gross += row.gross;
    acc.discount += row.discount;
    acc.net += row.net;
    acc.licence += row.licence;
    if (row.credits > 0) {
      acc.activePeople += 1;
    } else if (row.licence > 0) {
      acc.idlePeople += 1;
      acc.wasted += row.licence;
    }
    byKey.set(mapKey, acc);

    totalNet += row.net;
    totalCredits += row.credits;
  }

  const result = [...byKey.values()].map((acc) => ({
    ...acc,
    label: acc.key ?? UNASSIGNED,
    netPerPerson: acc.people > 0 ? acc.net / acc.people : 0,
    share: totalNet > 0 ? acc.net / totalNet : 0,
  }));

  result.sort((a, b) => {
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    return b.net - a.net || a.label.localeCompare(b.label);
  });

  return { rows: result, net: totalNet, idleMeasurable: totalCredits > 0 };
}

/**
 * How concentrated the spend is: the share of net taken by the first `n` rows.
 * Zero when there is no spend. Reads display order, so the unassigned bucket —
 * pinned last — only counts when there are barely any groups at all.
 */
export function topShare(rollup: CostCentreRollup, n: number): number {
  if (rollup.net <= 0) return 0;
  let sum = 0;
  for (const row of rollup.rows.slice(0, n)) sum += row.net;
  return sum / rollup.net;
}
