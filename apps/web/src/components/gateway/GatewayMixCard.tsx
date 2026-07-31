import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, usd } from '../../lib/format.js';
import { dominantEffect } from '../../lib/metrics/gatewayMix.js';
import type { GatewayMixDecomposition, GatewayMixRow } from '../../lib/metrics/gatewayMix.js';
import { Card } from '../Card.js';
import styles from './GatewayMixCard.module.css';

/**
 * Why the gateway's spend moved — volume, mix and rate, for the dimension the
 * breakdown card is currently showing.
 *
 * The movers card answers "which keys moved the dollars". This one answers the
 * question that follows it and that no other card on the page can: whether the
 * bill grew because the gateway did *more*, because the traffic moved *to
 * something dearer*, or because the same slice *cost more per token*. Those are
 * three different conversations — capacity, routing, and pricing — and a spend
 * total on its own cannot tell them apart.
 *
 * The three numbers are an identity, not an apportionment: they sum to the
 * spend movement exactly, per key and gateway-wide, which is why they are drawn
 * on one shared scale and why the table's rows can be read as contributions.
 *
 * Read through the switcher deliberately, because mix and rate are *relative to
 * the slice*: traffic moving from a cheap model to a dear one inside one
 * provider is mix by model and rate by provider. Neither reading is wrong, and
 * seeing the same movement change character between them is itself the finding.
 */

/** Enough rows to see who moved the price; past this it is a ledger. */
const MAX_ROWS = 8;

interface GatewayMixCardProps {
  decomposition: GatewayMixDecomposition;
}

interface Effect {
  key: 'volume' | 'mix' | 'rate';
  title: string;
  blurb: string;
  amount: number;
}

