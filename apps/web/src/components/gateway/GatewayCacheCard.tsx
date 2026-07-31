import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, percent, usd } from '../../lib/format.js';
import { CACHE_BREAKEVEN_REUSE } from '../../lib/metrics/gatewayCache.js';
import type { CacheDay, CacheRow, CacheSummary } from '../../lib/metrics/gatewayCache.js';
import { hasCacheValue } from '../../lib/metrics/gatewayCacheValue.js';
import type {
  CacheValueGap,
  CacheValueRow,
  CacheValueSummary,
} from '../../lib/metrics/gatewayCacheValue.js';
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

/** The priced panel is a finding, not a table — four models name where the money is. */
const MAX_VALUE_ROWS = 4;

interface GatewayCacheCardProps {
  summary: CacheSummary;
  /**
   * The same cache activity priced from `GET /api/gateway/models`, always on the
   * `model` dimension whatever the switcher says. Absent while the catalogue has
   * not answered, or on a proxy that lists no cache rates — in which case the
   * card keeps its convention-weighted ratio, which needs no price list.
   */
  value?: CacheValueSummary | undefined;
}

/** 0..1 → `22.0%`, or `—` when there was no input to rate. */
function rate(value: number | null): string {
  return value === null ? EMPTY : percent(value * 100);
}

/**
 * The one thing on this card that is a statement about the *proxy* rather than
 * about a workload.
 *
 * Every rate here — the hit rate, the split bar, the day strip, and the priced
 * panel below — is measured under one convention: `prompt_tokens` is the whole
 * input and both cache counters are subsets of it. A payload where the cache
 * counters do not fit inside the prompt count falsifies that, and it does not
 * make the numbers *approximate*; it makes their denominators wrong by the size
 * of the cache. So it sits above them rather than in a footnote.
 */
function ConventionWarning({ check }: { check: CacheSummary['convention'] }) {
  if (check.verdict === 'consistent' || check.verdict === 'unobserved') return null;

  const what =
    check.verdict === 'reads_outside'
      ? 'cache reads are reported outside prompt_tokens on this proxy'
      : 'cache writes are reported outside prompt_tokens on this proxy';

  return (
    <div className={styles.conventionWarning}>
      <strong>Token accounting disagrees.</strong> {check.violations} of {check.rowsObserved} rows
      with cache activity report more cached tokens than prompt tokens (worst:{' '}
      {compactCount(check.worstExcessTokens)} over, on {check.sample.join(', ')}), which means{' '}
      {what}. Every rate on this card counts the cache inside the input total, so read them as
      understated until the convention is corrected.
    </div>
  );
}

const STATE_LABEL: Record<CacheRow['state'], string | null> = {
  ok: null,
  churning: 'churning',
  unused: 'no cache',
};

export function GatewayCacheCard({ summary, value }: GatewayCacheCardProps) {
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

      <ConventionWarning check={summary.convention} />

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

      {value !== undefined && hasCacheValue(value) && <PricedPanel value={value} />}

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
        {value !== undefined && hasCacheValue(value) && (
          <> The panel above is the exception: it reads the price list the proxy publishes, on the
          one dimension a rate belongs to.</>
        )}
      </div>
    </Card>
  );
}

const GAP_LABEL: Record<CacheValueGap, string> = {
  unlisted: 'not in the catalogue',
  unpriced: 'no per-token rate',
  no_cache_rate: 'no cache rate published',
};

/** Signed dollars, so a cache that costs money reads as a cost rather than as a small saving. */
function signedUsd(value: number): string {
  const shown = usd(Math.abs(value), 2);
  return value < 0 ? `−${shown}` : value > 0 ? `+${shown}` : shown;
}

/**
 * The cache read through the proxy's own price list.
 *
 * This is the one panel on the card that reports dollars, and it can only do so
 * on the `model` dimension — a rate belongs to a model, and one team's cached
 * tokens span every model it touched at rates differing by a factor. So it stays
 * pinned to `model` whatever the switcher above says, and the note says as much
 * rather than leaving a reader to assume the two tables share a key.
 *
 * The figure is a *counterfactual*: what those same input tokens would have cost
 * with no cache at all, minus what the catalogue says they cost with one. It is
 * never subtracted from `spend` and no other card reads it, because a list rate
 * ignores every discount the account carries — which is exactly what the price
 * catalogue card measures and this one inherits.
 */
