import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, percent, usd } from '../../lib/format.js';
import { CATALOG_DRIFT_TOLERANCE } from '../../lib/metrics/gatewayCatalog.js';
import type { CatalogRow, CatalogSummary } from '../../lib/metrics/gatewayCatalog.js';
import { Card } from '../Card.js';
import styles from './GatewayCatalogCard.module.css';

/**
 * The proxy's price list beside the bill it produced.
 *
 * Every other card on this page reads one number — what the gateway charged.
 * This one is the only place two independent facts meet: the rates
 * `/model/info` says the proxy is configured with, and the spend
 * `gateway_daily` says it recorded. On a model with one deployment and no
 * discount they agree to the cent, so a row that does *not* agree is a finding
 * — an override nobody wrote down, a deployment pointed at something other than
 * what the config names, or an enterprise rate the catalogue never sees.
 *
 * Three labels are load-bearing and none of them is decoration:
 *
 *  - the estimate is shown **beside** the bill and never in place of it;
 *  - a `price varies` row is a **floor** (several deployments, cheapest quoted,
 *    and no deployment id in the aggregate to split them by), so it is never
 *    read as a disagreement and never folded into the aggregate ratio;
 *  - a model the catalogue cannot price is **absent from coverage**, not priced
 *    at zero — which is why coverage is the number the card leads with.
 */

/** Past this the table stops being a finding and starts being the config file. */
const MAX_ROWS = 10;

interface GatewayCatalogCardProps {
  summary: CatalogSummary;
}

const STATE_LABEL: Record<CatalogRow['state'], string | null> = {
  matches: null,
  above: 'over list',
  below: 'under list',
  floor: 'floor',
  unpriced: 'no rate',
};

/** `$2.50` per million, or `—` where the catalogue has no rate at all. */
function rate(value: number | null): string {
  if (value === null) return EMPTY;
  return value >= 1 ? usd(value, 2) : `$${value.toFixed(3)}`;
}

/** `1.00×` — how the bill compares with the list price. */
function ratio(value: number | null): string {
  return value === null ? EMPTY : `${value.toFixed(2)}×`;
}

