import { and, eq, gte, inArray, lt, min, sql } from 'drizzle-orm';
import { getDatabase } from './client';
import { channelPointEvents } from './schema';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const hourlyBucketsUpToMs = 2 * dayMs;

export interface EarningsBreakdown {
  total: number;
  watch: number;
  claim: number;
  streak: number;
  other: number;
}

export interface EarningsBucket extends EarningsBreakdown {
  startMs: number;
}

export interface EarningsBuckets {
  bucketMs: number;
  buckets: EarningsBucket[];
}

const breakdownKeyByReason: Record<string, Exclude<keyof EarningsBreakdown, 'total'>> = {
  WATCH: 'watch',
  CLAIM: 'claim',
  WATCH_STREAK: 'streak'
};

const emptyBreakdown = (): EarningsBreakdown => ({ total: 0, watch: 0, claim: 0, streak: 0, other: 0 });

const addToBreakdown = (breakdown: EarningsBreakdown, reasonCode: string | null, points: number) => {
  breakdown[breakdownKeyByReason[reasonCode ?? ''] ?? 'other'] += points;
  breakdown.total += points;
};

const earnedBetween = (streamerIds: number[], fromMs: number, toMs: number) =>
  and(
    inArray(channelPointEvents.streamerId, streamerIds),
    eq(channelPointEvents.eventType, 'points_earned'),
    gte(channelPointEvents.occurredAtMs, fromMs),
    lt(channelPointEvents.occurredAtMs, toMs)
  );

export const sumEarnings = (streamerIds: number[], fromMs: number, toMs: number) => {
  const breakdown = emptyBreakdown();
  if (streamerIds.length === 0) return breakdown;

  const rows = getDatabase()
    .select({
      reasonCode: channelPointEvents.reasonCode,
      total: sql<number>`coalesce(sum(${channelPointEvents.pointsDelta}), 0)`
    })
    .from(channelPointEvents)
    .where(earnedBetween(streamerIds, fromMs, toMs))
    .groupBy(channelPointEvents.reasonCode)
    .all();

  for (const row of rows) addToBreakdown(breakdown, row.reasonCode, Number(row.total));
  return breakdown;
};

export const getFirstEarningAtMs = (streamerIds: number[]) => {
  if (streamerIds.length === 0) return null;

  return (
    getDatabase()
      .select({ occurredAtMs: min(channelPointEvents.occurredAtMs) })
      .from(channelPointEvents)
      .where(
        and(inArray(channelPointEvents.streamerId, streamerIds), eq(channelPointEvents.eventType, 'points_earned'))
      )
      .get()?.occurredAtMs ?? null
  );
};

// Buckets start at local midnight/hour boundaries of the viewer, given as their UTC offset.
export const getEarningsBuckets = (
  streamerIds: number[],
  fromMs: number,
  toMs: number,
  utcOffsetMinutes: number
): EarningsBuckets => {
  const bucketMs = toMs - fromMs <= hourlyBucketsUpToMs ? hourMs : dayMs;
  const offsetMs = utcOffsetMinutes * 60_000;
  const toBucket = (timestampMs: number) => Math.floor((timestampMs + offsetMs) / bucketMs);
  const firstBucket = toBucket(fromMs);
  const buckets = Array.from({ length: toBucket(toMs) - firstBucket + 1 }, (_, index) => ({
    startMs: (firstBucket + index) * bucketMs - offsetMs,
    ...emptyBreakdown()
  }));

  if (streamerIds.length === 0) return { bucketMs, buckets };

  const rows = getDatabase()
    .select({
      bucket: sql<number>`cast((${channelPointEvents.occurredAtMs} + ${offsetMs}) / ${bucketMs} as integer)`,
      reasonCode: channelPointEvents.reasonCode,
      total: sql<number>`coalesce(sum(${channelPointEvents.pointsDelta}), 0)`
    })
    .from(channelPointEvents)
    .where(earnedBetween(streamerIds, fromMs, toMs + 1))
    .groupBy(sql`1`, channelPointEvents.reasonCode)
    .all();

  for (const row of rows) {
    const bucket = buckets[Number(row.bucket) - firstBucket];
    if (bucket) addToBreakdown(bucket, row.reasonCode, Number(row.total));
  }

  return { bucketMs, buckets };
};
