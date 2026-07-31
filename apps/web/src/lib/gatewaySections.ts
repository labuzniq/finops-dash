/**
 * The LLM gateway page's own table of contents.
 *
 * The page is twenty-four cards long and every one of them was added under a
 * card above it, so the order is a narrative rather than an accident: what is
 * stored, what needs attention, what it cost, who is capped, what was billed,
 * what broke, what was wasted, who used it, and the raw requests underneath.
 * Reading it top to bottom works; arriving with a question does not, because
 * nothing on the page says where the answer lives.
 *
 * This module is the one statement of that structure, and it deliberately holds
 * no judgement of its own:
 *
 * - **Sections are in page order and are never re-ranked.** A nav that floated
 *   the section with findings to the front would move under the reader between
 *   two visits, and the digest above already carries the "look here first"
 *   answer with the numbers behind it.
 * - **A section is listed only when something inside it rendered.** More than
 *   half the cards stand themselves down (no cache activity, no sealed month,
 *   no MCP traffic, a recording that has not started), and a jump button
 *   pointing at an empty wrapper is worse than no button — the same rule the
 *   page's anchor comment already states for the digest.
 * - **The count beside a section is cards, never findings.** Counting findings
 *   would be a second digest, computed differently from the first, and two
 *   answers to "what needs attention" is exactly the disagreement
 *   `gatewayAlerts.ts` exists to prevent.
 *
 * The card anchors here are the same ids the digest scrolls to (see
 * `GatewayAttentionCard`), extended to the cards that had no anchor because
 * nothing pointed at them yet. Section anchors are separate ids on the section
 * heading, so jumping to a one-card section lands on the heading that names it
 * rather than mid-card.
 */

export interface GatewaySectionCard {
  /** The `id` of the wrapper element on the page. */
  readonly anchor: string;
  readonly label: string;
}

export interface GatewaySection {
  /** The `id` of the section heading — distinct from every card anchor. */
  readonly id: string;
  readonly label: string;
  /** One line, shown under the heading; says what the section answers. */
  readonly blurb: string;
  readonly cards: readonly GatewaySectionCard[];
}

export const GATEWAY_SECTIONS: readonly GatewaySection[] = [
  {
    id: 'gateway-section-overview',
    label: 'Overview',
    blurb: 'What is stored, what needs attention, and the headline numbers for the range.',
    cards: [
      { anchor: 'gateway-coverage', label: 'Stored coverage' },
      { anchor: 'gateway-attention', label: 'Needs attention' },
      { anchor: 'gateway-kpis', label: 'Headline metrics' },
      { anchor: 'gateway-forecast', label: 'Month-end forecast' },
    ],
  },
  {
    id: 'gateway-section-governance',
    label: 'Governance',
    blurb: 'The caps and rate limits the proxy enforces, per key, team, tag and user.',
    cards: [{ anchor: 'gateway-budgets', label: 'Budgets and limits' }],
  },
  {
    id: 'gateway-section-statements',
    label: 'Statements',
    blurb: 'What each payer owes for a calendar month, and every month already sealed.',
    cards: [
      { anchor: 'gateway-chargeback', label: 'Monthly statement' },
      { anchor: 'gateway-ledger', label: 'Sealed months' },
    ],
  },
  {
    id: 'gateway-section-spend',
    label: 'Spend',
    blurb: 'Where the money went over the range on screen, and what moved it.',
    cards: [
      { anchor: 'gateway-trends', label: 'Daily trends' },
      { anchor: 'gateway-anomalies', label: 'Unusual spend' },
      { anchor: 'gateway-breakdown', label: 'Breakdown' },
      { anchor: 'gateway-movers', label: 'Biggest movers' },
      { anchor: 'gateway-mix', label: 'Volume, mix and rate' },
    ],
  },
  {
    id: 'gateway-section-operations',
    label: 'Operations',
    blurb: 'The same traffic asked how many calls failed, why, how slowly, and what is failing now.',
    cards: [
      { anchor: 'gateway-reliability', label: 'Reliability' },
      { anchor: 'gateway-exceptions', label: 'What broke' },
      { anchor: 'gateway-exception-history', label: 'What broke over time' },
      { anchor: 'gateway-latency', label: 'Latency' },
      { anchor: 'gateway-latency-history', label: 'Latency over time' },
      { anchor: 'gateway-slow-responses', label: 'Hangs' },
      { anchor: 'gateway-slow-response-history', label: 'Hangs over time' },
      { anchor: 'gateway-health', label: 'Deployment health' },
      { anchor: 'gateway-health-history', label: 'Health over time' },
    ],
  },
  {
    id: 'gateway-section-efficiency',
    label: 'Efficiency',
    blurb: 'What was paid for twice, and the rates the proxy is configured to charge.',
    cards: [
      { anchor: 'gateway-cache', label: 'Prompt cache' },
      { anchor: 'gateway-catalog', label: 'Price catalogue' },
    ],
  },
  {
    id: 'gateway-section-adoption',
    label: 'Adoption',
    blurb: 'Agent-shaped traffic against everything else, and how many people are behind it.',
    cards: [
      { anchor: 'gateway-agents', label: 'MCP-attributed traffic' },
      { anchor: 'gateway-adoption', label: 'People' },
    ],
  },
  {
    id: 'gateway-section-requests',
    label: 'Requests',
    blurb: 'Individual calls from the proxy — the only source carrying a joint key.',
    cards: [{ anchor: 'gateway-request-log', label: 'Request sample' }],
  },
];

/** Every card anchor the page is expected to declare, in page order. */
export const GATEWAY_CARD_ANCHORS: readonly string[] = GATEWAY_SECTIONS.flatMap((section) =>
  section.cards.map((card) => card.anchor),
);

/** Which cards of a section actually rendered this time. */
export interface GatewayNavEntry {
  readonly section: GatewaySection;
  readonly cards: readonly GatewaySectionCard[];
  /** Cards of the section that stood themselves down. */
  readonly hidden: number;
}

/**
 * The nav for one render.
 *
 * `rendered` is the page's own presence map — the same `has*` predicates the
 * JSX below it is gated on, so the nav cannot claim a card the page did not
 * draw. An anchor missing from the map is treated as absent rather than as
 * present: a card nobody wired in is exactly the button that would scroll
 * nowhere.
 */
export function deriveGatewayNav(
  rendered: Readonly<Record<string, boolean>>,
): readonly GatewayNavEntry[] {
  const entries: GatewayNavEntry[] = [];
  for (const section of GATEWAY_SECTIONS) {
    const cards = section.cards.filter((card) => rendered[card.anchor] === true);
    if (cards.length === 0) continue;
    entries.push({ section, cards, hidden: section.cards.length - cards.length });
  }
  return entries;
}

/** The section a card anchor belongs to, or null for an anchor nothing declares. */
export function sectionOfAnchor(anchor: string): GatewaySection | null {
  return GATEWAY_SECTIONS.find((section) => section.cards.some((c) => c.anchor === anchor)) ?? null;
}
