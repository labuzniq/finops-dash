import type { ModelUsage, RangeDays } from '@dash/shared';
import { count, EMPTY, optionalPercent } from '../lib/format.js';
import { Card } from './Card.js';
import styles from './ModelTable.module.css';

/**
 * Per-model usage — GitHub's `totals_by_language_model`, aggregated over the
 * selected range. Shows which models the org's Copilot activity runs on
 * (claude-sonnet-5, gpt-5.3-codex, …), busiest first.
 */

interface ModelTableProps {
  models: readonly ModelUsage[];
  range: RangeDays;
}

export function ModelTable({ models, range }: ModelTableProps) {
  const totalGenerations = models.reduce((sum, m) => sum + m.generations, 0);

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Per-model usage</div>
        <div className={styles.sub}>code generations · last {range}d</div>
      </div>

      <div className={`${styles.columns} ${styles.headerStrip}`}>
        <div>MODEL</div>
        <div className={styles.right}>GENERATIONS</div>
        <div className={styles.right}>ACCEPT</div>
        <div className={styles.right}>LOC ADDED</div>
        <div>SHARE</div>
      </div>

      {models.length === 0 ? (
        <div className={styles.empty}>No model activity in this range yet.</div>
      ) : (
        models.map((model) => {
          const share = totalGenerations === 0 ? 0 : (model.generations / totalGenerations) * 100;
          return (
            <div key={model.model} className={`${styles.columns} ${styles.row}`}>
              <div className={styles.model}>{model.model}</div>
              <div className={styles.right}>{count(model.generations)}</div>
              <div className={styles.right}>{optionalPercent(model.acceptanceRate)}</div>
              <div className={styles.right}>{model.locAdded ? count(model.locAdded) : EMPTY}</div>
              <div className={styles.shareCell}>
                <div className={styles.bar}>
                  <div className={styles.barFill} style={{ width: `${share}%` }} />
                </div>
                <span className={styles.shareLabel}>{Math.round(share)}%</span>
              </div>
            </div>
          );
        })
      )}
    </Card>
  );
}