function PricedPanel({ value }: { value: CacheValueSummary }) {
  const shown = value.rows.slice(0, MAX_VALUE_ROWS);
  const hidden = value.rows.length - shown.length;
  const negative = value.netSaving < 0;

  return (
    <div className={styles.priced}>
      <div className={styles.pricedHead}>
        <div>
          <div className={styles.pricedTitle}>Priced from the catalogue · by model</div>
          <div className={styles.sub}>
            the same cache activity at the rates the proxy publishes, against what these input
            tokens would have cost with no cache at all — an estimate beside the bill, never in
            place of it
          </div>
        </div>
        <div className={styles.headline}>
          <div className={cx(styles.headlineValue, negative ? styles.bad : styles.good)}>
            {signedUsd(value.netSaving)}
          </div>
          <div className={styles.headlineNote}>
            {value.savingShare === null
              ? 'nothing to compare'
              : `${percent(Math.abs(value.savingShare) * 100)} ${negative ? 'above' : 'off'} a ${usd(value.noCacheInputCost, 0)} no-cache input bill`}
          </div>
        </div>
      </div>

      <div className={styles.pricedStats}>
        <Stat
          label="Reads saved"
          value={usd(value.readSaving, 2)}
          sub={`${compactCount(value.pricedCacheTokens)} cache tokens priced · ${percent(value.coverage * 100)} of the gateway's`}
          tone="good"
        />
        <Stat
          label="Writes cost"
          value={usd(value.writePremium, 2)}
          sub="the premium every backend charges over a plain input token to put one in the cache"
          tone={value.writePremium > value.readSaving ? 'bad' : undefined}
        />
        <Stat
          label="Headroom"
          value={usd(value.headroomValue, 2)}
          sub={`${compactCount(value.headroomTokens)} tokens at their own models' read discounts, if each merely reached the gateway rate`}
        />
        <Stat
          label="Unpriceable"
          value={value.gaps.length === 0 ? 'none' : String(value.gaps.length)}
          sub={
            value.gaps.length === 0
              ? 'every model with cache activity carries a rate'
              : value.gaps
                  .slice(0, 3)
                  .map((gap) => `${gap.label ?? gap.key} (${GAP_LABEL[gap.gap]})`)
                  .join(' · ')
          }
        />
      </div>

      <div className={cx(styles.pricedRow, styles.headerStrip)}>
        <div>MODEL</div>
        <div className={styles.right}>NET</div>
        <div className={styles.right}>READS SAVED</div>
        <div className={styles.right}>WRITES COST</div>
        <div className={styles.right}>HEADROOM</div>
      </div>

      {shown.map((row) => (
        <PricedRow key={row.key} row={row} />
      ))}

      <div className={styles.pricedNote}>
        {hidden > 0 && (
          <>
            {hidden} more priced model{hidden === 1 ? '' : 's'} ·{' '}
          </>
        )}
        {value.floorRows.length > 0 && (
          <>
            {value.floorRows.length} model{value.floorRows.length === 1 ? '' : 's'} served by several
            deployments ({signedUsd(value.floorNetSaving)}) are kept out of these totals: the
            catalogue reports the cheapest of them, so their saving is a lower bound rather than a
            rate ·{' '}
          </>
        )}
        A missing cache rate is left unpriced rather than read as no discount, and nothing here is
        subtracted from what the proxy billed.
      </div>
    </div>
  );
}

function PricedRow({ row }: { row: CacheValueRow }) {
  const negative = row.netSaving < 0;
  return (
    <div className={cx(styles.pricedRow, negative && styles.rowFlagged)}>
      <div className={styles.name} title={row.key}>
        <span className={styles.key}>{row.label ?? row.key}</span>
        <span className={styles.sublabel}>
          {usd(row.inputPerMillion, 2)}/M in ·{' '}
          {row.cacheReadPerMillion === null
            ? 'no read rate'
            : `${usd(row.cacheReadPerMillion, 2)}/M read`}
        </span>
      </div>
      <div className={cx(styles.right, negative ? styles.bad : styles.good)}>
        {signedUsd(row.netSaving)}
        <span className={styles.share}>
          {row.savingShare === null ? EMPTY : `${percent(row.savingShare * 100)} of its input bill`}
        </span>
      </div>
      <div className={cx(styles.right, styles.muted)}>
        {usd(row.readSaving, 2)}
        <span className={styles.share}>{compactCount(row.cachedTokens)} read</span>
      </div>
      <div className={cx(styles.right, styles.muted)}>
        {usd(row.writePremium, 2)}
        <span className={styles.share}>{compactCount(row.writeTokens)} written</span>
      </div>
      <div className={cx(styles.right, styles.muted)}>
        {usd(row.headroomValue, 2)}
        <span className={styles.share}>{compactCount(row.headroomTokens)} tokens</span>
      </div>
    </div>
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
  tone?: 'good' | 'bad' | undefined;
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
