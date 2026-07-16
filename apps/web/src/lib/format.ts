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
