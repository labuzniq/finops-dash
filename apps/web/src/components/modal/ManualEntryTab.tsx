import { useId } from 'react';
import { PLAN_PRICE } from '@dash/shared';
import type { Plan } from '@dash/shared';
import styles from './tabs.module.css';

/** One manually-entered seat row. Strings so inputs stay controlled. */
export interface ManualRow {
  user_login: string;
  plan: Plan;
  ai_credits_used: string;
  last_activity_at: string;
}

interface ManualEntryTabProps {
  row: ManualRow;
  onChange: (row: ManualRow) => void;
}

/**
 * Single-seat entry. Posts through the same import endpoint as CSV upload —
 * `user_login` is required, everything else is optional and upserts by login.
 */
export function ManualEntryTab({ row, onChange }: ManualEntryTabProps) {
  const loginId = useId();
  const planId = useId();
  const requestsId = useId();
  const activityId = useId();

  const set = <K extends keyof ManualRow>(key: K, value: ManualRow[K]): void =>
    onChange({ ...row, [key]: value });

  return (
    <div className={styles.form}>
      <div>
        <label className={styles.label} htmlFor={loginId}>
          User login <span className={styles.req}>*</span>
        </label>
        <input
          id={loginId}
          className={styles.input}
          placeholder="e.g. akovacs"
          value={row.user_login}
          onChange={(event) => set('user_login', event.target.value)}
        />
      </div>

      <div>
        <label className={styles.label} htmlFor={planId}>
          Plan
        </label>
        <select
          id={planId}
          className={styles.input}
          value={row.plan}
          onChange={(event) => set('plan', event.target.value as Plan)}
        >
          <option value="Business">Business — ${PLAN_PRICE.Business}/mo</option>
          <option value="Enterprise">Enterprise — ${PLAN_PRICE.Enterprise}/mo</option>
        </select>
      </div>

      <div>
        <label className={styles.label} htmlFor={requestsId}>
          AI credits used (28d)
        </label>
        <input
          id={requestsId}
          className={styles.input}
          type="number"
          placeholder="0"
          value={row.ai_credits_used}
          onChange={(event) => set('ai_credits_used', event.target.value)}
        />
      </div>

      <div>
        <label className={styles.label} htmlFor={activityId}>
          Last activity
        </label>
        <input
          id={activityId}
          className={styles.input}
          type="date"
          value={row.last_activity_at}
          onChange={(event) => set('last_activity_at', event.target.value)}
        />
      </div>
    </div>
  );
}
