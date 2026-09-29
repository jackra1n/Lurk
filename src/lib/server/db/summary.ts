import { and, eq, gte, inArray, lt, min, sql } from 'drizzle-orm';
import type { WatchedStream } from '$lib/server/miner/types';
import { getDatabase } from './client';
import { channelPointEvents } from './schema';
import { getConfiguredStreamers, getWatchSessions, toStreamerIds } from './sessions';

const dayMs = 24 * 60 * 60 * 1000;
const averageWindowDays = 7;

export interface WatchingStreamer extends WatchedStream {
  watchingSinceMs: number | null;
  points: number;
  streak: boolean;
}

export interface EarningsBreakdown {
  total: number;
  watch: number;
  claim: number;
  streak: number;
  other: number;
}

export interface DashboardSummary {
  watching: WatchingStreamer[];
  earnings: {
    last24h: EarningsBreakdown;
    dailyAverage: number | null;
  };
}

const breakdownKeyByReason: Record<string, Exclude<keyof EarningsBreakdown, 'total'>> = {
  WATCH: 'watch',
  CLAIM: 'claim',
  WATCH_STREAK: 'streak'
};

const sumPointsByReason = (streamerIds: number[], fromMs: number, toMs: number) =>
  getDatabase()
    .select({
      reasonCode: channelPointEvents.reasonCode,
      total: sql<number>`coalesce(sum(${channelPointEvents.pointsDelta}), 0)`
    })
    .from(channelPointEvents)
    .where(
      and(
        inArray(channelPointEvents.streamerId, streamerIds),
        eq(channelPointEvents.eventType, 'points_earned'),
        gte(channelPointEvents.occurredAtMs, fromMs),
        lt(channelPointEvents.occurredAtMs, toMs)
      )
    )
    .groupBy(channelPointEvents.reasonCode)
    .all();

const toBreakdown = (rows: { reasonCode: string | null; total: number }[]) =>
  rows.reduce<EarningsBreakdown>(
    (breakdown, row) => {
      const total = Number(row.total);
      breakdown[breakdownKeyByReason[row.reasonCode ?? ''] ?? 'other'] += total;
      breakdown.total += total;
      return breakdown;
    },
    { total: 0, watch: 0, claim: 0, streak: 0, other: 0 }
  );

// Averages the days before the last 24h, so a partial first day of history does not skew it.
const getDailyAverage = (streamerIds: number[], nowMs: number) => {
  const toMs = nowMs - dayMs;
  const firstMs =
    getDatabase()
      .select({ occurredAtMs: min(channelPointEvents.occurredAtMs) })
      .from(channelPointEvents)
      .where(
        and(inArray(channelPointEvents.streamerId, streamerIds), eq(channelPointEvents.eventType, 'points_earned'))
      )
      .get()?.occurredAtMs ?? null;
  if (firstMs === null) return null;

  const fromMs = Math.max(firstMs, toMs - averageWindowDays * dayMs);
  const days = (toMs - fromMs) / dayMs;
  if (days < 1) return null;

  const total = toBreakdown(sumPointsByReason(streamerIds, fromMs, toMs)).total;
  return Math.round(total / days);
};

export const getDashboardSummary = (watchedStreams: WatchedStream[], nowMs = Date.now()): DashboardSummary => {
  const configured = getConfiguredStreamers();
  const streamerIds = configured.map((streamer) => streamer.id);
  const watchedIds = toStreamerIds(configured, new Set(watchedStreams.map((stream) => stream.login)));
  const ongoingByStreamerId = new Map(
    getWatchSessions([...watchedIds], nowMs, nowMs, watchedIds)
      .filter((session) => session.ongoing)
      .map((session) => [session.streamerId, session])
  );
  const idByLogin = new Map(configured.map((streamer) => [streamer.login, streamer.id]));

  const watching = watchedStreams.map((stream) => {
    const streamerId = idByLogin.get(stream.login);
    const session = streamerId === undefined ? undefined : ongoingByStreamerId.get(streamerId);
    return {
      ...stream,
      watchingSinceMs: session?.fromMs ?? null,
      points: session?.points ?? 0,
      streak: session?.streak ?? false
    };
  });

  if (streamerIds.length === 0) {
    return { watching, earnings: { last24h: toBreakdown([]), dailyAverage: null } };
  }

  return {
    watching,
    earnings: {
      last24h: toBreakdown(sumPointsByReason(streamerIds, nowMs - dayMs, nowMs + 1)),
      dailyAverage: getDailyAverage(streamerIds, nowMs)
    }
  };
};
