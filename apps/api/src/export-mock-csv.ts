/**
 * Exports the seeded mock dataset to CSV files under data/mock/ — the roster
 * plus the three daily series. The database is never touched; the app boots
 * empty and these files are how a demo database gets populated:
 *
 *   • seats.csv          — POST /api/import (or the UI's Add data → Import)
 *   • org_daily.csv, model_daily.csv, spend_daily.csv — `psql \copy`, see
 *     data/mock/README.md
 *
 * `pnpm --filter @dash/api mock:export [days]` regenerates them; activity
 * dates are anchored to the day of export.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MockCopilotClient } from './copilot/mock.js';
import { deriveSpend } from './services/refresh.js';

const days = Number(process.argv[2] ?? 90);
const outDir = fileURLToPath(new URL('../../../data/mock', import.meta.url));

type Cell = string | number | boolean | Date | null;

/** RFC 4180: quote when needed, double embedded quotes, null → empty field. */
function cell(value: Cell): string {
  if (value === null) return '';
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(headers: readonly string[], rows: ReadonlyArray<readonly Cell[]>): string {
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\n') + '\n';
}

const snapshot = await new MockCopilotClient().fetchSnapshot(days);
const spend = deriveSpend(snapshot.seats, snapshot.orgDaily);

mkdirSync(outDir, { recursive: true });

const files: Record<string, string> = {
  // Headers match the /api/import contract (docs/import-format.md).
  'seats.csv': csv(
    [
      'user_login',
      'name',
      'plan',
      'editor',
      'language',
      'last_activity_at',
      'premium_requests_28d',
      'acceptance_rate',
      'used_agent',
      'used_chat',
      'top_model',
    ],
    snapshot.seats.map((s) => [
      s.login,
      s.name,
      s.plan,
      s.editor,
      s.language,
      s.lastActivityAt,
      s.premiumRequests28d,
      s.acceptanceRate,
      s.usedAgent,
      s.usedChat,
      s.topModel,
    ]),
  ),
  // The daily series use the Postgres column names so `psql \copy` loads them as-is.
  'org_daily.csv': csv(
    [
      'date',
      'daily_active_users',
      'weekly_active_users',
      'monthly_active_users',
      'interactions',
      'generations',
      'acceptances',
      'loc_added',
      'loc_deleted',
    ],
    snapshot.orgDaily.map((d) => [
      d.date,
      d.dailyActiveUsers,
      d.weeklyActiveUsers,
      d.monthlyActiveUsers,
      d.interactions,
      d.generations,
      d.acceptances,
      d.locAdded,
      d.locDeleted,
    ]),
  ),
  'model_daily.csv': csv(
    ['date', 'model', 'generations', 'acceptances', 'loc_added', 'loc_deleted'],
    snapshot.modelDaily.map((m) => [
      m.date,
      m.model,
      m.generations,
      m.acceptances,
      m.locAdded,
      m.locDeleted,
    ]),
  ),
  'spend_daily.csv': csv(
    ['date', 'license_cents', 'premium_overage_cents'],
    spend.map((p) => [p.date, p.licenseCents, p.premiumOverageCents]),
  ),
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(`${outDir}/${name}`, content);
  console.log(`${outDir}/${name} (${content.split('\n').length - 2} rows)`);
}
