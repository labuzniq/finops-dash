import { useMemo } from 'react';
import type { CopilotSeat, DateRange, OrgDailyPoint, UsageHistory } from '@dash/shared';
import { compactCount, count, percent } from '../../lib/format.js';
import {
  acceptanceRateSeries,
  adoptionSeries,
  buildMultiSeriesGeometry,
  dateAxis,
  filteredActivity,
  orgSeries,
  pivotBreakdown,
  prAllZero,
  sliceByRange,
  teamStats,
} from '../../lib/metrics/usage.js';
import type {
  FilteredActivityDay,
  MultiSeriesGeometry,
  SeriesFormat,
} from '../../lib/metrics/usage.js';
import { Card } from '../Card.js';
import { TeamsPanel } from './TeamsPanel.js';
import { TrendChart } from './TrendChart.js';
import type { TrendVariant } from './TrendChart.js';
import styles from './UsageSections.module.css';

/**
 * The org-usage half of the page: every dimension the daily reports break
 * down, all sliced by the global range. Related metrics share one card behind
 * a toggle — always a single metric visible, never mixed kinds in one plot.
 *
 * With seat filters active, the activity section switches from the org
 * aggregates to sums of the filtered seats' per-user daily rows. The
 * breakdown, cohort, adoption, and PR series stay org-wide — GitHub exposes
 * no per-seat data for those — and say so while a filter is on.
 */

const COUNTS: SeriesFormat = { axis: compactCount, tooltip: count };
const PERCENTS: SeriesFormat = { axis: percent, tooltip: percent };

interface UsageSectionsProps {
  usage: UsageHistory | undefined;
  /** The globally filtered seat list — feeds the (roster-based) teams panel. */
  seats: readonly CopilotSeat[];
  /** Logins of the filtered seats, or null when no seat filter is active. */
  filteredLogins: ReadonlySet<string> | null;
  range: DateRange;
  /** Selected metric per merged chart, keyed by the chart's section key. */
  usageMetric: Record<string, string>;
  onMetricChange: (section: string, metric: string) => void;
}

/** A card: either one fixed chart or a set of toggled metric variants. */
interface ChartSpec {
  key: string;
  single?: { title: string; geometry: MultiSeriesGeometry; subtitle?: string };
  variants?: TrendVariant[];
}

interface Section {
  heading: string;
  note?: string;
  charts: ChartSpec[];
}

