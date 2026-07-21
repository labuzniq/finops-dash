/**
 * Exports the seeded mock dataset to CSV files under data/mock/ — the roster,
 * the daily usage series, and the spend inputs shaped like the real GitHub
 * exports. The database is never touched; the app boots empty and these files
 * are how a demo database gets populated:
 *
 *   • seats.csv                — POST /api/import (or the UI's Add data → Import)
 *   • org_daily.csv, model_daily.csv — `psql \copy`, see data/mock/README.md
 *   • AIUsageReport_1.csv      — POST /api/import/billing (per-model AI-credit stats)
 *   • AIUsageReport_2.csv      — POST /api/import/billing (money authority)
 *   • user-export.csv          — POST /api/import/users (login → saml_name_id)
 *
 * `pnpm --filter @dash/api mock:export [days]` regenerates them; activity
 * dates are anchored to the day of export. jira_people has no CSV — run
 * `POST /api/jira/sync` with the mock source and it generates the same people.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MockCopilotClient, buildMockBillingReport, buildMockIdentity } from './copilot/mock.js';
import { formatNano } from './lib/nano.js';
import { parseBillingReport, parseUserExport } from './services/billing-import.js';

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
const billing = buildMockBillingReport();
const identity = buildMockIdentity();

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
  // The spend inputs, shaped like the real GitHub exports so the billing
  // importer takes them as-is. Report 1 is detected by its `model` column,
  // Report 2 by `workflow_path` (always empty — the column only marks the type).
  'AIUsageReport_1.csv': csv(
    ['date', 'username', 'sku', 'model', 'quantity', 'gross_amount', 'discount_amount', 'net_amount'],
    billing.modelRows.map((r) => [
      r.date,
      r.login,
      'copilot_ai_credit',
      r.model,
      formatNano(r.creditsNano),
      formatNano(r.grossNano),
      formatNano(r.discountNano),
      formatNano(r.netNano),
    ]),
  ),
  'AIUsageReport_2.csv': csv(
    ['date', 'username', 'sku', 'quantity', 'gross_amount', 'discount_amount', 'net_amount', 'workflow_path'],
    billing.billingRows.map((r) => [
      r.date,
      r.login,
      r.sku,
      formatNano(r.quantityNano),
      formatNano(r.grossNano),
      formatNano(r.discountNano),
      formatNano(r.netNano),
      null,
    ]),
  ),
  'user-export.csv': csv(
    ['login', 'saml_name_id'],
    identity.users.map((u) => [u.login, u.samlNameId]),
  ),
};

// Round-trip the generated spend files through the real parsers — a header or
// money-format drift fails the export instead of the next import.
const report1 = parseBillingReport(files['AIUsageReport_1.csv']!);
const report2 = parseBillingReport(files['AIUsageReport_2.csv']!);
const users = parseUserExport(files['user-export.csv']!);
if (report1.reportType !== 'model' || report2.reportType !== 'billing') {
  throw new Error('mock billing CSVs failed report-type detection');
}
console.log(
  `self-check: report1 ${report1.modelRows.length} rows, report2 ${report2.billingRows.length} rows, ` +
    `users ${users.length} rows (people synced on demand: ${identity.people.length})`,
);

for (const [name, content] of Object.entries(files)) {
  writeFileSync(`${outDir}/${name}`, content);
  console.log(`${outDir}/${name} (${content.split('\n').length - 2} rows)`);
}
