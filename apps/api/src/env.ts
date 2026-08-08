import { z } from 'zod';

/**
 * Env is parsed once at boot and fails loudly. A `github` source without
 * credentials is a misconfiguration we refuse to start with, rather than
 * discover on the first refresh.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().url(),
    /**
     * Postgres schema the app's tables live in. Applied as the connection
     * `search_path`, so migrations and queries never name it — the migration
     * SQL stays schema-agnostic. Restricted to a plain identifier because the
     * value is interpolated into `CREATE SCHEMA` (see db/migrate.ts).
     */
    DB_SCHEMA: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a plain Postgres identifier')
      .default('public'),
    /**
     * Log verbosity for the ECS JSON logger (see log.ts). Unset (or empty, as
     * a commented-out .env line leaves it) falls back to `info` in production
     * and `debug` everywhere else.
     */
    LOG_LEVEL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
    ),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    COPILOT_SOURCE: z.enum(['mock', 'github']).default('mock'),
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_ORG: z.string().optional(),
    /** Reports API needs a recent version; overridable if GitHub bumps it. */
    GITHUB_API_VERSION: z.string().default('2026-03-10'),
    /**
     * Enterprise billing sync (real dollars). The org-level billing endpoint
     * 404s for this tenant, but the enterprise-level `ai_credit/usage` endpoint
     * works — see docs/github-integration.md. Setting the enterprise slug turns
     * the daily billing sync on; leaving it unset keeps billing CSV-import-only.
     */
    GITHUB_ENTERPRISE: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional(),
    ),
    /**
     * Token for the enterprise billing endpoints. Falls back to GITHUB_TOKEN.
     * Kept separate because billing needs enterprise scope while the org token
     * needs SAML SSO authorization — one PAT rarely has both.
     */
    GITHUB_BILLING_TOKEN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional(),
    ),
    /**
     * Token for the org members GraphQL pull. Falls back to GITHUB_TOKEN.
     * Kept separate for the same reason billing is, and pulling the opposite
     * way: this one must carry `read:org` *and* be authorized for the org's
     * SAML SSO, which the enterprise billing PAT usually is not.
     *
     * Unset simply disables the sync (the scheduler skips it, the route
     * answers 503) rather than refusing boot — JIRA behaves the same way; only
     * COPILOT_SOURCE=github is strict.
     */
    GITHUB_MEMBERS_TOKEN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional(),
    ),
    /**
     * The one shared admin secret that unlocks the dashboard. Defaulted so a
     * fresh clone still boots; override it anywhere real. This is the entire
     * auth story — see auth/session.ts.
     */
    STATIC_LOGIN_TOKEN: z.string().min(1).default('let-me-in'),
    /**
     * Bearer token OTLP exporters must present on /v1/*. Unset means the
     * ingest is open — acceptable on localhost, not beyond it.
     */
    OTLP_INGEST_TOKEN: z.string().optional(),
    /**
     * JIRA Insight (identity sync). Both optional — `POST /api/jira/sync`
     * answers 503 while they are unset (mock source excepted, which generates
     * people locally). Empty strings, as commented-out .env lines leave them,
     * count as unset.
     */
    JIRA_BASE_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().url().optional(),
    ),
    JIRA_TOKEN: z.preprocess((value) => (value === '' ? undefined : value), z.string().optional()),
  })
  .refine((env) => env.COPILOT_SOURCE !== 'github' || (env.GITHUB_TOKEN && env.GITHUB_ORG), {
    message: 'COPILOT_SOURCE=github requires GITHUB_TOKEN and GITHUB_ORG to be set',
    path: ['COPILOT_SOURCE'],
  })
  .refine((env) => !env.GITHUB_ENTERPRISE || env.GITHUB_BILLING_TOKEN || env.GITHUB_TOKEN, {
    message: 'GITHUB_ENTERPRISE requires GITHUB_BILLING_TOKEN (or GITHUB_TOKEN) to be set',
    path: ['GITHUB_ENTERPRISE'],
  })
  .refine((env) => Boolean(env.JIRA_BASE_URL) === Boolean(env.JIRA_TOKEN), {
    message: 'JIRA_BASE_URL and JIRA_TOKEN must be set together (or both left unset)',
    path: ['JIRA_BASE_URL'],
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

export const env = load();
