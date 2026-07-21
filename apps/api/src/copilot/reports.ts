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
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

const log = moduleLogger('copilot.github.api');

/** Presigned shard links carry auth in the query string — never log it. */
function safeUrl(url: string): string {
  return url.split('?')[0] ?? url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch with retry on network errors and 5xx/429. 4xx (including 204 handled by
 * callers) are returned as-is — they are not transient.
 */
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);
      if ((response.status >= 500 || response.status === 429) && attempt < MAX_ATTEMPTS) {
        log.warn(
          {
            'url.full': safeUrl(url),
            'http.response.status_code': response.status,
            dash: { attempt, maxAttempts: MAX_ATTEMPTS },
          },
          'transient github response — retrying',
        );
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        log.warn(
          { 'url.full': safeUrl(url), err: error, dash: { attempt, maxAttempts: MAX_ATTEMPTS } },
          'github request failed — retrying',
        );
        await sleep(RETRY_BASE_MS * attempt);
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
  // Presigned URL carries its own auth in the query string — no headers.
  const response = await fetchRetry(link);
  if (!response.ok) {
    throw new Error(`report shard download failed: ${response.status}`);
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
