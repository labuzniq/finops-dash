import { useState } from 'react';
import { cx } from '../../lib/cx.js';
import { useTheme } from '../../hooks/useTheme.js';
import styles from './LoginScreen.module.css';

const ACCENT_CLASS = 'acc-blurple';

interface LoginScreenProps {
  /** Submits the shared token; rejects with a message on a bad token. */
  onSubmit: (token: string) => Promise<void>;
}

export function LoginScreen({ onSubmit }: LoginScreenProps) {
  const { isDark } = useTheme();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!token || submitting) return;
    setSubmitting(true);
    setError(null);
    void onSubmit(token)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Login failed');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className={cx('theme', ACCENT_CLASS, isDark && 'dark', styles.screen)}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <p className={styles.brand}>RBCZ FinOps</p>
        <h1 className={styles.title}>Copilot spend</h1>
        <p className={styles.subtitle}>Enter the access token to continue.</p>

        <label className={styles.field} htmlFor="login-token">
          Access token
        </label>
        <input
          id="login-token"
          className={styles.input}
          type="password"
          autoComplete="off"
          autoFocus
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />

        {error && <p className={styles.error}>{error}</p>}

        <button className={styles.button} type="submit" disabled={!token || submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
