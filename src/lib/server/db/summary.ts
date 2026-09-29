import type { WatchedStream } from '$lib/server/miner/types';
import { type EarningsBreakdown, getFirstEarningAtMs, sumEarnings } from './earnings';
import { getConfiguredStreamers, getWatchSessions, toStreamerIds } from './sessions';

const dayMs = 24 * 60 * 60 * 1000;
const averageWindowDays = 7;

export interface WatchingStreamer extends WatchedStream {
  watchingSinceMs: number | null;
  points: number;
  streak: boolean;
}

export interface DashboardSummary {
  watching: WatchingStreamer[];
  earnings: {
    last24h: EarningsBreakdown;
    dailyAverage: number | null;
    allTime: number;
    sinceMs: number | null;
  };
}

// Averages the days before the last 24h, so a partial first day of history does not skew it.
const getDailyAverage = (streamerIds: number[], firstMs: number | null, nowMs: number) => {
  if (firstMs === null) return null;

  const toMs = nowMs - dayMs;
  const fromMs = Math.max(firstMs, toMs - averageWindowDays * dayMs);
  const days = (toMs - fromMs) / dayMs;
  if (days < 1) return null;

  return Math.round(sumEarnings(streamerIds, fromMs, toMs).total / days);
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

  const firstMs = getFirstEarningAtMs(streamerIds);

  return {
    watching,
    earnings: {
      last24h: sumEarnings(streamerIds, nowMs - dayMs, nowMs + 1),
      dailyAverage: getDailyAverage(streamerIds, firstMs, nowMs),
      allTime: sumEarnings(streamerIds, 0, nowMs + 1).total,
      sinceMs: firstMs
    }
  };
};
