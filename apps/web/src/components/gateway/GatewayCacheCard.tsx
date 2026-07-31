import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, percent } from '../../lib/format.js';
import { CACHE_BREAKEVEN_REUSE } from '../../lib/metrics/gatewayCache.js';
import type { CacheDay, CacheRow, CacheSummary } from '../../lib/metrics/gatewayCache.js';
import { Card } from '../Card.js';
import styles from './GatewayCacheCard.module.css';

/**
 * What the gateway is paying to send the same input twice.
 *
 * Every other card here reads dollars and asks who spent them. This one reads
 * the two counters beside them — tokens served from the providers' prompt cache
 * and tokens written into it — and asks the only question on the page with a
 * cheap answer: of everything we fed the models, how much had we fed them
 * before. A workload re-posting a 6,000-token system prompt on every call has no
 * owner to escalate to and produces no anomaly to flag; it just reads as busy on
 * every spend-shaped surface, which is precisely why it needs its own.
 *
 * The card reports **tokens, never dollars**. The proxy's daily aggregate
 * carries one spend figure per row covering input, output, cache reads and cache
 * writes together, and no per-model price — splitting it back apart would mean
 * assuming a price list, and this gateway fronts three backends whose lists
 * differ. The one weighted figure it does show is labelled as the pricing
 * *convention* it is.
 *
 * Only two states are badged, and both are faults under any of the three
 * backends' price lists rather than "below the average": a workload writing
 * cache entries it never reads back is paying the write premium for nothing, and
 * a workload with material volume and no cache activity at all is where the
 * headroom sits. Badging everything under the mean would badge half the rows by
 * construction — the reliability card learned that the expensive way.
 */

/** Enough to name where the input volume is; past this it is a table, not a finding. */
const MAX_ROWS = 8;

interface GatewayCacheCardProps {
  summary: CacheSummary;
}

/** 0..1 → `22.0%`, or `—` when there was no input to rate. */
function rate(value: number | null): string {
  return value === null ? EMPTY : percent(value * 100);
}

const STATE_LABEL: Record<CacheRow['state'], string | null> = {
  ok: null,
  churning: 'churning',
  unused: 'no cache',
};

