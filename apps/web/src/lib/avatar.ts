/**
 * Avatar tints. The prototype rotated three hues at 35% opacity; the seed was
 * a random field on the mock user, which real seats don't carry — so derive it
 * from the login instead. Same look, and stable for a given person.
 */

const TINTS = ['#9184d9', '#a7a1db', '#9397ab'] as const;

function hash(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    total = (total + value.charCodeAt(i)) % 2_147_483_647;
  }
  return total;
}

export function avatarTint(login: string): string {
  const tint = TINTS[hash(login) % TINTS.length]!;
  return `color-mix(in srgb, ${tint} 35%, transparent)`;
}
