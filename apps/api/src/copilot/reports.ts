/**
 * Thin transport for GitHub's Copilot APIs.
 *
 * The `.../metrics/reports/...` endpoints don't return data — they return an
 * envelope of short-lived presigned links to NDJSON on copilot-reports.github.com.
 * This module hides that indirection: `fetchReport` resolves the envelope,
 * downloads every shard, and yields parsed rows. See docs/github-integration.md.
 */

import { moduleLogger } from '../log.js';

const API_ROOT = 'https://api.github.com';

/** Network to api.github.com is occasionally flaky; retry transient failures. */
const RETRY_DELAYS_MS = [500, 1000];
/**
 * The presigned shard host sits behind a WAF that rate-limits bursts with 403,
 * and a block can persist for around a minute — escalate far past the default
 * schedule. The links stay valid ~1h, so waiting this long is safe.
 */
const FORBIDDEN_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

const log = moduleLogger('copilot.github.api');

/** Presigned shard links carry auth in the query string — never log it. */
function safeUrl(url: string): string {
  return url.split('?')[0] ?? url;
}

/**
 * Network failures from fetch/undici bury the actionable detail (ECONNREFUSED,
 * UND_ERR_CONNECT_TIMEOUT, self-signed-certificate errors from TLS-intercepting
 * proxies, …) in `error.code` and a nested `cause` chain. Surface both, so a
 * corporate-proxy failure is diagnosable from the log line alone.
 */
function errorClues(error: unknown): { code: string | null; causeChain: string[] } {
  let code: string | null = null;
  const causeChain: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    if (code === null && 'code' in current && typeof current.code === 'string') {
      code = current.code;
    }
    if (current !== error) causeChain.push(current.message);
    current = current.cause;
  }
  return { code, causeChain };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch with retry on network errors and 5xx/429. 4xx (including 204 handled by
 * callers) are returned as-is — they are not transient. Exception: callers that
 * talk to the presigned shard host pass `retryForbidden`, because its WAF
 * answers 403 for throttling, not auth (see downloadNdjson).
 */
async function fetchRetry(
  url: string,
  init?: RequestInit,
  opts?: { retryForbidden?: boolean },
): Promise<Response> {
  const delays = opts?.retryForbidden ? FORBIDDEN_RETRY_DELAYS_MS : RETRY_DELAYS_MS;
  const maxAttempts = delays.length + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.debug(
      {
        'http.request.method': init?.method ?? 'GET',
        'url.full': safeUrl(url),
        dash: { attempt, maxAttempts },
      },
      'github request',
    );
    try {
      const response = await fetch(url, init);
      const transient =
        response.status >= 500 ||
        response.status === 429 ||
        (response.status === 403 && opts?.retryForbidden === true);
      if (transient && attempt < maxAttempts) {
        log.warn(
          {
            'url.full': safeUrl(url),
            'http.response.status_code': response.status,
            dash: { attempt, maxAttempts },
          },
          'transient github response — retrying',
        );
        await sleep(delays[attempt - 1]!);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      const clues = errorClues(error);
      if (attempt < maxAttempts) {
        log.warn(
          { 'url.full': safeUrl(url), err: error, dash: { attempt, maxAttempts, ...clues } },
          'github request failed — retrying',
        );
        await sleep(delays[attempt - 1]!);
      } else {
        log.error(
          {
            'event.outcome': 'failure',
            'url.full': safeUrl(url),
            err: error,
            dash: { attempts: maxAttempts, ...clues },
          },
          'github request failed on every attempt — likely proxy/egress/TLS if the code is a connect or certificate error',
        );
      }
    }
  }
  throw lastError;
}

export interface ReportEnvelope {
  download_links?: string[];
  /** Present on daily reports. */
  report_day?: string;
  /** Present on 28-day reports. */
  report_start_day?: string;
  report_end_day?: string;
}

export interface ReportResult<T> {
  envelope: ReportEnvelope;
  rows: T[];
}

/**
 * A presigned shard answered an error status through every retry. Carries the
 * status so callers can tell a persistent WAF block (403 — the WAF sometimes
 * false-positives on a specific signature, and the envelope serves that same
 * signature until it expires ~1h later) from anything else.
 */
