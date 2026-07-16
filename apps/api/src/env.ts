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
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    COPILOT_SOURCE: z.enum(['mock', 'github']).default('mock'),
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_ORG: z.string().optional(),
    /** Reports API needs a recent version; overridable if GitHub bumps it. */
    GITHUB_API_VERSION: z.string().default('2026-03-10'),
    /**
     * The one shared admin secret that unlocks the dashboard. Defaulted so a
     * fresh clone still boots; override it anywhere real. This is the entire
     * auth story — see auth/session.ts.
     */
    STATIC_LOGIN_TOKEN: z.string().min(1).default('let-me-in'),
  })
  .refine((env) => env.COPILOT_SOURCE !== 'github' || (env.GITHUB_TOKEN && env.GITHUB_ORG), {
    message: 'COPILOT_SOURCE=github requires GITHUB_TOKEN and GITHUB_ORG to be set',
    path: ['COPILOT_SOURCE'],
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
