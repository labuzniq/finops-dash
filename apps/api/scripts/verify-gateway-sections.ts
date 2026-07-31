/**
 * Ad-hoc check of the LLM gateway page's *table of contents* — the section
 * model in `apps/web/src/lib/gatewaySections.ts` and the anchors the page is
 * expected to declare for it. Not a test suite (the repo has none); run it by
 * hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-sections.ts
 *
 * It needs no database, no proxy and no env — half of it is pure, and the other
 * half reads two `.tsx` files as text.
 *
 * The pure half covers the three rules the module states:
 *
 *  - **page order, never re-ranked**: the nav comes back in the declared order
 *    whatever the presence map says and however its keys are ordered, because a
 *    nav that floated the busy section to the front would move under the reader
 *    between two visits.
 *  - **only what rendered**: a section whose every card stood itself down is
 *    dropped rather than listed, and a partly-drawn section reports the
 *    difference, because a jump button pointing at an empty wrapper is worse
 *    than no button.
 *  - **counts are cards**: the number beside a section is how many cards drew,
 *    which is the one figure that cannot disagree with the digest's count of
 *    findings.
 *
 * The textual half is the part worth having, and it is why this script exists
 * at all: the model and the page are two files that have to agree on a set of
 * string ids, and nothing in the type system connects them. A card renamed on
 * one side and not the other typechecks, builds, and renders a nav button that
 * scrolls nowhere. So every declared anchor must appear as an `id=` on the page
 * exactly once, every `gateway-*` id on the page must be declared, every anchor
 * must appear in the presence map, both must appear in page order, and every
 * anchor the *digest* scrolls to must still be one of them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GATEWAY_CARD_ANCHORS,
  GATEWAY_SECTIONS,
  deriveGatewayNav,
  sectionOfAnchor,
} from '../../web/src/lib/gatewaySections.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url));
const pageSource = readFileSync(`${webSrc}components/gateway/GatewayPage.tsx`, 'utf8');
const digestSource = readFileSync(`${webSrc}components/gateway/GatewayAttentionCard.tsx`, 'utf8');

const allOn = (): Record<string, boolean> =>
  Object.fromEntries(GATEWAY_CARD_ANCHORS.map((anchor) => [anchor, true]));

console.log('\nthe model');

const sectionIds = GATEWAY_SECTIONS.map((section) => section.id);
check(new Set(sectionIds).size === sectionIds.length, 'section ids are unique');
check(
  new Set(GATEWAY_CARD_ANCHORS).size === GATEWAY_CARD_ANCHORS.length,
  'no card anchor is declared in two sections',
);
check(
  sectionIds.every((id) => !GATEWAY_CARD_ANCHORS.includes(id)),
  'no section id collides with a card anchor — the heading is its own element',
);
check(
  GATEWAY_SECTIONS.every((section) => section.cards.length > 0),
  'every declared section has at least one card',
);
check(
  GATEWAY_SECTIONS.every((section) => section.blurb.length > 0 && section.label.length > 0),
  'every section carries a label and a line saying what it answers',
);
check(
  GATEWAY_CARD_ANCHORS.every((anchor) => anchor.startsWith('gateway-')),
  'every card anchor is namespaced to the gateway page',
);
check(
  GATEWAY_CARD_ANCHORS.every((anchor) => sectionOfAnchor(anchor) !== null) &&
    sectionOfAnchor('gateway-nothing') === null,
  'sectionOfAnchor resolves every declared anchor and nothing else',
);

console.log('\nthe nav');

const full = deriveGatewayNav(allOn());
check(full.length === GATEWAY_SECTIONS.length, 'a page that drew everything lists every section');
check(
  full.map((entry) => entry.section.id).join(',') === sectionIds.join(','),
  'the nav is in declared page order',
);
check(
  full.every((entry) => entry.hidden === 0),
  'nothing reads as hidden when every card drew',
);
check(deriveGatewayNav({}).length === 0, 'an empty presence map lists no sections at all');
check(
  deriveGatewayNav(Object.fromEntries(GATEWAY_CARD_ANCHORS.map((a) => [a, false]))).length === 0,
  'a page where every card stood itself down lists no sections',
);

// Key order in the presence map must not reach the output: the object is built
// by hand in the page and JS object order is insertion order, so a nav sorted by
// it would reshuffle the moment somebody moved a line.
const reversed = Object.fromEntries(
  [...GATEWAY_CARD_ANCHORS].reverse().map((anchor) => [anchor, true]),
);
check(
  deriveGatewayNav(reversed)
    .map((entry) => entry.section.id)
    .join(',') === sectionIds.join(','),
  'the presence map’s own key order changes nothing',
);

const operations = GATEWAY_SECTIONS.find((s) => s.id === 'gateway-section-operations');
const efficiency = GATEWAY_SECTIONS.find((s) => s.id === 'gateway-section-efficiency');
if (operations === undefined || efficiency === undefined) {
  throw new Error('the sections this script names have been renamed — update it');
}

// One card of the last-but-two section, none of the biggest one: the busy
// section disappears and the quiet one does not move up the order.
const sparse = deriveGatewayNav({ [efficiency.cards[0]!.anchor]: true });
check(sparse.length === 1, 'a single drawn card lists exactly its own section');
check(
  sparse[0]?.section.id === efficiency.id && sparse[0]?.cards.length === 1,
  'and lists only the card that drew',
);
check(
  sparse[0]?.hidden === efficiency.cards.length - 1,
  'the cards that stood themselves down are counted as hidden, not listed',
);

const withoutOperations = allOn();
for (const card of operations.cards) withoutOperations[card.anchor] = false;
const dropped = deriveGatewayNav(withoutOperations);
check(
  !dropped.some((entry) => entry.section.id === operations.id),
  'a section whose every card stood down is dropped rather than listed empty',
);
check(
  dropped.map((entry) => entry.section.id).join(',') ===
    sectionIds.filter((id) => id !== operations.id).join(','),
  'dropping the largest section leaves the rest in the same order',
);

const noisy = deriveGatewayNav({ ...allOn(), 'gateway-not-a-card': true });
check(
  noisy.length === full.length &&
    noisy.every((entry, index) => entry.cards.length === full[index]?.cards.length),
  'an anchor nobody declared cannot add itself to the nav',
);
check(
  deriveGatewayNav(
    Object.fromEntries(GATEWAY_CARD_ANCHORS.slice(0, 1).map((a) => [a, true])),
  ).every((entry) => entry.cards.every((card) => card.anchor === GATEWAY_CARD_ANCHORS[0])),
  'an anchor missing from the map reads as absent rather than as present',
);

console.log('\nthe page declares what the model claims');

const pageAnchors = [...pageSource.matchAll(/id="(gateway-[a-z-]+)"/g)].map((m) => m[1]!);
const declared = new Set<string>(GATEWAY_CARD_ANCHORS);

for (const anchor of GATEWAY_CARD_ANCHORS) {
  const hits = pageAnchors.filter((id) => id === anchor).length;
  check(hits === 1, `${anchor} is declared on the page exactly once (found ${hits})`);
}
check(
  pageAnchors.every((id) => declared.has(id)),
  `every gateway-* id on the page is a declared card anchor (stray: ${pageAnchors
    .filter((id) => !declared.has(id))
    .join(', ')})`,
);
check(
  pageAnchors.join(',') === GATEWAY_CARD_ANCHORS.join(','),
  'the page declares its anchors in the order the model lists them',
);

// The presence map is the one place the nav can lie, because it is written by
// hand: an anchor left out of it silently drops a card that is on the page.
for (const anchor of GATEWAY_CARD_ANCHORS) {
  check(
    pageSource.includes(`'${anchor}':`),
    `${anchor} carries an entry in the page's presence map`,
  );
}

const headingCalls = [...pageSource.matchAll(/section\('(gateway-section-[a-z-]+)'\)/g)].map(
  (m) => m[1]!,
);
check(
  headingCalls.length === sectionIds.length,
  `the page renders one heading per section (${headingCalls.length} of ${sectionIds.length})`,
);
check(
  headingCalls.join(',') === sectionIds.join(','),
  'the headings appear in the model’s declared order',
);

console.log('\nthe digest still lands somewhere');

const digestAnchors = [...digestSource.matchAll(/: '(gateway-[a-z-]+)'/g)].map((m) => m[1]!);
check(digestAnchors.length > 0, 'the digest’s anchor table was found and parsed');
check(
  digestAnchors.every((anchor) => declared.has(anchor)),
  `every anchor the digest scrolls to is a declared card anchor (stray: ${digestAnchors
    .filter((anchor) => !declared.has(anchor))
    .join(', ')})`,
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`gateway sections: all checks passed (${GATEWAY_CARD_ANCHORS.length} anchors)`);
