import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { getStreamers } from '$lib/server/config';
import { getDatabase } from './client';
import { sortStreamerAnalyticsItems } from './dashboard-sort';
import { balanceSamples, channelPointEvents, streamers } from './schema';
import { getStreamerPeriods, type TimeRange } from './sessions';

export type ChannelPointsSortBy = 'name' | 'points' | 'lastActive' | 'lastWatched' | 'priority';
export type SortDir = 'asc' | 'desc';

export interface StreamerAnalyticsItem {
  streamerId: number | null;
  login: string;
  displayName: string | null;
  profileImageUrl: string | null;
  latestBalance: number;
  pointsEarned: number;
  lastActiveAtMs: number | null;
  lastWatchedAtMs: number | null;
}

export interface ChannelPointSample {
  timestampMs: number;
  balance: number;
}

export interface ChannelPointsAnalyticsResult {
  streamers: StreamerAnalyticsItem[];
  selectedStreamerLogin: string | null;
  timeline: ChannelPointSample[];
  periods: {
    live: TimeRange[];
    watched: TimeRange[];
  };
}

interface ChannelPointsAnalyticsInput {
  fromMs: number;
  toMs: number;
  sortBy: ChannelPointsSortBy;
  sortDir: SortDir;
  onlineStreamers?: ReadonlySet<string>;
  watchedStreamers?: ReadonlySet<string>;
  runtimeBalanceByLogin?: ReadonlyMap<string, number>;
  requestTimestampMs?: number;
  selectedStreamerLogin?: string | null;
}

const dedupeConsecutiveBalances = (samples: ChannelPointSample[]) =>
  samples.reduce<ChannelPointSample[]>((acc, sample) => {
    const last = acc[acc.length - 1];
    if (!last || last.balance !== sample.balance) acc.push(sample);
    return acc;
  }, []);

const getLatestBalanceByStreamerId = (streamerId: number) => {
  const db = getDatabase();
  const row = db
    .select({ balance: balanceSamples.balance })
    .from(balanceSamples)
    .where(eq(balanceSamples.streamerId, streamerId))
    .orderBy(desc(balanceSamples.sampledAtMs))
    .get();

  return Number(row?.balance ?? 0);
};

// Balances are a step function, so the range is anchored with the balance carried in from before
// it and extended with the latest balance up to now.
const getTimeline = (streamerId: number, fromMs: number, toMs: number, nowMs: number) => {
  const db = getDatabase();
  const previous = db
    .select({ balance: balanceSamples.balance })
    .from(balanceSamples)
    .where(and(eq(balanceSamples.streamerId, streamerId), lt(balanceSamples.sampledAtMs, fromMs)))
    .orderBy(desc(balanceSamples.sampledAtMs))
    .get();
  const samples = db
    .select({
      timestampMs: balanceSamples.sampledAtMs,
      balance: balanceSamples.balance
    })
    .from(balanceSamples)
    .where(
      and(
        eq(balanceSamples.streamerId, streamerId),
        gte(balanceSamples.sampledAtMs, fromMs),
        lte(balanceSamples.sampledAtMs, toMs)
      )
    )
    .orderBy(asc(balanceSamples.sampledAtMs))
    .all()
    .map((item) => ({
      timestampMs: Number(item.timestampMs),
      balance: Number(item.balance)
    }));

  const timeline = dedupeConsecutiveBalances(
    previous ? [{ timestampMs: fromMs, balance: Number(previous.balance) }, ...samples] : samples
  );
  const last = timeline.at(-1);
  const endMs = Math.min(toMs, nowMs);
  if (last && last.timestampMs < endMs) timeline.push({ timestampMs: endMs, balance: last.balance });

  return timeline;
};

