import { GATEWAY_DIMENSION_LABELS, SPEND_LOG_MAX_WINDOW_DAYS } from '@dash/shared';
import type { GatewayDimension } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, EMPTY, relativeTime, usd } from '../../lib/format.js';
import { cellId, DEPLOYMENT_MIN_REQUESTS } from '../../lib/metrics/gatewayLogs.js';
import type { SpendLogView } from '../../lib/metrics/gatewayLogs.js';
import { Card } from '../Card.js';
import styles from './GatewayRequestLogCard.module.css';

/**
 * The request sample — the one gateway surface where two dimensions meet.
 *
 * Everything else on this page reads the daily aggregates, which report each
 * dimension on its own: "what did this team spend" and "what did this model
 * cost" are both answerable there, and "which models did this team spend it on"
 * is not — the joint key does not exist in that payload. A request log row
 * carries every dimension at once, so the matrix below is the only thing here
 * that can answer it, and the deployment table under it is the only place a
 * *degraded* alias on the health card turns into a number of dollars.
 *
 * Three things the card must keep saying, because the layer is a sample and
 * nothing about a well-drawn table communicates that on its own:
 *
 *  - **it is read live and stores nothing** — there is a button rather than an
 *    automatic fetch, because this comes from the largest table the proxy has;
 *  - **it may not exist at all** — `disable_spend_logs` is an ordinary setting
 *    on a busy gateway, and that is a configuration rather than a fault;
 *  - **every dollar on it is a floor** — capped rows, a window of at most a
 *    week, and a retention schedule of its own. There is deliberately no
 *    share-of-gateway-spend column anywhere on this card; the one completeness
 *    figure it shows is in requests, against the ledger's own count.
 */

interface GatewayRequestLogCardProps {
  view: SpendLogView;
  /** Dimensions the aggregate payload answered for — the same list the breakdown offers. */
  available: readonly GatewayDimension[];
  onRowDimension: (dimension: GatewayDimension) => void;
  onColumnDimension: (dimension: GatewayDimension) => void;
  /** Reads the sample. The card never fetches on its own. */
  onRead: () => void;
  loading: boolean;
  error: Error | null;
  /** False while the gateway source is off — nothing to ask. */
  enabled: boolean;
}

/** Longer than this and a key is the column rather than a label in it. */
const MAX_KEY = 28;

