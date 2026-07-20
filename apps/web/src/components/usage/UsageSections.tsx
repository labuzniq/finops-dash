import { useMemo } from 'react';
import type { CopilotSeat, DateRange, UsageHistory } from '@dash/shared';
import { compactCount, count, percent } from '../../lib/format.js';
import {
  acceptanceRateSeries,
  adoptionSeries,
  buildMultiSeriesGeometry,
  dateAxis,
  orgSeries,
  pivotBreakdown,
  prAllZero,
  sliceByRange,
  teamStats,
} from '../../lib/metrics/usage.js';
import type { MultiSeriesGeometry, SeriesFormat } from '../../lib/metrics/usage.js';
import { Card } from '../Card.js';
import { TeamsPanel } from './TeamsPanel.js';
import { TrendChart } from './TrendChart.js';
import styles from './UsageSections.module.css';

/**
 * The org-usage half of the page: every dimension the daily reports break
 * down, one single-metric chart at a time, all sliced by the global range.
 * These series are org aggregates — the seat filters can't apply to them
 * (GitHub doesn't expose per-seat daily breakdowns), only to the teams panel.
 */

const COUNTS: SeriesFormat = { axis: compactCount, tooltip: count };
const PERCENTS: SeriesFormat = { axis: percent, tooltip: percent };

interface UsageSectionsProps {
  usage: UsageHistory | undefined;
  /** The globally filtered seat list — feeds the (roster-based) teams panel. */
  seats: readonly CopilotSeat[];
  range: DateRange;
}

interface ChartSpec {
  title: string;
  geometry: MultiSeriesGeometry;
  subtitle?: string;
}

interface Section {
  heading: string;
  note?: string;
  charts: ChartSpec[];
}

function buildSections(usage: UsageHistory, range: DateRange): Section[] {
  const org = sliceByRange(usage.orgDaily, range);
  const breakdowns = sliceByRange(usage.breakdowns, range);
  const adoption = sliceByRange(usage.adoption, range);
  const dates = dateAxis(org);

  const counts = (input: Parameters<typeof buildMultiSeriesGeometry>[0]): MultiSeriesGeometry =>
    buildMultiSeriesGeometry(input, COUNTS);

  const breakdown = (
    dimension: 'ide' | 'language' | 'feature' | 'model',
    metric: Parameters<typeof pivotBreakdown>[2],
  ): MultiSeriesGeometry => counts(pivotBreakdown(breakdowns, dimension, metric, dates));

  const perDimension = (
    dimension: 'ide' | 'language' | 'feature' | 'model',
    label: string,
    third: { metric: Parameters<typeof pivotBreakdown>[2]; title: string },
  ): Section => ({
    heading: `By ${label}`,
    charts: [
      { title: `Generations by ${label}`, geometry: breakdown(dimension, 'generations') },
      { title: `Acceptances by ${label}`, geometry: breakdown(dimension, 'acceptances') },
      { title: third.title, geometry: breakdown(dimension, third.metric) },
    ],
  });

  const sections: Section[] = [
    {
      heading: 'Org activity',
      note: 'Org-wide series from the daily Copilot reports — the date range applies, seat filters do not.',
      charts: [
        {
          title: 'Active users',
          geometry: counts(
            orgSeries(org, [
              { field: 'dailyActiveUsers', name: 'Daily' },
              { field: 'weeklyActiveUsers', name: 'Weekly' },
              { field: 'monthlyActiveUsers', name: 'Monthly' },
            ]),
          ),
        },
        {
          title: 'Interactions',
          subtitle: 'User-initiated chat and agent interactions per day',
          geometry: counts(orgSeries(org, [{ field: 'interactions', name: 'Interactions' }])),
        },
        {
          title: 'Code generations',
          geometry: counts(orgSeries(org, [{ field: 'generations', name: 'Generations' }])),
        },
        {
          title: 'Code acceptances',
          geometry: counts(orgSeries(org, [{ field: 'acceptances', name: 'Acceptances' }])),
        },
        {
          title: 'Acceptance rate',
          subtitle: 'Acceptances ÷ generations per day',
          geometry: buildMultiSeriesGeometry(acceptanceRateSeries(org), PERCENTS),
        },
        {
          title: 'Lines of code written',
          geometry: counts(
            orgSeries(org, [
              { field: 'locAdded', name: 'Added' },
              { field: 'locDeleted', name: 'Deleted' },
            ]),
          ),
        },
        {
          title: 'Lines of code suggested',
          geometry: counts(
            orgSeries(org, [
              { field: 'locSuggestedAdd', name: 'Suggested add' },
              { field: 'locSuggestedDelete', name: 'Suggested delete' },
            ]),
          ),
        },
      ],
    },
    {
      heading: 'Engaged cohorts',
      charts: [
        {
          title: 'Chat and agent users',
          subtitle: 'Monthly active users of each capability',
          geometry: counts(
            orgSeries(org, [
              { field: 'chatMau', name: 'Chat' },
              { field: 'agentMau', name: 'Agent' },
            ]),
          ),
        },
        {
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
        {
          title: 'Cloud agent users',
          geometry: counts(
            orgSeries(org, [
              { field: 'cloudAgentDau', name: 'Daily' },
              { field: 'cloudAgentWau', name: 'Weekly' },
              { field: 'cloudAgentMau', name: 'Monthly' },
            ]),
          ),
        },
      ],
    },
    perDimension('ide', 'IDE', { metric: 'locAdded', title: 'Lines added by IDE' }),
    perDimension('language', 'language', {
      metric: 'locAdded',
      title: 'Lines added by language',
    }),
    perDimension('feature', 'feature', {
      metric: 'interactions',
      title: 'Interactions by feature',
    }),
    perDimension('model', 'model', { metric: 'locAdded', title: 'Lines added by model' }),
    {
      heading: 'Adoption phases',
      note: "GitHub's AI-adoption cohorts — how many users sit in each phase.",
      charts: [
        {
          title: 'Engaged users per phase',
          geometry: counts(adoptionSeries(adoption)),
        },
      ],
    },
  ];

  if (!prAllZero(org)) {
    sections.push({
      heading: 'Pull requests',
      charts: [
        {
          title: 'PRs created and merged',
          geometry: counts(
            orgSeries(org, [
              { field: 'prCreated', name: 'Created' },
              { field: 'prMerged', name: 'Merged' },
            ]),
          ),
        },
        {
          title: 'Copilot involvement',
          geometry: counts(
            orgSeries(org, [
              { field: 'prCreatedByCopilot', name: 'Created by Copilot' },
              { field: 'prMergedCreatedByCopilot', name: 'Merged (Copilot-created)' },
              { field: 'prReviewedByCopilot', name: 'Reviewed by Copilot' },
            ]),
          ),
        },
        {
          title: 'Review suggestions',
          geometry: counts(
            orgSeries(org, [
              { field: 'prCopilotSuggestions', name: 'Suggested' },
              { field: 'prCopilotAppliedSuggestions', name: 'Applied' },
            ]),
          ),
        },
      ],
    });
  }

  return sections;
}

export function UsageSections({ usage, seats, range }: UsageSectionsProps) {
  const sections = useMemo(
    () => (usage === undefined ? [] : buildSections(usage, range)),
    [usage, range],
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
            {section.charts.map((chart) => (
              <TrendChart
                key={chart.title}
                title={chart.title}
                geometry={chart.geometry}
                {...(chart.subtitle !== undefined ? { subtitle: chart.subtitle } : {})}
              />
            ))}
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
              No PR activity yet — these charts light up once Copilot code review or the coding
              agent is used on pull requests.
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