export const getChannelPointsAnalytics = ({
  fromMs,
  toMs,
  sortBy,
  sortDir,
  onlineStreamers = new Set<string>(),
  watchedStreamers = new Set<string>(),
  runtimeBalanceByLogin = new Map<string, number>(),
  requestTimestampMs = Date.now(),
  selectedStreamerLogin
}: ChannelPointsAnalyticsInput): ChannelPointsAnalyticsResult => {
  const db = getDatabase();
  const configuredStreamerNames = getStreamers();
  const priorityIndexByLogin = new Map(configuredStreamerNames.map((login, index) => [login, index]));

  if (configuredStreamerNames.length === 0) {
    return {
      streamers: [],
      selectedStreamerLogin: null,
      timeline: [],
      periods: { live: [], watched: [] }
    };
  }

  const streamerRows = db
    .select({
      id: streamers.id,
      login: streamers.login,
      displayName: streamers.displayName,
      profileImageUrl: streamers.profileImageUrl
    })
    .from(streamers)
    .where(inArray(streamers.login, configuredStreamerNames))
    .all();

  const streamerByLogin = new Map(streamerRows.map((item) => [item.login, item]));

  const streamerIds = streamerRows.map((item) => item.id);
  const aggregateRows =
    streamerIds.length > 0
      ? db
          .select({
            streamerId: channelPointEvents.streamerId,
            pointsEarned: sql<number>`coalesce(sum(case when ${channelPointEvents.occurredAtMs} between ${fromMs} and ${toMs} then ${channelPointEvents.pointsDelta} end), 0)`,
            lastOfflineAtMs: sql<
              number | null
            >`max(case when ${channelPointEvents.eventType} = 'stream_down' then ${channelPointEvents.occurredAtMs} end)`,
            lastWatchedAtMs: sql<
              number | null
            >`max(case when ${channelPointEvents.eventType} = 'watch_started' or ${channelPointEvents.eventType} = 'watch_stopped' then ${channelPointEvents.occurredAtMs} end)`
          })
          .from(channelPointEvents)
          .where(inArray(channelPointEvents.streamerId, streamerIds))
          .groupBy(channelPointEvents.streamerId)
          .all()
      : [];

  const aggregateByStreamerId = new Map(
    aggregateRows.map((item) => [
      item.streamerId,
      {
        pointsEarned: Number(item.pointsEarned ?? 0),
        lastOfflineAtMs: item.lastOfflineAtMs === null ? null : Number(item.lastOfflineAtMs),
        lastWatchedAtMs: item.lastWatchedAtMs === null ? null : Number(item.lastWatchedAtMs)
      }
    ])
  );

  const items = configuredStreamerNames.map((streamerName) => {
    const streamer = streamerByLogin.get(streamerName);
    const aggregate = streamer ? aggregateByStreamerId.get(streamer.id) : undefined;
    const fallbackBalance = streamer ? getLatestBalanceByStreamerId(streamer.id) : 0;
    const runtimeBalance = runtimeBalanceByLogin.get(streamerName);

    return {
      streamerId: streamer?.id ?? null,
      login: streamerName,
      displayName: streamer?.displayName ?? null,
      profileImageUrl: streamer?.profileImageUrl ?? null,
      latestBalance: runtimeBalanceByLogin.has(streamerName) ? Number(runtimeBalance ?? 0) : fallbackBalance,
      pointsEarned: aggregate?.pointsEarned ?? 0,
      lastActiveAtMs: onlineStreamers.has(streamerName) ? requestTimestampMs : (aggregate?.lastOfflineAtMs ?? null),
      lastWatchedAtMs: watchedStreamers.has(streamerName) ? requestTimestampMs : (aggregate?.lastWatchedAtMs ?? null)
    } satisfies StreamerAnalyticsItem;
  });

  const sortedItems = sortStreamerAnalyticsItems({
    items,
    sortBy,
    sortDir,
    priorityIndexByLogin,
    onlineStreamers,
    watchedStreamers
  });

  const selected = selectedStreamerLogin
    ? (sortedItems.find((item) => item.login === selectedStreamerLogin) ?? sortedItems[0] ?? null)
    : (sortedItems[0] ?? null);

  const selectedStreamerId = selected?.streamerId ?? null;
  const timeline = selectedStreamerId !== null ? getTimeline(selectedStreamerId, fromMs, toMs, requestTimestampMs) : [];
  const periods =
    selected && selectedStreamerId !== null
      ? getStreamerPeriods(
          selectedStreamerId,
          fromMs,
          toMs,
          requestTimestampMs,
          onlineStreamers.has(selected.login),
          watchedStreamers.has(selected.login)
        )
      : { live: [], watched: [] };

  return {
    streamers: sortedItems,
    selectedStreamerLogin: selected?.login ?? null,
    timeline,
    periods
  };
};