export function GatewayCatalogCard({ summary }: GatewayCatalogCardProps) {
  const shown = summary.rows.slice(0, MAX_ROWS);
  const hidden = summary.rows.length - shown.length;
  const gaps = summary.unlisted.length + summary.unpriced.length;
  const drift =
    summary.firmRatio === null ? null : Math.abs(summary.firmRatio - 1) > CATALOG_DRIFT_TOLERANCE;
  // The rows the two aggregate figures are measured over: priced, and quoting
  // one rate rather than a floor.
  const firmRows = summary.rows.filter(
    (row) => row.estimate !== null && row.price?.priceVaries === false,
  ).length;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Price catalogue</div>
          <div className={styles.sub}>
            what the proxy is configured to charge, against what it billed · an estimate beside the
            bill, never in place of it — a list rate knows nothing about a negotiated discount or a
            per-key override
          </div>
        </div>
        <div className={styles.headline}>
          <div className={styles.headlineValue}>{percent(summary.coverage * 100)}</div>
          <div className={styles.headlineNote}>
            of gateway spend sits on models the catalogue can price
          </div>
        </div>
      </div>

      <div className={styles.stats}>
        <Stat
          label="Priced at list"
          value={summary.firmBilled === 0 ? EMPTY : usd(summary.firmEstimate, 2)}
          sub={`against ${usd(summary.firmBilled, 2)} billed, on the ${firmRows} model${
            firmRows === 1 ? '' : 's'
          } quoting one firm rate`}
        />
        <Stat
          label="List vs bill"
          value={ratio(summary.firmRatio)}
          sub={
            summary.firmRatio === null
              ? 'no firm-rate model carried spend in this range'
              : drift === true
                ? 'the catalogue and the invoice disagree past rounding — a discount or an override the config does not record'
                : 'the catalogue reproduces the bill, so re-pricing tokens from it is sound here'
          }
          tone={summary.firmRatio === null ? undefined : drift === true ? 'bad' : 'good'}
        />
        <Stat
          label="Unpriceable"
          value={gaps === 0 ? 'none' : String(gaps)}
          sub={
            gaps === 0
              ? 'every model the gateway billed resolves to a rate'
              : `${summary.unlisted.length} not in the catalogue · ${summary.unpriced.length} listed with no per-token rate`
          }
          tone={gaps === 0 ? 'good' : undefined}
        />
        <Stat
          label="Configured, unused"
          value={String(summary.idleModels.length)}
          sub={`of ${summary.catalogueSize} alias${summary.catalogueSize === 1 ? '' : 'es'} the proxy offers saw no traffic in this range`}
        />
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>MODEL</div>
        <div className={styles.right}>IN $/M</div>
        <div className={styles.right}>OUT $/M</div>
        <div className={styles.right}>EFFECTIVE $/M</div>
        <div className={styles.right}>LIST VS BILL</div>
        <div className={styles.right}>SPEND</div>
      </div>

      {shown.map((row) => (
        <div
          key={row.key}
          className={cx(
            styles.row,
            (row.state === 'above' || row.state === 'below') && styles.rowFlagged,
          )}
        >
          <div className={styles.name} title={row.key}>
            <span className={styles.key}>{row.key}</span>
            <span className={styles.sublabel}>
              {row.price?.provider ?? 'unlisted'}
              {row.price !== null && row.price.deployments > 1 && (
                <> · {row.price.deployments} deployments</>
              )}
              {STATE_LABEL[row.state] !== null && (
                <span
                  className={cx(
                    styles.badge,
                    (row.state === 'above' || row.state === 'below') && styles.badgeBad,
                  )}
                >
                  {STATE_LABEL[row.state]}
                </span>
              )}
            </span>
          </div>

          <div className={cx(styles.right, styles.muted)}>
            {rate(row.price?.inputPerMillion ?? null)}
          </div>
          <div className={cx(styles.right, styles.muted)}>
            {rate(row.price?.outputPerMillion ?? null)}
          </div>
          <div className={styles.right}>
            {rate(row.effectivePerMillion)}
            <span className={styles.share}>
              {row.listPerMillion === null ? 'no list blend' : `list ${rate(row.listPerMillion)}`}
            </span>
          </div>
          <div
            className={cx(
              styles.right,
              row.state === 'above' && styles.bad,
              row.state === 'below' && styles.good,
            )}
          >
            {row.state === 'floor' ? `≥ ${ratio(row.ratio)}` : ratio(row.ratio)}
            <span className={styles.share}>
              {row.estimate === null ? 'nothing to compare' : `${usd(row.estimate, 2)} at list`}
            </span>
          </div>
          <div className={styles.right}>
            {usd(row.metrics.spend, 2)}
            <span className={styles.share}>
              {compactCount(row.metrics.totalTokens)} tokens · {percent(row.share * 100)}
            </span>
          </div>
        </div>
      ))}

      <div className={styles.footer}>
        {hidden > 0 && (
          <>
            {hidden} more model{hidden === 1 ? '' : 's'} below the top {MAX_ROWS} ·{' '}
          </>
        )}
        A “floor” row is served by more than one deployment at different prices and the daily
        aggregate carries no deployment id, so the catalogue quotes the cheapest of them — its
        estimate is a lower bound and is left out of the figures above. Anything past{' '}
        {percent(CATALOG_DRIFT_TOLERANCE * 100)} away from list on a single-deployment model is
        flagged; the bill, not the estimate, is what every other card on this page reads.
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
  // `exactOptionalPropertyTypes` is on, and the two tones here are computed
  // conditionally — so the absent case has to be spelled out rather than
  // omitted.
  tone?: 'good' | 'bad' | undefined;
}) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div
        className={cx(styles.statValue, tone === 'bad' && styles.bad, tone === 'good' && styles.good)}
      >
        {value}
      </div>
      <div className={styles.statSub}>{sub}</div>
    </div>
  );
}