export class ShardDownloadError extends Error {
  constructor(
    readonly status: number,
    readonly host: string,
  ) {
    super(`report shard download failed: ${status} (host ${host})`);
    this.name = 'ShardDownloadError';
  }
}

export class GithubApi {
  constructor(
    private readonly token: string,
    private readonly org: string,
    private readonly apiVersion: string,
  ) {}

  get orgSlug(): string {
    return this.org;
  }

  /** Authenticated GET against api.github.com, returning parsed JSON. */
  async getJson<T>(path: string): Promise<T> {
    const response = await fetchRetry(`${API_ROOT}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': this.apiVersion,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      log.error(
        {
          'event.outcome': 'failure',
          'url.domain': 'api.github.com',
          'url.path': path,
          'http.response.status_code': response.status,
          dash: {
            rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
            githubSso: response.headers.get('x-github-sso'),
            body: body.slice(0, 200),
          },
        },
        'github api request rejected',
      );
      throw new Error(`GitHub ${response.status} on ${path}: ${describe(response, body)}`);
    }

    log.trace(
      { 'url.path': path, 'http.response.status_code': response.status },
      'github api response',
    );
    return (await response.json()) as T;
  }

  /**
   * Resolve a report endpoint and download all shards.
   *
   * Returns `null` when GitHub answers `204 No Content` — the report does not
   * exist for that day (before the org's history floor, or not yet generated).
   * Callers treat that as "skip", not an error.
   */
  async fetchReport<T>(reportPath: string): Promise<ReportResult<T> | null> {
    const url = `${API_ROOT}/orgs/${this.org}/copilot/metrics/reports/${reportPath}`;
    const response = await fetchRetry(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': this.apiVersion,
      },
    });

    if (response.status === 204) {
      log.trace({ dash: { report: reportPath } }, 'report not available (204) — skipping');
      return null;
    }

    if (!response.ok) {
      const body = await response.text();
      log.error(
        {
          'event.outcome': 'failure',
          'url.domain': 'api.github.com',
          'url.path': `/orgs/${this.org}/copilot/metrics/reports/${safeUrl(reportPath)}`,
          'http.response.status_code': response.status,
          dash: {
            rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
            githubSso: response.headers.get('x-github-sso'),
            body: body.slice(0, 200),
          },
        },
        'github report request rejected',
      );
      throw new Error(
        `GitHub ${response.status} on reports/${reportPath}: ${describe(response, body)}`,
      );
    }

    const envelope = (await response.json()) as ReportEnvelope;
    const links = envelope.download_links ?? [];

    // download_links is an array on purpose — large reports are sharded
    // (part-00366-…). Download and parse every shard or the tail is lost.
    const rows: T[] = [];
    for (const link of links) {
      rows.push(...(await downloadNdjson<T>(link)));
    }

    log.debug(
      { dash: { report: reportPath, shards: links.length, rows: rows.length } },
      'report downloaded',
    );
    return { envelope, rows };
  }
}

/** Fetch one presigned NDJSON shard and parse its non-empty lines. */
async function downloadNdjson<T>(link: string): Promise<T[]> {
  // Shards live on a different host than api.github.com — a corporate proxy
  // that allowlists only api.github.com fails exactly here, so name the host.
  const host = new URL(link).hostname;
  // Presigned URL carries its own auth in the query string — no headers.
  // The shard host fronts Azure and its WAF sporadically rejects bursty
  // downloads with 403 ("Request blocked by WAF") — transient, so retry it;
  // the link outlives the retries (~1h validity, see docs/github-integration.md).
  const response = await fetchRetry(link, undefined, { retryForbidden: true });
  if (!response.ok) {
    log.error(
      {
        'event.outcome': 'failure',
        'url.domain': host,
        'http.response.status_code': response.status,
      },
      'report shard download rejected — check egress to this host',
    );
    throw new ShardDownloadError(response.status, host);
  }

  const text = await response.text();
  const rows: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed) as T);
  }
  return rows;
}

/** GitHub 403s for SSO/IP-allowlist reasons carry a useful header; surface it. */
function describe(response: Response, body: string): string {
  const sso = response.headers.get('x-github-sso');
  const hint = sso ? ` (x-github-sso: ${sso})` : '';
  return `${body.slice(0, 200)}${hint}`;
}