function shorten(key: string): string {
  return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY - 1)}…`;
}

/**
 * A fraction as a percentage with one decimal.
 *
 * Not `percent()` from `lib/format`: that rounds to whole points, and the two
 * fractions on this card are routinely under one — a sample is a small slice of
 * a busy day, and a failure rate worth reading sits at 2.8%, not at 3%.
 */
function share(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function millis(value: number | null): string {
  if (value === null) return EMPTY;
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

export function GatewayRequestLogCard({
  view,
  available,
  onRowDimension,
  onColumnDimension,
  onRead,
  loading,
  error,
  enabled,
}: GatewayRequestLogCardProps) {
  const { window: sampleWindow } = view;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Request sample</div>
          <div className={styles.sub}>
            individual requests, read from the proxy live and stored nowhere · the only source that
            carries every dimension on one row, so it is the only place two of them can be crossed
          </div>
        </div>
        <button
          type="button"
          className={styles.run}
          onClick={onRead}
          disabled={!enabled || loading}
        >
          {loading ? 'Reading…' : view.answered ? 'Read again' : 'Read sample'}
        </button>
      </div>

      {error !== null && <div className={styles.failed}>{error.message}</div>}

      {!view.answered && error === null && (
        <div className={styles.idle}>
          Nothing is fetched until this is pressed. The read covers the last{' '}
          {SPEND_LOG_MAX_WINDOW_DAYS} days of the range on screen, asks the proxy for at most a few
          thousand rows, and keeps none of them — <code>LiteLLM_SpendLogs</code> is the largest
          table the gateway has, and a page that read it on open would run that query against
          production every time somebody navigated here.
        </div>
      )}

      {view.answered && !view.available && (
        <div className={styles.idle}>
          The proxy does not serve <code>/spend/logs</code>. On LiteLLM that most often means{' '}
          <code>disable_spend_logs</code> is set, which is a legitimate way to run a busy gateway
          rather than a fault — the per-request layer simply does not exist, and every other card on
          this page reads the daily aggregates and is unaffected.
        </div>
      )}

      {view.answered && view.available && view.isEmpty && (
        <div className={styles.idle}>
          The proxy answered and returned no requests for{' '}
          {sampleWindow === null ? 'this window' : `${sampleWindow.from} → ${sampleWindow.to}`}.
          Either nothing ran on those days, or the log table's own retention has already pruned them
          — it is configured separately from the 90 days the aggregates keep, and is usually far
          shorter.
        </div>
      )}

      {view.answered && view.available && !view.isEmpty && (
        <>
          <div className={styles.disclosure}>
            <span className={styles.sampleFlag}>sample</span>
            {count(view.sampleRequests)} requests over{' '}
            {sampleWindow === null ? 'the window' : `${sampleWindow.from} → ${sampleWindow.to}`}
            {view.sampledShare !== null && (
              <>
                {' '}
                — {share(view.sampledShare)} of the {compactCount(view.ledgerRequests ?? 0)} the
                daily aggregates recorded for the same days
              </>
            )}
            {view.truncated && (
              <> · the read was capped, so every dollar below is a floor and not a total</>
            )}
            {view.fetchedAt !== null && <> · read {relativeTime(view.fetchedAt)}</>}
          </div>

          <div className={styles.stats}>
            <Stat
              label="Sample spend"
              value={usd(view.sampleSpend, 2)}
              sub="what these requests cost — a floor on the window, never its total, which is the trend chart above"
            />
            <Stat
              label="Latency p50 / p95"
              value={`${millis(view.latency.p50Ms)} / ${millis(view.latency.p95Ms)}`}
              sub={`p99 ${millis(view.latency.p99Ms)} · the only latency the proxy exports at all — no aggregate row carries one${
                view.latency.untimed > 0
                  ? ` · ${count(view.latency.untimed)} requests carried no duration`
                  : ''
              }`}
            />
            <Stat
              label="Unattributed"
              value={view.unattributedRequests === 0 ? 'none' : count(view.unattributedRequests)}
              sub={
                view.unattributedRequests === 0
                  ? 'every request in the sample carries a key on both axes'
                  : 'carry no key on one axis or the other — counted here rather than bucketed as "other"'
              }
              tone={view.unattributedRequests === 0 ? 'good' : undefined}
            />
            <Stat
              label="Deployments"
              value={String(view.deployments.length)}
              sub={
                view.unjoinableRequests === 0
                  ? `across ${view.splits.length} alias${view.splits.length === 1 ? '' : 'es'} served by more than one`
                  : `${count(view.unjoinableRequests)} requests name no deployment — this proxy sets no model_id, so its pools cannot be told apart`
              }
              tone={view.unjoinableRequests === 0 ? undefined : 'warn'}
            />
          </div>

          <div className={styles.matrixHead}>
            <div>
              <div className={styles.sectionTitle}>
                {GATEWAY_DIMENSION_LABELS[view.rowDimension]} ×{' '}
                {GATEWAY_DIMENSION_LABELS[view.columnDimension]}
              </div>
              <div className={styles.sectionSub}>
                spend per pair, shaded against the heaviest cell drawn
                {view.rowDimension === 'tag' || view.columnDimension === 'tag' ? (
                  <> · a request carries a list of tags, so the cells sum past the sample</>
                ) : null}
              </div>
            </div>
            <div className={styles.axisPickers}>
              <AxisPicker
                label="Rows"
                value={view.rowDimension}
                available={available}
                onChange={onRowDimension}
              />
              <AxisPicker
                label="Columns"
                value={view.columnDimension}
                available={available}
                onChange={onColumnDimension}
              />
            </div>
          </div>

          {view.rows.length === 0 || view.columns.length === 0 ? (
            <div className={styles.idle}>
              No request in the sample carries a key on both of these axes. That is a fact about the
              sample, not about the gateway — a service key acting on nobody's behalf has no user,
              and a call made outside a team has no team.
            </div>
          ) : (
            <div className={styles.matrixScroll}>
              <table className={styles.matrix}>
                <thead>
                  <tr>
                    <th className={styles.corner} scope="col">
                      {GATEWAY_DIMENSION_LABELS[view.rowDimension]}
                    </th>
                    {view.columns.map((column) => (
                      <th key={column.key} scope="col" title={column.key}>
                        <span className={styles.columnKey}>{shorten(column.key)}</span>
                        <span className={styles.columnTotal}>{usd(column.spend, 2)}</span>
                      </th>
                    ))}
                    <th scope="col" className={styles.rowTotalHead}>
                      ROW
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row" className={styles.rowKey} title={row.key}>
                        {shorten(row.key)}
                      </th>
                      {view.columns.map((column) => {
                        const cell = view.cells.get(cellId(row.key, column.key));
                        if (cell === undefined) {
                          return (
                            <td key={column.key} className={styles.cellEmpty}>
                              {EMPTY}
                            </td>
                          );
                        }
                        return (
                          <td
                            key={column.key}
                            className={styles.cell}
                            title={`${count(cell.requests)} requests · ${compactCount(
                              cell.totalTokens,
                            )} tokens${cell.failed > 0 ? ` · ${count(cell.failed)} failed` : ''}`}
                          >
                            {/*
                              The tint is a *scale* against the heaviest drawn
                              cell, not a share of anything: a share needs a
                              denominator this layer does not have.
                            */}
                            <span
                              className={styles.cellFill}
                              style={{ opacity: 0.12 + cell.intensity * 0.68 }}
                            />
                            <span className={styles.cellValue}>{usd(cell.spend, 2)}</span>
                            <span className={styles.cellSub}>{compactCount(cell.requests)}</span>
                          </td>
                        );
                      })}
                      <td className={styles.rowTotal}>{usd(row.spend, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(view.hiddenRows > 0 || view.hiddenColumns > 0) && (
            <div className={styles.hidden}>
              {view.hiddenRows > 0 && `${view.hiddenRows} further row${view.hiddenRows === 1 ? '' : 's'}`}
              {view.hiddenRows > 0 && view.hiddenColumns > 0 && ' and '}
              {view.hiddenColumns > 0 &&
                `${view.hiddenColumns} further column${view.hiddenColumns === 1 ? '' : 's'}`}{' '}
              not drawn — the axes are ranked by sample spend and cut here rather than in the
              derivation, so the totals above still cover every key.
            </div>
          )}

          {view.splits.length > 0 && (
            <>
              <div className={styles.sectionTitle}>Which deployment served it</div>
              <div className={styles.sectionSub}>
                <code>model_id</code> is the only join between usage and the health reading, so this
                is the one place an alias that has lost a region becomes a number of requests and
                dollars — everywhere else the deployments behind an alias are already summed
              </div>
              {view.splits.map((split) => (
                <div key={split.model} className={styles.split}>
                  <div className={styles.splitHead}>
                    <span className={styles.splitName}>{split.model}</span>
                    <span className={styles.splitNote}>
                      {split.rows.length} deployments in the sample
                      {split.failureSpread !== null && split.failureSpread > 0 && (
                        <>
                          {' '}
                          · {(split.failureSpread * 100).toFixed(1)} points between their failure
                          rates
                        </>
                      )}
                      {split.latencyRatio !== null && split.latencyRatio >= 1.3 && (
                        <> · one is {split.latencyRatio.toFixed(1)}× slower at p95</>
                      )}
                    </span>
                  </div>
                  {split.rows.map((row) => (
                    <div key={row.deploymentId ?? 'unnamed'} className={styles.deployment}>
                      <span className={styles.deploymentId} title={row.deploymentId ?? undefined}>
                        {row.deploymentId ?? 'unnamed deployment'}
                      </span>
                      <span className={styles.deploymentNumber}>{count(row.requests)} req</span>
                      <span
                        className={cx(
                          styles.deploymentNumber,
                          row.material && row.failureRate > 0.1 && styles.bad,
                        )}
                      >
                        {row.material ? share(row.failureRate) : EMPTY} failed
                      </span>
                      <span className={styles.deploymentNumber}>{millis(row.p95Ms)} p95</span>
                      <span className={styles.deploymentNumber}>{usd(row.spend, 2)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

          <div className={styles.footer}>
            These rows are <strong>evidence, not the ledger</strong>. They may be switched off
            upstream, are pruned on a schedule of their own, and this read is capped — so nothing
            here is a share of gateway spend and every dollar is a floor. What they carry that no
            aggregate does is the joint key above, the request duration, and the deployment that
            served each call. A deployment below the {DEPLOYMENT_MIN_REQUESTS}-request floor shows
            no failure rate rather than a rate computed from a handful of calls.
          </div>
        </>
      )}
    </Card>
  );
}

function AxisPicker({
  label,
  value,
  available,
  onChange,
}: {
  label: string;
  value: GatewayDimension;
  available: readonly GatewayDimension[];
  onChange: (dimension: GatewayDimension) => void;
}) {
  return (
    <label className={styles.picker}>
      <span className={styles.pickerLabel}>{label}</span>
      <select
        className={styles.select}
        value={value}
        onChange={(event) => onChange(event.target.value as GatewayDimension)}
      >
        {available.map((option) => (
          <option key={option} value={option}>
            {GATEWAY_DIMENSION_LABELS[option]}
          </option>
        ))}
      </select>
    </label>
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
  tone?: 'good' | 'warn' | 'bad' | undefined;
}) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div
        className={cx(
          styles.statValue,
          tone === 'bad' && styles.bad,
          tone === 'warn' && styles.warn,
          tone === 'good' && styles.good,
        )}
      >
        {value}
      </div>
      <div className={styles.statSub}>{sub}</div>
    </div>
  );
}
