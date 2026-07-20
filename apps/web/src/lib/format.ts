import type { DateRange } from '@dash/shared';

/** Display formatting. Every user-facing string in the dashboard comes from here. */

/** The placeholder for a value GitHub does not expose per-user. */
export const EMPTY = '—';

export function usd(value: number, decimals = 0): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Compact axis money: $840, $1.2k, $12k. */
export function usdCompact(value: number): string {
  if (value < 1_000) return `$${Math.round(value)}`;
  return `$${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** Compact large counts: 840, 1.2k, 12k, 3.4M — token volumes need the room. */
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return count(Math.round(value));
}

export function percent(value: number): string {
  return `${Math.round(value)}%`;
}

/** Days since last activity, in the table's voice. Null means never used. */
export function lastActiveLabel(days: number | null): string {
  if (days === null) return 'Never used';
  if (days === 0) return 'Today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

export function dateLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** ISO `2026-06-03` → "Jun 3", parsed as local midnight so it can't slip a day. */
export function isoDateLabel(iso: string): string {
  const [year, month, day] = iso.split('-');
  return dateLabel(new Date(Number(year), Number(month) - 1, Number(day)));
}

/** The selected range in card subtitles: "last 28d" or "Jun 3 – Jul 1". */
export function rangeLabel(range: DateRange): string {
  if (range.kind === 'preset') return `last ${range.days}d`;
  return `${isoDateLabel(range.from)} – ${isoDateLabel(range.to)}`;
}

/** "2h ago" / "just now" — for the sync note. */
export function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('');
}

/** Numbers that may be absent render as an em dash, never as zero. */
export function optionalCount(value: number | null): string {
  return value === null ? EMPTY : count(value);
}

export function optionalPercent(value: number | null): string {
  return value === null ? EMPTY : `${value}%`;
}