function signedUsd(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${usd(Math.abs(value), decimals)}`;
}

function pricePair(row: GatewayMixRow): string {
  const before = row.previousPrice === null ? EMPTY : `$${row.previousPrice.toFixed(2)}`;
  const now = row.currentPrice === null ? EMPTY : `$${row.currentPrice.toFixed(2)}`;
  return `${before} → ${now}`;
}

function sharePair(row: GatewayMixRow): string {
  return `${(row.previousShare * 100).toFixed(1)}% → ${(row.currentShare * 100).toFixed(1)}%`;
}

/**
 * The card's opening claim, derived rather than asserted: which effect carried
 * the movement, and what that effect *means* in the direction it moved.
 */
function headline(decomposition: GatewayMixDecomposition, dimensionLabel: string): string {
  const { delta, previousSpend, volume, mix, rate, previousTokens, currentTokens } = decomposition;
  const rose = delta > 0;
  const pct = previousSpend > 0 ? Math.abs(delta / previousSpend) * 100 : 0;
  const tokenPct =
    previousTokens > 0 ? ((currentTokens - previousTokens) / previousTokens) * 100 : 0;
  const opening = `Spend ${rose ? 'rose' : 'fell'} ${usd(Math.abs(delta), 2)} (${pct.toFixed(1)}%).`;

  switch (dominantEffect(decomposition)) {
    case 'volume':
      return (
        `${opening} Mostly volume — the gateway processed ` +
        `${tokenPct >= 0 ? '' : '−'}${Math.abs(tokenPct).toFixed(1)}% ` +
        `${tokenPct >= 0 ? 'more' : 'fewer'} tokens at close to the prices it was already paying.`
      );
    case 'mix':
      return (
        `${opening} Mostly mix — the token count explains ${signedUsd(volume)}, but traffic ` +
        `shifted toward ${mix > 0 ? 'dearer' : 'cheaper'} ${dimensionLabel.toLowerCase()}s, ` +
        `worth ${signedUsd(mix)}.`
      );
    default:
      return (
        `${opening} Mostly rate — the same ${dimensionLabel.toLowerCase()}s cost ` +
        `${rate > 0 ? 'more' : 'less'} per token than before, worth ${signedUsd(rate)}, ` +
        `with volume at ${signedUsd(volume)}.`
      );
  }
}

export function GatewayMixCard({ decomposition }: GatewayMixCardProps) {
  const { dimension, window, delta, volume, mix, rate } = decomposition;
  const dimensionLabel = GATEWAY_DIMENSION_LABELS[dimension];
  const lower = dimensionLabel.toLowerCase();

  const effects: Effect[] = [
    {
      key: 'volume',
      title: 'Volume',
      blurb: 'more tokens at the prices already being paid',
      amount: volume,
    },
    {
      key: 'mix',
      title: 'Mix',
      blurb: `the same tokens routed to a different ${lower}`,
      amount: mix,
    },
    {
      key: 'rate',
      title: 'Rate',
      blurb: `the same ${lower} costing more per token`,
      amount: rate,
    },
  ];

  const scale = effects.reduce((peak, effect) => Math.max(peak, Math.abs(effect.amount)), 0);
  const gross = effects.reduce((sum, effect) => sum + Math.abs(effect.amount), 0);
  const shown = decomposition.rows.slice(0, MAX_ROWS);
  const hidden = decomposition.rows.length - shown.length;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Why spend moved · by {lower}</div>
        <div className={styles.sub}>
          vs {window.from} … {window.to} · {window.days}d
        </div>
      </div>

      <div className={styles.headline}>{headline(decomposition, dimensionLabel)}</div>

      <div className={styles.effects}>
        {effects.map((effect) => {
          const up = effect.amount > 0;
          const width = scale > 0 ? (Math.abs(effect.amount) / scale) * 50 : 0;
          return (
            <div key={effect.key} className={styles.effectRow}>
              <div className={styles.effectName}>
                <span className={styles.effectTitle}>{effect.title}</span>
                <span className={styles.effectBlurb}>{effect.blurb}</span>
              </div>
              <div className={styles.track}>
                <div className={styles.axis} />
                <div
                  className={cx(styles.fill, up ? styles.up : styles.down)}
                  style={{ left: `${up ? 50 : 50 - width}%`, width: `${width}%` }}
                />
              </div>
              <div className={cx(styles.right, up ? styles.upText : styles.downText)}>
                {signedUsd(effect.amount)}
              </div>
              <div className={cx(styles.right, styles.muted)}>
                {gross > 0 ? `${((Math.abs(effect.amount) / gross) * 100).toFixed(0)}%` : EMPTY}
              </div>
            </div>
          );
        })}

        <div className={cx(styles.effectRow, styles.totalRow)}>
          <div className={styles.effectName}>
            <span className={styles.effectTitle}>Movement</span>
            <span className={styles.effectBlurb}>
              {usd(decomposition.previousSpend, 2)} → {usd(decomposition.currentSpend, 2)}
            </span>
          </div>
          <div className={styles.priceNote}>
            blended ${decomposition.previousPrice.toFixed(2)}/M → $
            {decomposition.priceAtPriorRates.toFixed(2)}/M at the new mix → $
            {decomposition.currentPrice.toFixed(2)}/M
          </div>
          <div className={cx(styles.right, delta > 0 ? styles.upText : styles.downText)}>
            {signedUsd(delta)}
          </div>
          <div className={cx(styles.right, styles.muted)}>100%</div>
        </div>
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>{dimensionLabel.toUpperCase()}</div>
        <div className={styles.right}>TOKEN SHARE</div>
        <div className={styles.right}>$/1M TOKENS</div>
        <div className={styles.right}>MIX</div>
        <div className={styles.right}>RATE</div>
        <div className={styles.right}>Δ SPEND</div>
      </div>

      {shown.map((row) => (
        <div key={row.key} className={styles.row}>
          <div className={styles.name} title={row.key}>
            <span className={styles.key}>{row.key}</span>
            {row.label !== null && row.label !== row.key && (
              <span className={styles.label}>{row.label}</span>
            )}
          </div>
          <div className={cx(styles.right, styles.muted)}>
            {sharePair(row)}
            <span className={styles.tokens}>{compactCount(row.currentTokens)}</span>
          </div>
          <div className={styles.right}>{pricePair(row)}</div>
          <div className={cx(styles.right, row.mix > 0 ? styles.upText : styles.downText)}>
            {signedUsd(row.mix)}
          </div>
          <div className={cx(styles.right, row.rate > 0 ? styles.upText : styles.downText)}>
            {signedUsd(row.rate)}
          </div>
          <div className={styles.right}>{signedUsd(row.total)}</div>
        </div>
      ))}

      {hidden > 0 && (
        <div className={styles.footnote}>
          {hidden} more {lower}
          {hidden === 1 ? '' : 's'} moved less.
        </div>
      )}

      <div className={styles.footnote}>
        Volume is counted in tokens, so a workload that keeps its request count and doubles its
        prompt length reads as volume rather than as a price change. Each {lower}&apos;s rate is a
        blended input+output price, so an output-heavy shift inside one {lower} lands in rate. Mix
        and rate are relative to this slice: the same movement can read as mix by model and as rate
        by provider.
      </div>
    </Card>
  );
}
