/**
 * Nano-dollar (1e-9 USD) arithmetic. Billing CSV amounts carry up to nine
 * decimal places, so integer cents cannot hold them; bigint nano-dollars keep
 * every sum exact. Parsing is pure string arithmetic — `parseFloat` would
 * reintroduce the float drift the representation exists to avoid.
 */

const NANO_SCALE = 9;
const NANO_PER_UNIT = 1_000_000_000n;

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string ("281.55905", "-0.04", "1900") into nano units.
 * Throws on anything that is not a plain decimal number or that carries more
 * than nine fractional digits — precision must never be silently dropped.
 */
export function parseNano(decimal: string): bigint {
  const match = DECIMAL_RE.exec(decimal.trim());
  if (!match) throw new Error(`not a decimal number: "${decimal}"`);
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2]!;
  const fraction = match[3] ?? '';
  if (fraction.length > NANO_SCALE) {
    throw new Error(`more than ${NANO_SCALE} fractional digits: "${decimal}"`);
  }
  const nano = BigInt(whole) * NANO_PER_UNIT + BigInt(fraction.padEnd(NANO_SCALE, '0') || '0');
  return sign * nano;
}

/**
 * Nano units → dollars, as a JS number. The one and only place money leaves
 * exact integer arithmetic — call it at the API response edge, nowhere else.
 * Safe: realistic totals stay far below Number.MAX_SAFE_INTEGER nanos (~$9M).
 */
export function nanoToDollars(nano: bigint): number {
  return Number(nano) / 1e9;
}

/**
 * Nano units → decimal string ("281.55905", "-0.04", "1900"), the exact
 * inverse of `parseNano` (modulo trailing fraction zeros). Used by the mock
 * CSV export so generated report files round-trip through the importer.
 */
export function formatNano(nano: bigint): string {
  const sign = nano < 0n ? '-' : '';
  const abs = nano < 0n ? -nano : nano;
  const whole = abs / NANO_PER_UNIT;
  const fraction = (abs % NANO_PER_UNIT).toString().padStart(NANO_SCALE, '0').replace(/0+$/, '');
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}