function buildSections(
  usage: UsageHistory,
  range: DateRange,
  filtered: FilteredActivityDay[] | null,
): Section[] {
  const org = sliceByRange(usage.orgDaily, range);
  const breakdowns = sliceByRange(usage.breakdowns, range);
  const adoption = sliceByRange(usage.adoption, range);
  const dates = dateAxis(org);

  // The activity charts read from whichever series the filter state selects —
  // both row shapes carry the same seven daily metrics.
  const activity: ReadonlyArray<FilteredActivityDay | OrgDailyPoint> = filtered ?? org;
  /** Appended to sections that only exist as org aggregates while a filter is on. */
  const orgOnlyNote = filtered
    ? ' Org-wide — GitHub has no per-seat data for these series, so seat filters don’t apply.'
    : '';

  const counts = (input: Parameters<typeof buildMultiSeriesGeometry>[0]): MultiSeriesGeometry =>
    buildMultiSeriesGeometry(input, COUNTS);

  const breakdown = (
    dimension: 'ide' | 'language' | 'feature' | 'model',
    metric: Parameters<typeof pivotBreakdown>[2],
  ): MultiSeriesGeometry => counts(pivotBreakdown(breakdowns, dimension, metric, dates));

  // One toggled card per dimension: the same four metrics everywhere.
  const perDimension = (
    dimension: 'ide' | 'language' | 'feature' | 'model',
    label: string,
  ): Section => ({
    heading: `By ${label}`,
    ...(orgOnlyNote ? { note: orgOnlyNote.trim() } : {}),
    charts: [
      {
        key: dimension,
        variants: [
          {
            key: 'generations',
            label: 'Generations',
            title: `Generations by ${label}`,
            geometry: breakdown(dimension, 'generations'),
          },
          {
            key: 'acceptances',
            label: 'Acceptances',
            title: `Acceptances by ${label}`,
            geometry: breakdown(dimension, 'acceptances'),
          },
          {
            key: 'locAdded',
            label: 'Lines added',
            title: `Lines added by ${label}`,
            geometry: breakdown(dimension, 'locAdded'),
          },
          {
            key: 'interactions',
            label: 'Interactions',
            title: `Interactions by ${label}`,
            geometry: breakdown(dimension, 'interactions'),
          },
        ],
      },
    ],
  });

  const sections: Section[] = [
    {
      heading: filtered ? 'Filtered activity' : 'Organization activity',
      note: filtered
        ? 'Summed per day across the seats matching the filters — the date range applies too.'
        : 'Organization-wide series from the daily Copilot reports — seat filters narrow these to the matching seats.',
      charts: [
        {
          key: 'activeUsers',
          single: {
            title: 'Active users',
            ...(filtered ? { subtitle: 'Filtered seats with any activity that day' } : {}),
            geometry: filtered
              ? counts(orgSeries(filtered, [{ field: 'activeUsers', name: 'Daily' }]))
              : counts(
                  orgSeries(org, [
                    { field: 'dailyActiveUsers', name: 'Daily' },
                    { field: 'weeklyActiveUsers', name: 'Weekly' },
                    { field: 'monthlyActiveUsers', name: 'Monthly' },
                  ]),
                ),
          },
        },
        {
          key: 'orgDailyActivity',
          variants: [
            {
              key: 'generations',
              label: 'Generations',
              title: 'Code generations',
              geometry: counts(orgSeries(activity, [{ field: 'generations', name: 'Generations' }])),
            },
            {
              key: 'acceptances',
              label: 'Acceptances',
              title: 'Code acceptances',
              geometry: counts(orgSeries(activity, [{ field: 'acceptances', name: 'Acceptances' }])),
            },
            {
              key: 'interactions',
              label: 'Interactions',
              title: 'Interactions',
              subtitle: 'User-initiated chat and agent interactions per day',
              geometry: counts(orgSeries(activity, [{ field: 'interactions', name: 'Interactions' }])),
            },
          ],
        },
        {
          key: 'acceptanceRate',
          single: {
            title: 'Acceptance rate',
            subtitle: 'Acceptances ÷ generations per day',
            geometry: buildMultiSeriesGeometry(acceptanceRateSeries(activity), PERCENTS),
          },
        },
        {
          key: 'orgLoc',
          variants: [
            {
              key: 'written',
              label: 'Written',
              title: 'Lines of code written',
              geometry: counts(
                orgSeries(activity, [
                  { field: 'locAdded', name: 'Added' },
                  { field: 'locDeleted', name: 'Deleted' },
                ]),
              ),
            },
            {
              key: 'suggested',
              label: 'Suggested',
              title: 'Lines of code suggested',
              geometry: counts(
                orgSeries(activity, [
                  { field: 'locSuggestedAdd', name: 'Suggested add' },
                  { field: 'locSuggestedDelete', name: 'Suggested delete' },
                ]),
              ),
            },
          ],
        },
      ],
    },
    {
      heading: 'Engaged cohorts',
      ...(orgOnlyNote ? { note: orgOnlyNote.trim() } : {}),
      charts: [
        {
          key: 'chatAgentUsers',
          single: {
            title: 'Chat and agent users',
            subtitle: 'Monthly active users of each capability',
            geometry: counts(
              orgSeries(org, [
                { field: 'chatMau', name: 'Chat' },
                { field: 'agentMau', name: 'Agent' },
              ]),
            ),
          },
        },
        {
          key: 'codeReviewUsers',
          single: {
            title: 'Code review users',
            geometry: counts(
              orgSeries(org, [
                { field: 'codeReviewDau', name: 'Daily' },
                { field: 'codeReviewWau', name: 'Weekly' },
                { field: 'codeReviewMau', name: 'Monthly' },
                { field: 'codeReviewPassiveMau', name: 'Passive (monthly)' },
              ]),
            ),
          },
        },
        {
          key: 'cloudAgentUsers',
          single: {
            title: 'Cloud agent users',
            geometry: counts(
              orgSeries(org, [
                { field: 'cloudAgentDau', name: 'Daily' },
                { field: 'cloudAgentWau', name: 'Weekly' },
                { field: 'cloudAgentMau', name: 'Monthly' },
              ]),
            ),
          },
        },
      ],
    },
    perDimension('ide', 'IDE'),
    perDimension('language', 'language'),
    perDimension('feature', 'feature'),
    perDimension('model', 'model'),
    {
      heading: 'Adoption phases',
      note: `GitHub's AI-adoption cohorts — how many users sit in each phase.${orgOnlyNote}`,
      charts: [
        {
          key: 'adoption',
          single: {
            title: 'Engaged users per phase',
            geometry: counts(adoptionSeries(adoption)),
          },
        },
      ],
    },
  ];

  if (!prAllZero(org)) {
    sections.push({
      heading: 'Pull requests',
      ...(orgOnlyNote ? { note: orgOnlyNote.trim() } : {}),
      charts: [
        {
          key: 'prCreatedMerged',
          single: {
            title: 'Pull requests created and merged',
            geometry: counts(
              orgSeries(org, [
                { field: 'prCreated', name: 'Created' },
                { field: 'prMerged', name: 'Merged' },
              ]),
            ),
          },
        },
        {
          key: 'prCopilot',
          single: {
            title: 'Copilot involvement',
            geometry: counts(
              orgSeries(org, [
                { field: 'prCreatedByCopilot', name: 'Created by Copilot' },
                { field: 'prMergedCreatedByCopilot', name: 'Merged (Copilot-created)' },
                { field: 'prReviewedByCopilot', name: 'Reviewed by Copilot' },
              ]),
            ),
          },
        },
        {
          key: 'prSuggestions',
          single: {
            title: 'Review suggestions',
            geometry: counts(
              orgSeries(org, [
                { field: 'prCopilotSuggestions', name: 'Suggested' },
                { field: 'prCopilotAppliedSuggestions', name: 'Applied' },
              ]),
            ),
          },
        },
      ],
    });
  }

  return sections;
}

