/**
 * Joins class names, dropping anything falsy.
 *
 * CSS-module lookups are `string | undefined` under noUncheckedIndexedAccess,
 * so this keeps conditional classes readable without non-null assertions.
 */
export function cx(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}
