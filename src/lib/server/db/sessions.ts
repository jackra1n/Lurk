import { and, asc, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getStreamers } from '$lib/server/config';
import { getDatabase } from './client';
import { channelPointEvents, streamSessions, streamers } from './schema';

export interface TimeRange {
  fromMs: number;
  toMs: number;
}

export interface WatchSessionEvent {
  id: number;
  streamerId: number;
  eventType: string;
  occurredAtMs: number;
  reasonCode: string | null;
  pointsDelta: number | null;
}

export interface WatchSession extends TimeRange {
  id: number;
  streamerId: number;
  points: number;
  streak: boolean;
  ongoing: boolean;
}

export const maxBroadcastMs = 48 * 60 * 60 * 1000;

export const clipRange = (range: TimeRange, fromMs: number, toMs: number): TimeRange | null => {
  const clipped = { fromMs: Math.max(range.fromMs, fromMs), toMs: Math.min(range.toMs, toMs) };
  return clipped.toMs > clipped.fromMs ? clipped : null;
};

export const sumRangesMs = (ranges: TimeRange[]) =>
  ranges.reduce((total, range) => total + range.toMs - range.fromMs, 0);

export interface ConfiguredStreamer {
  id: number;
  login: string;
  pointsDisabled: boolean;
}

export const getConfiguredStreamers = (): ConfiguredStreamer[] => {
  const logins = getStreamers();
  if (logins.length === 0) return [];

  const rows = getDatabase()
    .select({ id: streamers.id, login: streamers.login, status: streamers.channelPointsStatus })
    .from(streamers)
    .where(inArray(streamers.login, logins))
    .all();
  const rowByLogin = new Map(rows.map((row) => [row.login, row]));

  return logins.flatMap((login) => {
    const row = rowByLogin.get(login);
    return row ? [{ id: row.id, login, pointsDisabled: row.status === 'disabled' }] : [];
  });
};

export const toStreamerIds = (streamers: ConfiguredStreamer[], logins: ReadonlySet<string>) =>
  new Set(streamers.filter((streamer) => logins.has(streamer.login)).map((streamer) => streamer.id));

// Events must be ordered by time. A session without watch_stopped is either still being watched
// or was cut off by a crash, in which case it ends at its last points event.
export const collectWatchSessions = (
  events: WatchSessionEvent[],
  nowMs: number,
  watchedStreamerIds: ReadonlySet<number>
): WatchSession[] => {
  const open = new Map<number, WatchSession>();
  const sessions: WatchSession[] = [];

  const close = (session: WatchSession) => {
    open.delete(session.streamerId);
    sessions.push(session);
  };

  for (const event of events) {
    const current = open.get(event.streamerId);

    if (event.eventType === 'watch_started') {
      if (current) close(current);
      open.set(event.streamerId, {
        id: event.id,
        streamerId: event.streamerId,
        fromMs: event.occurredAtMs,
        toMs: event.occurredAtMs,
        points: 0,
        streak: false,
        ongoing: false
      });
      continue;
    }

    if (!current) continue;

    current.toMs = event.occurredAtMs;
    if (event.eventType === 'watch_stopped') {
      close(current);
    } else if (event.eventType === 'points_earned') {
      current.points += event.pointsDelta ?? 0;
      current.streak ||= event.reasonCode === 'WATCH_STREAK';
    }
  }

  for (const session of open.values()) {
    if (watchedStreamerIds.has(session.streamerId)) {
      session.toMs = nowMs;
      session.ongoing = true;
    }
    sessions.push(session);
  }

  return sessions.sort((left, right) => left.fromMs - right.fromMs);
};

export const getWatchSessions = (
  streamerIds: number[],
  fromMs: number,
  nowMs: number,
  watchedStreamerIds: ReadonlySet<number>
) => {
  if (streamerIds.length === 0) return [];

  const events = getDatabase()
    .select({
      id: channelPointEvents.id,
      streamerId: channelPointEvents.streamerId,
      eventType: channelPointEvents.eventType,
      occurredAtMs: channelPointEvents.occurredAtMs,
      reasonCode: channelPointEvents.reasonCode,
      pointsDelta: channelPointEvents.pointsDelta
    })
    .from(channelPointEvents)
    .where(
      and(
        inArray(channelPointEvents.streamerId, streamerIds),
        gt(channelPointEvents.occurredAtMs, fromMs - maxBroadcastMs),
        inArray(channelPointEvents.eventType, ['watch_started', 'watch_stopped', 'points_earned'])
      )
    )
    .orderBy(asc(channelPointEvents.occurredAtMs), asc(channelPointEvents.id))
    .all();

  return collectWatchSessions(events, nowMs, watchedStreamerIds).filter((session) => session.toMs >= fromMs);
};

// Open sessions of streamers that are no longer online were cut off by a crash or stop.
export const getLiveRanges = (
  streamerIds: number[],
  fromMs: number,
  toMs: number,
  nowMs: number,
  onlineStreamerIds: ReadonlySet<number>
) => {
  const rangesByStreamerId = new Map<number, TimeRange[]>();
  if (streamerIds.length === 0) return rangesByStreamerId;

  const rows = getDatabase()
    .select({
      streamerId: streamSessions.streamerId,
      startedAtMs: streamSessions.startedAtMs,
      endedAtMs: streamSessions.endedAtMs,
      lastEventAtMs: sql<number | null>`(
        select max(${channelPointEvents.occurredAtMs}) from ${channelPointEvents}
        where ${channelPointEvents.streamSessionId} = ${streamSessions.id}
      )`
    })
    .from(streamSessions)
    .where(
      and(
        inArray(streamSessions.streamerId, streamerIds),
        lt(streamSessions.startedAtMs, toMs),
        or(isNull(streamSessions.endedAtMs), gt(streamSessions.endedAtMs, fromMs))
      )
    )
    .orderBy(asc(streamSessions.startedAtMs))
    .all();

  for (const row of rows) {
    const endMs =
      row.endedAtMs ?? (onlineStreamerIds.has(row.streamerId) ? nowMs : (row.lastEventAtMs ?? row.startedAtMs));
    const range = clipRange({ fromMs: row.startedAtMs, toMs: endMs }, fromMs, toMs);
    if (!range) continue;

    const ranges = rangesByStreamerId.get(row.streamerId) ?? [];
    ranges.push(range);
    rangesByStreamerId.set(row.streamerId, ranges);
  }

  return rangesByStreamerId;
};

export const getStreamerPeriods = (
  streamerId: number,
  fromMs: number,
  toMs: number,
  nowMs: number,
  isOnline: boolean,
  isWatched: boolean
) => {
  const ids = new Set([streamerId]);
  return {
    live: getLiveRanges([streamerId], fromMs, toMs, nowMs, isOnline ? ids : new Set()).get(streamerId) ?? [],
    watched: getWatchSessions([streamerId], fromMs, nowMs, isWatched ? ids : new Set()).flatMap(
      (session) => clipRange(session, fromMs, toMs) ?? []
    )
  };
};
