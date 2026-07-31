import { costPerRequest } from '@dash/shared';
import type { GatewayMetrics } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, EMPTY, percent, usd } from '../../lib/format.js';
import type { AgentTrafficDay, AgentTrafficSummary } from '../../lib/metrics/gatewayAgents.js';
import { Card } from '../Card.js';
import styles from './GatewayAgentsCard.module.css';

/**
 * Agents vs everything else.
 *
 * Every other card on this page ranks *within* one of the overlapping
 * dimensions. This one is the exception the data allows: `mcp_server` is a
 * strict subset of the same requests, so the gateway really does split into
 * MCP-attributed traffic and the remainder, and the two halves can be compared
 * on unit economics without double-counting a dollar.
 *
 * The wording is deliberately "MCP-attributed", never "agents". LiteLLM tags a
 * call with a server only when it routed through MCP; an agent that calls
 * `/chat/completions` with its own tool loop lands in the remainder, alongside
 * every human chat turn. The number is a floor on agent traffic, and the card
 * says so rather than implying a clean split it cannot deliver.
 *
 * The two things worth reading here are the *contrast* and the *direction*. A
 * tool turn ships schemas, tool results and the conversation so far, so it is
 * usually a heavier and dearer call than a chat turn — but the card measures
 * that ratio rather than assuming it, because a gateway whose MCP traffic is
 * short lookups runs the other way. And the share climbing half-over-half is
 * the number that says next quarter's bill will not look like this one's.
 */

/** Enough to name the servers; past this it stops being a finding. */
const MAX_ROWS = 6;

interface GatewayAgentsCardProps {
  summary: AgentTrafficSummary;
}

/** 0..1 → `18.4%`, or `—` when there was no denominator. */
function share(value: number | null): string {
  return value === null ? EMPTY : percent(value * 100);
}

/** Tokens per request — the shape of a call, not its price. */
function tokensPerRequest(metrics: GatewayMetrics): number | null {
  return metrics.requests > 0 ? metrics.totalTokens / metrics.requests : null;
}

/** `4.1×` — how much more an attributed call costs than one in the remainder. */
function ratioLabel(agent: number | null, rest: number | null): string {
  if (agent === null || rest === null || rest === 0) return EMPTY;
  return `${(agent / rest).toFixed(1)}×`;
}

/**
 * Whether agent calls are heavier or lighter than the rest, read off the two
 * shares rather than asserted.
 *
 * Both are real gateways: tool loops carry schemas and results and usually run
 * heavy, but a proxy whose MCP traffic is short lookups against a Jira server
 * runs light, and a card that only knows how to say "heavier" would be wrong
 * about the second one every day.
 */
function weightNote(summary: AgentTrafficSummary): string {
  const { tokenShare, requestShare } = summary;
  if (tokenShare === null || requestShare === null) return 'no calls to weigh';
  const gap = (tokenShare - requestShare) * 100;
  if (Math.abs(gap) < 0.5) return 'the same weight as everything else';
  return gap > 0
    ? 'a heavier call than its count suggests'
    : 'a lighter call than its count suggests';
}

