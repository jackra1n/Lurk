import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { getDatabase } from './client';
import { channelPointEvents, streamSessions } from './schema';
import {
  clipRange,
  getConfiguredStreamers,
  getLiveRanges,
  getWatchSessions,
  sumRangesMs,
  toStreamerIds,
  type WatchSession
} from './sessions';

const hourMs = 60 * 60 * 1000;
const feedLimit = 100;
const minFeedWatchMs = 60_000;

export type ActivityFeedItem =
  | {
      kind: 'watch';
      id: string;
      login: string;
      occurredAtMs: number;
      durationMs: number;
      points: number;
      streak: boolean;
      ongoing: boolean;
    }
  | {
      kind: 'online';
      id: string;
      login: string;
      occurredAtMs: number;
      game: string | null;
    }
  | {
      kind: 'offline' | 'claim_failed';
      id: string;
      login: string;
      occurredAtMs: number;
    };

export interface MissedTimeItem {
  login: string;
  liveMs: number;
  watchedMs: number;
  missedPoints: number | null;
}

export interface StreamerActivityResult {
  feed: ActivityFeedItem[];
  missed: MissedTimeItem[];
}

interface StreamerActivityInput {
  days: number;
  onlineLogins: ReadonlySet<string>;
  watchedLogins: ReadonlySet<string>;
  nowMs?: number;
}

const getStreamEvents = (streamerIds: number[], fromMs: number) =>
  getDatabase()
    .select({
      id: channelPointEvents.id,
      streamerId: channelPointEvents.streamerId,
      eventType: channelPointEvents.eventType,
      occurredAtMs: channelPointEvents.occurredAtMs,
      game: streamSessions.gameName
    })
    .from(channelPointEvents)
    .leftJoin(streamSessions, eq(streamSessions.id, channelPointEvents.streamSessionId))
    .where(
      and(
        inArray(channelPointEvents.streamerId, streamerIds),
        gte(channelPointEvents.occurredAtMs, fromMs),
        inArray(channelPointEvents.eventType, ['stream_up', 'stream_down', 'claim_failed'])
      )
    )
    .orderBy(desc(channelPointEvents.occurredAtMs))
    .limit(feedLimit)
    .all();

const getFeed = (
  streamerIds: number[],
  loginById: ReadonlyMap<number, string>,
  watchSessions: WatchSession[],
  fromMs: number
) => {
  const watchItems = watchSessions.flatMap((session): ActivityFeedItem[] => {
    const login = loginById.get(session.streamerId);
    const durationMs = session.toMs - session.fromMs;
    if (!login || session.toMs < fromMs || (!session.ongoing && durationMs < minFeedWatchMs)) return [];
    return [
      {
        kind: 'watch',
        id: `watch-${session.id}`,
        login,
        occurredAtMs: session.toMs,
        durationMs,
        points: session.points,
        streak: session.streak,
        ongoing: session.ongoing
      }
    ];
  });

  const streamItems = getStreamEvents(streamerIds, fromMs).flatMap((event): ActivityFeedItem[] => {
    const login = loginById.get(event.streamerId);
    if (!login) return [];
    const base = { id: `event-${event.id}`, login, occurredAtMs: event.occurredAtMs };
    if (event.eventType === 'stream_up') return [{ ...base, kind: 'online', game: event.game }];
    if (event.eventType === 'stream_down') return [{ ...base, kind: 'offline' }];
    return [{ ...base, kind: 'claim_failed' }];
  });

  return [...watchItems, ...streamItems]
    .sort((left, right) => right.occurredAtMs - left.occurredAtMs)
    .slice(0, feedLimit);
};

const pointsPerMs = (sessions: WatchSession[]) => {
  const watchedMs = sumRangesMs(sessions);
  if (watchedMs < hourMs) return null;
  return sessions.reduce((total, session) => total + session.points, 0) / watchedMs;
};

const getMissedTime = (
  streamers: { id: number; login: string }[],
  watchSessions: WatchSession[],
  liveRangesByStreamerId: ReadonlyMap<number, { fromMs: number; toMs: number }[]>,
  fromMs: number,
  nowMs: number
) => {
  const overallRate = pointsPerMs(watchSessions);

  return streamers
    .map((streamer) => {
      const sessions = watchSessions.filter((session) => session.streamerId === streamer.id);
      const liveMs = sumRangesMs(liveRangesByStreamerId.get(streamer.id) ?? []);
      const watchedMs = Math.min(
        liveMs,
        sumRangesMs(sessions.flatMap((session) => clipRange(session, fromMs, nowMs) ?? []))
      );
      const rate = pointsPerMs(sessions) ?? overallRate;

      return {
        login: streamer.login,
        liveMs,
        watchedMs,
        missedPoints: rate === null ? null : Math.round((liveMs - watchedMs) * rate)
      } satisfies MissedTimeItem;
    })
    .filter((item) => item.liveMs > 0)
    .sort((left, right) => right.liveMs - right.watchedMs - (left.liveMs - left.watchedMs));
};

export const getStreamerActivity = ({
  days,
  onlineLogins,
  watchedLogins,
  nowMs = Date.now()
}: StreamerActivityInput): StreamerActivityResult => {
  const configured = getConfiguredStreamers();
  if (configured.length === 0) return { feed: [], missed: [] };

  const fromMs = nowMs - days * 24 * hourMs;
  const streamerIds = configured.map((streamer) => streamer.id);
  const loginById = new Map(configured.map((streamer) => [streamer.id, streamer.login]));
  const watchSessions = getWatchSessions(streamerIds, fromMs, nowMs, toStreamerIds(configured, watchedLogins));
  const liveRanges = getLiveRanges(streamerIds, fromMs, nowMs, nowMs, toStreamerIds(configured, onlineLogins));

  return {
    feed: getFeed(streamerIds, loginById, watchSessions, fromMs),
    missed: getMissedTime(
      configured.filter((streamer) => !streamer.pointsDisabled),
      watchSessions,
      liveRanges,
      fromMs,
      nowMs
    )
  };
};
