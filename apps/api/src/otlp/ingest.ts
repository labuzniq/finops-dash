import { createHash } from 'node:crypto';
import { and, desc, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { otlpLogRecords, otlpMetricPoints } from '../db/schema.js';
import type { OtlpLogRecordInsert, OtlpMetricPointInsert } from '../db/schema.js';
import { moduleLogger } from '../log.js';

const log = moduleLogger('otlp.ingest');

/**
 * OTLP/HTTP JSON ingest.
 *
 * Decodes `ExportMetricsServiceRequest` / `ExportLogsServiceRequest` payloads
 * (proto3 JSON mapping) into rows. The parser is deliberately tolerant: any
 * datapoint it cannot make sense of is counted as rejected and reported back
 * through `partialSuccess`, never thrown.
 *
 * Cumulative sums are normalised to deltas here, at write time, so every read
 * is a plain SUM — the same job the collector's `cumulativetodelta` processor
 * does. The raw reading is kept in `raw_value` to diff the next export
 * against; a reading below its predecessor is a counter reset and is taken
 * at face value.
 */

type AttrScalar = string | number | boolean;
type Attrs = Record<string, AttrScalar>;

export interface IngestResult {
  accepted: number;
  rejected: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Scalar out of an OTLP `AnyValue`; arrays/kvlists/bytes are dropped. */
function decodeAnyValue(value: unknown): AttrScalar | null {
  if (!isRecord(value)) return null;
  if (typeof value['stringValue'] === 'string') return value['stringValue'];
  if (typeof value['boolValue'] === 'boolean') return value['boolValue'];
  if (value['intValue'] !== undefined) {
    const n = Number(value['intValue']);
    return Number.isFinite(n) ? n : null;
  }
  if (value['doubleValue'] !== undefined) {
    const n = Number(value['doubleValue']);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function decodeAttributes(list: unknown): Attrs {
  const attrs: Attrs = {};
  for (const entry of asArray(list)) {
    if (!isRecord(entry) || typeof entry['key'] !== 'string') continue;
    const value = decodeAnyValue(entry['value']);
    if (value !== null) attrs[entry['key']] = value;
  }
  return attrs;
}

/** Proto3 JSON encodes uint64 nanos as a string; some SDKs send numbers. */
function nanosToDate(value: unknown): Date | null {
  let ms: number;
  if (typeof value === 'string' && value !== '') {
    try {
      ms = Number(BigInt(value) / 1_000_000n);
    } catch {
      return null;
    }
  } else if (typeof value === 'number') {
    ms = value / 1_000_000;
  } else {
    return null;
  }
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

function attrString(attrs: Attrs, key: string): string | null {
  const value = attrs[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The groupable dimensions the dashboard filters on, lifted out of the attributes. */
function extractColumns(attrs: Attrs) {
  return {
    userId: attrString(attrs, 'user.id') ?? attrString(attrs, 'user.account_uuid'),
    userEmail: attrString(attrs, 'user.email'),
    sessionId: attrString(attrs, 'session.id'),
    organizationId: attrString(attrs, 'organization.id'),
    model: attrString(attrs, 'model'),
    type: attrString(attrs, 'type'),
  };
}

/** Stable identity of one OTLP series — what delta normalisation diffs along. */
function seriesKey(metricName: string, attrs: Attrs, startTime: Date | null): string {
  const parts = Object.keys(attrs)
    .sort()
    .map((key) => `${key}=${String(attrs[key])}`);
  return createHash('sha256')
    .update(`${metricName}|${parts.join(',')}|${startTime?.getTime() ?? ''}`)
    .digest('hex');
}

type Temporality = 'delta' | 'cumulative' | 'gauge';

function decodeTemporality(value: unknown): Temporality {
  return value === 2 || value === 'AGGREGATION_TEMPORALITY_CUMULATIVE' ? 'cumulative' : 'delta';
}

interface ParsedPoint {
  temporality: Temporality;
  insert: Omit<OtlpMetricPointInsert, 'value' | 'rawValue'>;
  /** The reading as exported — delta already for delta/gauge series. */
  reading: number;
}

function pointReading(point: Record<string, unknown>): number | null {
  if (typeof point['asDouble'] === 'number') return point['asDouble'];
  if (point['asInt'] !== undefined) {
    const n = Number(point['asInt']);
    return Number.isFinite(n) ? n : null;
  }
  // Histograms carry their total in `sum`.
  if (typeof point['sum'] === 'number') return point['sum'];
  return null;
}

function parseMetrics(body: unknown): { points: ParsedPoint[]; rejected: number } {
  const points: ParsedPoint[] = [];
  let rejected = 0;

  if (!isRecord(body)) return { points, rejected };

  for (const resourceMetrics of asArray(body['resourceMetrics'])) {
    if (!isRecord(resourceMetrics)) continue;
    const resource = resourceMetrics['resource'];
    const resourceAttrs = decodeAttributes(isRecord(resource) ? resource['attributes'] : undefined);
    const serviceName = attrString(resourceAttrs, 'service.name');

    for (const scopeMetrics of asArray(resourceMetrics['scopeMetrics'])) {
      if (!isRecord(scopeMetrics)) continue;

      for (const metric of asArray(scopeMetrics['metrics'])) {
        if (!isRecord(metric) || typeof metric['name'] !== 'string' || metric['name'] === '') {
          rejected += 1;
          continue;
        }
        const metricName = metric['name'];

        // The three shapes we can represent as one number per point.
        const kinds: Array<{ data: unknown; temporality: Temporality }> = [];
        if (isRecord(metric['sum'])) {
          kinds.push({
            data: metric['sum'],
            temporality: decodeTemporality(metric['sum']['aggregationTemporality']),
          });
        }
        if (isRecord(metric['gauge'])) {
          kinds.push({ data: metric['gauge'], temporality: 'gauge' });
        }
        if (isRecord(metric['histogram'])) {
          kinds.push({
            data: metric['histogram'],
            temporality: decodeTemporality(metric['histogram']['aggregationTemporality']),
          });
        }

        for (const kind of kinds) {
          if (!isRecord(kind.data)) continue;
          for (const dataPoint of asArray(kind.data['dataPoints'])) {
            if (!isRecord(dataPoint)) {
              rejected += 1;
              continue;
            }
            const time = nanosToDate(dataPoint['timeUnixNano']);
            const reading = pointReading(dataPoint);
            if (time === null || reading === null) {
              rejected += 1;
              continue;
            }
            const startTime = nanosToDate(dataPoint['startTimeUnixNano']);
            // Datapoint attributes win over resource attributes on collision.
            const attrs: Attrs = { ...resourceAttrs, ...decodeAttributes(dataPoint['attributes']) };

            points.push({
              temporality: kind.temporality,
              reading,
              insert: {
                metricName,
                seriesKey: seriesKey(metricName, attrs, startTime),
                time,
                startTime,
                serviceName,
                attributes: attrs,
                ...extractColumns(attrs),
              },
            });
          }
        }
      }
    }
  }

  return { points, rejected };
}

/** Latest stored raw cumulative reading per series, for delta computation. */
async function lastRawBySeries(keys: readonly string[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([otlpMetricPoints.seriesKey], {
      seriesKey: otlpMetricPoints.seriesKey,
      rawValue: otlpMetricPoints.rawValue,
    })
    .from(otlpMetricPoints)
    .where(and(inArray(otlpMetricPoints.seriesKey, [...keys]), isNotNull(otlpMetricPoints.rawValue)))
    .orderBy(otlpMetricPoints.seriesKey, desc(otlpMetricPoints.time));

  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.rawValue !== null) map.set(row.seriesKey, row.rawValue);
  }
  return map;
}

const INSERT_CHUNK = 500;

async function insertPoints(rows: OtlpMetricPointInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(otlpMetricPoints).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

export async function ingestMetrics(body: unknown): Promise<IngestResult> {
  const { points, rejected } = parseMetrics(body);
  if (points.length === 0) {
    if (rejected > 0) {
      log.warn({ dash: { accepted: 0, rejected } }, 'otlp metrics batch had malformed datapoints');
    }
    return { accepted: 0, rejected };
  }

  const cumulative = points.filter((point) => point.temporality === 'cumulative');
  const lastRaw = await lastRawBySeries([...new Set(cumulative.map((p) => p.insert.seriesKey))]);

  const rows: OtlpMetricPointInsert[] = [];

  for (const point of points) {
    if (point.temporality !== 'cumulative') {
      rows.push({ ...point.insert, value: point.reading, rawValue: null });
    }
  }

  // Cumulative series: order each by time and chain deltas through the batch.
  const bySeries = new Map<string, ParsedPoint[]>();
  for (const point of cumulative) {
    const list = bySeries.get(point.insert.seriesKey) ?? [];
    list.push(point);
    bySeries.set(point.insert.seriesKey, list);
  }
  for (const [key, series] of bySeries) {
    series.sort((a, b) => a.insert.time.getTime() - b.insert.time.getTime());
    let previous = lastRaw.get(key) ?? null;
    for (const point of series) {
      const delta =
        previous !== null && point.reading >= previous ? point.reading - previous : point.reading;
      previous = point.reading;
      rows.push({ ...point.insert, value: delta, rawValue: point.reading });
    }
  }

  await insertPoints(rows);
  if (rejected > 0) {
    log.warn({ dash: { accepted: points.length, rejected } }, 'otlp metrics batch had malformed datapoints');
  } else {
    log.debug(
      { dash: { accepted: points.length, cumulativeSeries: bySeries.size } },
      'otlp metrics batch ingested',
    );
  }
  return { accepted: points.length, rejected };
}

function parseLogs(body: unknown): { records: OtlpLogRecordInsert[]; rejected: number } {
  const records: OtlpLogRecordInsert[] = [];
  let rejected = 0;

  if (!isRecord(body)) return { records, rejected };

  for (const resourceLogs of asArray(body['resourceLogs'])) {
    if (!isRecord(resourceLogs)) continue;
    const resource = resourceLogs['resource'];
    const resourceAttrs = decodeAttributes(isRecord(resource) ? resource['attributes'] : undefined);
    const serviceName = attrString(resourceAttrs, 'service.name');

    for (const scopeLogs of asArray(resourceLogs['scopeLogs'])) {
      if (!isRecord(scopeLogs)) continue;

      for (const record of asArray(scopeLogs['logRecords'])) {
        if (!isRecord(record)) {
          rejected += 1;
          continue;
        }
        const time =
          nanosToDate(record['timeUnixNano']) ??
          nanosToDate(record['observedTimeUnixNano']) ??
          new Date();
        const attrs: Attrs = { ...resourceAttrs, ...decodeAttributes(record['attributes']) };
        const bodyValue = decodeAnyValue(record['body']);
        const columns = extractColumns(attrs);

        records.push({
          time,
          eventName:
            (typeof record['eventName'] === 'string' ? record['eventName'] : null) ??
            attrString(attrs, 'event.name'),
          severity: typeof record['severityText'] === 'string' ? record['severityText'] : null,
          body: bodyValue === null ? null : String(bodyValue),
          userId: columns.userId,
          userEmail: columns.userEmail,
          sessionId: columns.sessionId,
          serviceName,
          attributes: attrs,
        });
      }
    }
  }

  return { records, rejected };
}

export async function ingestLogs(body: unknown): Promise<IngestResult> {
  const { records, rejected } = parseLogs(body);
  for (let i = 0; i < records.length; i += INSERT_CHUNK) {
    await db.insert(otlpLogRecords).values(records.slice(i, i + INSERT_CHUNK));
  }
  if (rejected > 0) {
    log.warn({ dash: { accepted: records.length, rejected } }, 'otlp logs batch had malformed records');
  } else {
    log.debug({ dash: { accepted: records.length } }, 'otlp logs batch ingested');
  }
  return { accepted: records.length, rejected };
}
