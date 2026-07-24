/**
 * Enterprise-level billing client — the real-dollar counterpart to the
 * metrics reports in `github.ts`.
 *
 * The org-level billing endpoint 404s for this tenant, but
 * `GET /enterprises/{slug}/settings/billing/ai_credit/usage` works (validated
 * live 2026-07-24, see docs/github-integration.md). Per-user figures exist
 * only with an explicit `?user=` — the aggregate response drops usernames —
 * so one day costs one request per login. That N+1 shape is why the sync
 * covers a short trailing window and never backfills months.
 *
 * Amounts arrive as JSON floats with up to nine decimals. They are re-encoded
 * through `toFixed(9)` and parsed by `parseNano` into bigint nano-dollars, the
 * same path the CSV import takes, so both sources land byte-identical rows.
 */

import { AI_CREDIT_SKU } from '@dash/shared';
import { moduleLogger } from '../log.js';
import { parseNano } from '../lib/nano.js';
import { fetchRetry } from './reports.js';

const API_ROOT = 'https://api.github.com';

/** Parallel per-user requests. Modest: the pool is the shared core 5k/hr limit. */
const USER_CONCURRENCY = 8;

const log = moduleLogger('copilot.billing');

/**
 * Display skus the ai_credit endpoint answers → canonical BILLING_SKUS values.
 * An unmapped sku fails the sync loudly — billing_daily is the money authority
 * and must never absorb rows whose meaning is unknown.
 */
const SKU_MAP = new Map<string, string>([['Copilot AI Credits', AI_CREDIT_SKU]]);

interface UsageItem {
  product: string;
  sku: string;
  model: string;
  unitType: string;
  pricePerUnit: number;
  grossQuantity: number;
  grossAmount: number;
  discountQuantity: number;
  discountAmount: number;
  netQuantity: number;
  netAmount: number;
}

interface UsageResponse {
  usageItems?: UsageItem[];
}

/** One user's one-day usage of one model, in nano units. */
export interface UserModelUsage {
  login: string;
  sku: string;
  model: string;
  /** Gross AI-credit quantity × 1e9 — the CSV reports' `quantity` semantics. */
  creditsNano: bigint;
  grossNano: bigint;
  discountNano: bigint;
  netNano: bigint;
}

/**
 * JSON float → nano bigint. `toFixed(9)` reproduces the source decimal exactly
 * for the ≤9-fraction-digit values this API emits (≤15 significant digits fit
 * a double losslessly) and never exceeds parseNano's nine-digit limit the way
 * `String()`'s shortest-round-trip form could.
 */
function floatToNano(value: number): bigint {
  return parseNano(value.toFixed(9));
}

export class EnterpriseBillingClient {
  constructor(
    private readonly token: string,
    private readonly enterprise: string,
    private readonly apiVersion: string,
  ) {}

  /**
   * One login's AI-credit usage for one UTC day. Empty array when the user had
   * no billable usage. Throws on any non-OK response — a hole in money data
   * must fail the sync, not thin it silently.
   */
  async fetchUserDay(login: string, day: string): Promise<UserModelUsage[]> {
    const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
    const path =
      `/enterprises/${this.enterprise}/settings/billing/ai_credit/usage` +
      `?year=${year}&month=${month}&day=${dayOfMonth}&user=${encodeURIComponent(login)}`;

    const response = await fetchRetry(`${API_ROOT}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': this.apiVersion,
      },
    });

    if (response.status === 404) {
      // "User 'x' not found." — the login left the enterprise or was renamed.
      // github_users keeps logins forever (sticky active flag), so this is a
      // routine state, not a hole in money data: treat as zero usage.
      await response.text();
      log.warn({ dash: { login, day } }, 'login unknown to enterprise billing — treating as no usage');
      return [];
    }

    if (!response.ok) {
      const body = await response.text();
      log.error(
        {
          'event.outcome': 'failure',
          'url.domain': 'api.github.com',
          'url.path': path.split('?')[0],
          'http.response.status_code': response.status,
          dash: {
            login,
            day,
            rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
            body: body.slice(0, 200),
          },
        },
        'enterprise billing request rejected',
      );
      throw new Error(`GitHub ${response.status} on billing usage for ${login}: ${body.slice(0, 200)}`);
    }

    const parsed = (await response.json()) as UsageResponse;
    const usages: UserModelUsage[] = [];
    for (const item of parsed.usageItems ?? []) {
      const sku = SKU_MAP.get(item.sku);
      if (!sku) {
        throw new Error(
          `unknown billing sku "${item.sku}" for ${login} on ${day} — extend SKU_MAP deliberately`,
        );
      }
      usages.push({
        login,
        sku,
        model: item.model,
        creditsNano: floatToNano(item.grossQuantity),
        grossNano: floatToNano(item.grossAmount),
        discountNano: floatToNano(item.discountAmount),
        netNano: floatToNano(item.netAmount),
      });
    }
    return usages;
  }

  /**
   * One day's usage for every login, `USER_CONCURRENCY` requests at a time.
   * All-or-nothing: the first failed login rejects the whole day.
   */
  async fetchDay(logins: readonly string[], day: string): Promise<UserModelUsage[]> {
    const results: UserModelUsage[][] = new Array(logins.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < logins.length) {
        const index = cursor++;
        results[index] = await this.fetchUserDay(logins[index]!, day);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(USER_CONCURRENCY, logins.length) }, worker),
    );

    const flat = results.flat();
    log.debug(
      { dash: { day, logins: logins.length, usageRows: flat.length } },
      'enterprise billing day fetched',
    );
    return flat;
  }
}