export function UsageSections({
  usage,
  seats,
  filteredLogins,
  range,
  usageMetric,
  onMetricChange,
}: UsageSectionsProps) {
  // The filtered activity rides the org window's date axis, so both chart
  // modes cover exactly the same days.
  const filtered = useMemo(() => {
    if (usage === undefined || filteredLogins === null) return null;
    return filteredActivity(
      sliceByRange(usage.userDaily, range),
      filteredLogins,
      dateAxis(sliceByRange(usage.orgDaily, range)),
    );
  }, [usage, range, filteredLogins]);

  const sections = useMemo(
    () => (usage === undefined ? [] : buildSections(usage, range, filtered)),
    [usage, range, filtered],
  );
  const teams = useMemo(() => teamStats(seats), [seats]);
  const showPrEmptyState = useMemo(
    () => usage !== undefined && prAllZero(sliceByRange(usage.orgDaily, range)),
    [usage, range],
  );

  if (usage === undefined) return null;

  return (
    <>
      {sections.map((section) => (
        <section key={section.heading} className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.heading}>{section.heading}</h2>
            {section.note && <div className={styles.note}>{section.note}</div>}
          </div>
          <div className={styles.grid}>
            {section.charts.map((chart) =>
              chart.variants !== undefined ? (
                <TrendChart
                  key={chart.key}
                  variants={chart.variants}
                  {...(usageMetric[chart.key] !== undefined
                    ? { activeVariant: usageMetric[chart.key] }
                    : {})}
                  onVariantChange={(metric) => onMetricChange(chart.key, metric)}
                />
              ) : chart.single !== undefined ? (
                <TrendChart
                  key={chart.key}
                  title={chart.single.title}
                  geometry={chart.single.geometry}
                  {...(chart.single.subtitle !== undefined
                    ? { subtitle: chart.single.subtitle }
                    : {})}
                />
              ) : null,
            )}
          </div>
        </section>
      ))}

      {showPrEmptyState && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.heading}>Pull requests</h2>
          </div>
          <Card>
            <div className={styles.prEmpty}>
              No pull request activity yet — these charts light up once Copilot code review or
              the coding agent is used on pull requests.
            </div>
          </Card>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.heading}>Teams</h2>
        </div>
        <TeamsPanel stats={teams} />
      </section>
    </>
  );
}