export function GatewayAgentsCard({ summary }: GatewayAgentsCardProps) {
  const { attributed, remainder, totals, trend } = summary;

  const agentPerRequest = costPerRequest(attributed);
  const restPerRequest = costPerRequest(remainder);
  const agentTokens = tokensPerRequest(attributed);
  const restTokens = tokensPerRequest(remainder);

  const shown = summary.servers.slice(0, MAX_ROWS);
  const hidden = summary.servers.length - shown.length;
  const leader = shown[0]?.metrics.spend ?? 0;
  const spentShare = totals.spend > 0 ? (attributed.spend / totals.spend) * 100 : 0;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Agent traffic</div>
          <div className={styles.sub}>
            calls the proxy attributed to an MCP server, against everything else it served
          </div>
        </div>
        <div className={styles.headline}>
          <div className={styles.kicker}>SHARE OF SPEND</div>
          <div className={styles.headlineValue}>{share(summary.spendShare)}</div>
          <div className={styles.headlineNote}>{usd(attributed.spend, 2)} of {usd(totals.spend, 2)}</div>
        </div>
      </div>

      <div className={styles.body}>
        {/* One bar, two segments: this is a partition, and the only one the
            overlapping dimensions permit. */}
        <div className={styles.track} role="presentation">
          <div className={styles.agentFill} style={{ width: `${Math.min(100, spentShare)}%` }} />
        </div>
        <div className={styles.trackNote}>
          <span>
            <span className={styles.swatchAgent} /> {usd(attributed.spend, 2)} MCP-attributed ·{' '}
            {compactCount(attributed.requests)} calls
          </span>
          <span className={styles.muted}>
            <span className={styles.swatchRest} /> {usd(remainder.spend, 2)} everything else ·{' '}
            {compactCount(remainder.requests)} calls
          </span>
        </div>

        <ShareStrip days={summary.daily} />

        <div className={styles.statRow}>
          <div className={styles.stat}>
            <div className={styles.kicker}>SHARE OF CALLS</div>
            <div className={styles.statValue}>{share(summary.requestShare)}</div>
            <div className={styles.statSub}>
              {share(summary.tokenShare)} of tokens — {weightNote(summary)}
            </div>
          </div>
          <div className={styles.stat}>
            <div className={styles.kicker}>COST PER CALL</div>
            <div className={styles.statValue}>
              {agentPerRequest === null ? EMPTY : usd(agentPerRequest, 4)}
            </div>
            <div className={styles.statSub}>
              {ratioLabel(agentPerRequest, restPerRequest)} the rest of the gateway (
              {restPerRequest === null ? EMPTY : usd(restPerRequest, 4)})
            </div>
          </div>
          <div className={styles.stat}>
            <div className={styles.kicker}>TOKENS PER CALL</div>
            <div className={styles.statValue}>
              {agentTokens === null ? EMPTY : count(Math.round(agentTokens))}
            </div>
            <div className={styles.statSub}>
              {ratioLabel(agentTokens, restTokens)} the rest (
              {restTokens === null ? EMPTY : count(Math.round(restTokens))})
            </div>
          </div>
          <div className={styles.stat}>
            <div className={styles.kicker}>DIRECTION</div>
            <TrendValue trend={summary.trend} />
            <div className={styles.statSub}>
              {trend === null
                ? 'too few days on screen to compare halves'
                : `${share(trend.firstHalfShare)} over the first ${trend.firstHalfDays}d · ${share(trend.secondHalfShare)} over the last ${trend.secondHalfDays}d`}
            </div>
          </div>
        </div>

        <div className={cx(styles.row, styles.headerStrip)}>
          <div>MCP SERVER</div>
          <div />
          <div className={styles.right}>SPEND</div>
          <div className={styles.right}>OF AGENT SPEND</div>
          <div className={styles.right}>CALLS</div>
          <div className={styles.right}>$/CALL</div>
        </div>

        {shown.map((row) => {
          const perRequest = costPerRequest(row.metrics);
          return (
            <div key={row.key} className={styles.row}>
              <div className={styles.name} title={row.key}>
                <span className={styles.key}>{row.label ?? row.key}</span>
                {row.label !== null && row.label !== row.key && (
                  <span className={styles.sublabel}>{row.key}</span>
                )}
              </div>
              <div className={styles.trackCell}>
                <div className={styles.rowTrack}>
                  <div
                    className={styles.rowFill}
                    style={{ width: leader > 0 ? `${(row.metrics.spend / leader) * 100}%` : '0%' }}
                  />
                </div>
              </div>
              <div className={styles.right}>{usd(row.metrics.spend, 2)}</div>
              <div className={cx(styles.right, styles.muted)}>
                {percent(row.shareOfAttributed * 100)}
                <span className={styles.share}>{percent(row.shareOfGateway * 100)} of gateway</span>
              </div>
              <div className={cx(styles.right, styles.muted)}>{compactCount(row.metrics.requests)}</div>
              <div className={cx(styles.right, styles.muted)}>
                {perRequest === null ? EMPTY : usd(perRequest, 4)}
              </div>
            </div>
          );
        })}

        <div className={styles.footnote}>
          {hidden > 0 && `${hidden} more server${hidden === 1 ? '' : 's'} below the top ${MAX_ROWS}. `}
          MCP attribution is a floor on agent traffic, not a census: the proxy tags a call only when
          it routed through an MCP server, so an agent driving its own tool loop over{' '}
          <span className={styles.mono}>/chat/completions</span> sits in &ldquo;everything
          else&rdquo; next to the human chat turns.
          {summary.inconsistentDays.length > 0 &&
            ` ${summary.inconsistentDays.length} day${summary.inconsistentDays.length === 1 ? '' : 's'} reported more MCP spend than gateway spend, which the subset invariant forbids — those days are clamped here and are worth raising with the proxy.`}
        </div>
      </div>
    </Card>
  );
}

/** Half-over-half movement in percentage points, or a stand-down when the spine is short. */
function TrendValue({ trend }: { trend: AgentTrafficSummary['trend'] }) {
  if (trend === null || trend.deltaPoints === null) {
    return <div className={cx(styles.statValue, styles.muted)}>{EMPTY}</div>;
  }

  const direction = Math.sign(Number(trend.deltaPoints.toFixed(1)));
  return (
    <div className={cx(styles.statValue, direction > 0 && styles.rising)}>
      {direction > 0 ? '▲' : direction < 0 ? '▼' : '·'} {trend.deltaPoints >= 0 ? '+' : '−'}
      {Math.abs(trend.deltaPoints).toFixed(1)} pts
    </div>
  );
}

/**
 * One bar per day: the *share* of that day's spend that was MCP-attributed.
 *
 * Share rather than dollars, for the same reason the reliability strip draws a
 * rate: a busy Wednesday would top a dollar strip every week and say nothing
 * about adoption. Days the gateway cost nothing draw nothing — there is no
 * share to take of zero.
 */
function ShareStrip({ days }: { days: readonly AgentTrafficDay[] }) {
  const peak = days.reduce((most, day) => Math.max(most, day.share ?? 0), 0);
  if (peak === 0) return null;

  return (
    <div className={styles.strip}>
      <div className={styles.stripBars} role="img" aria-label="Daily MCP-attributed share of spend">
        {days.map((day) => (
          <div
            key={day.date}
            className={styles.stripSlot}
            title={`${day.date} · ${share(day.share)} of ${usd(day.totalSpend, 2)} MCP-attributed`}
          >
            <div
              className={styles.stripBar}
              style={{ height: `${((day.share ?? 0) / peak) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className={styles.stripNote}>
        Daily MCP-attributed share of spend · peaks at {share(peak)}
      </div>
    </div>
  );
}