export function GatewayCacheCard({ summary }: GatewayCacheCardProps) {
  const dimensionLabel = GATEWAY_DIMENSION_LABELS[summary.dimension].toLowerCase();
  const shown = summary.rows.slice(0, MAX_ROWS);
  const hidden = summary.rows.length - shown.length;
  const churning = summary.rows.filter((row) => row.state === 'churning');
  const cachedShare = summary.inputTokens > 0 ? summary.cachedTokens / summary.inputTokens : 0;

  if (summary.inputTokens === 0) return null;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Prompt cache</div>
          <div className={styles.sub}>
            input tokens the backends served from cache against the ones we paid to send again ·
            ranked by uncached input, which is the size of the opportunity rather than the size of
            the mistake
          </div>
        </div>
        <div className={styles.headline}>
          <div className={styles.headlineValue}>{rate(summary.hitRate)}</div>
          <div className={styles.headlineNote}>
            {compactCount(summary.cachedTokens)} of {compactCount(summary.inputTokens)} input tokens
            from cache
          </div>
        </div>
      </div>

      <div className={styles.split}>
        <div className={styles.splitTrack}>
          <div className={styles.splitCached} style={{ width: `${cachedShare * 100}%` }} />
        </div>
        <div className={styles.splitLegend}>
          <span className={styles.legendItem}>
            <span className={cx(styles.swatch, styles.swatchCached)} />
            {compactCount(summary.cachedTokens)} cached
          </span>
          <span className={styles.legendItem}>
            <span className={cx(styles.swatch, styles.swatchUncached)} />
            {compactCount(summary.uncachedTokens)} sent again
          </span>
        </div>
      </div>

      <DayStrip days={summary.daily} />

      <div className={styles.stats}>
        <Stat
          label="Reads per write"
          value={summary.reusePerWrite === null ? EMPTY : summary.reusePerWrite.toFixed(1)}
          sub={`break-even ${CACHE_BREAKEVEN_REUSE.toFixed(2)} · ${compactCount(summary.writeTokens)} tokens written`}
          tone={
            summary.reusePerWrite !== null && summary.reusePerWrite < CACHE_BREAKEVEN_REUSE
              ? 'bad'
              : 'good'
          }
        />
        <Stat
          label="Input bill avoided"
          value={rate(summary.estimatedSavingRatio)}
          sub="at the providers' usual 0.1× read and 1.25× write rates — a convention, not this proxy's prices"
        />
        <Stat
          label="Headroom"
          value={compactCount(summary.headroomTokens)}
          sub={`tokens that would move into cache if every ${dimensionLabel} below the gateway rate merely reached it`}
        />
        <Stat
          label="Churning"
          value={churning.length === 0 ? 'none' : String(churning.length)}
          sub={
            churning.length === 0
              ? `every ${dimensionLabel} that writes cache reads it back past break-even`
              : `${dimensionLabel}${churning.length === 1 ? '' : 's'} writing cache faster than they read it back`
          }
          tone={churning.length === 0 ? 'good' : 'bad'}
        />
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>{GATEWAY_DIMENSION_LABELS[summary.dimension].toUpperCase()}</div>
        <div />
        <div className={styles.right}>HIT RATE</div>
        <div className={styles.right}>SENT AGAIN</div>
        <div className={styles.right}>READS/WRITE</div>
        <div className={styles.right}>INPUT</div>
      </div>

      {shown.length === 0 ? (
        <div className={styles.empty}>
          The gateway reported no {dimensionLabel} breakdown for this range.
        </div>
      ) : (
        shown.map((row) => (
          <div key={row.key} className={cx(styles.row, row.state !== 'ok' && styles.rowFlagged)}>
            <div className={styles.name} title={row.key}>
              <span className={styles.key}>{row.label ?? row.key}</span>
              {row.label !== null && row.label !== row.key && (
                <span className={styles.sublabel}>{row.key}</span>
              )}
            </div>

            <div className={styles.trackCell}>
              <div className={styles.track}>
                <div
                  className={styles.fill}
                  style={{ width: `${(row.hitRate ?? 0) * 100}%` }}
                />
              </div>
              {STATE_LABEL[row.state] !== null && (
                <span className={cx(styles.badge, row.state === 'churning' && styles.badgeBad)}>
                  {STATE_LABEL[row.state]}
                </span>
              )}
            </div>

            <div className={styles.right}>{rate(row.hitRate)}</div>
            <div className={cx(styles.right, styles.muted)}>
              {compactCount(row.uncachedTokens)}
              <span className={styles.share}>
                {row.shareOfUncached === 0 ? EMPTY : `${percent(row.shareOfUncached * 100)} of all`}
              </span>
            </div>
            <div
              className={cx(
                styles.right,
                row.reusePerWrite !== null &&
                  row.reusePerWrite < CACHE_BREAKEVEN_REUSE &&
                  styles.bad,
              )}
            >
              {row.reusePerWrite === null ? EMPTY : row.reusePerWrite.toFixed(2)}
              <span className={styles.share}>
                {row.writeTokens === 0 ? 'nothing written' : `${compactCount(row.writeTokens)} written`}
              </span>
            </div>
            <div className={cx(styles.right, styles.muted)}>{compactCount(row.inputTokens)}</div>
          </div>
        ))
      )}

      <div className={styles.footer}>
        {hidden > 0 && (
          <>
            {hidden} more {dimensionLabel}
            {hidden === 1 ? '' : 's'} below the top {MAX_ROWS} ·{' '}
          </>
        )}
        Tokens, not dollars: the proxy reports one spend figure per row covering input, output and
        both cache operations together, so what a cached token saved cannot be separated out of it
        without assuming a price list — and this gateway fronts three.
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div
        className={cx(
          styles.statValue,
          tone === 'bad' && styles.bad,
          tone === 'good' && styles.good,
        )}
      >
        {value}
      </div>
      <div className={styles.statSub}>{sub}</div>
    </div>
  );
}

/**
 * One bar per day of the same spine the trend charts draw, scaled to the best
 * day's hit rate.
 *
 * Rate, not volume: a quiet Saturday caching 60% of a small input is doing
 * better than a busy Wednesday caching 10% of a huge one, and a token-count
 * strip would say the opposite. Days the gateway sent no input at all draw
 * nothing rather than a floor-height bar — there is no rate to show.
 */
function DayStrip({ days }: { days: readonly CacheDay[] }) {
  const peak = days.reduce((most, day) => Math.max(most, day.hitRate ?? 0), 0);
  if (peak === 0) return null;

  return (
    <div className={styles.strip}>
      <div className={styles.stripBars} role="img" aria-label="Daily prompt-cache hit rate">
        {days.map((day) => (
          <div
            key={day.date}
            className={styles.stripSlot}
            title={`${day.date} · ${rate(day.hitRate)} of ${compactCount(day.inputTokens)} input tokens from cache`}
          >
            <div
              className={styles.stripBar}
              style={{ height: `${((day.hitRate ?? 0) / peak) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className={styles.stripNote}>
        Daily hit rate, peaking at {rate(peak)}. A cache that is working holds its rate day to day;
        a step down is a prompt that changed shape.
      </div>
    </div>
  );
}
