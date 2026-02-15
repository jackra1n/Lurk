import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getStreamers } from '$lib/server/config';
import { getDatabase } from './client';
import { sortStreamerAnalyticsItems } from './dashboard-sort';
import { balanceSamples, channelPointEvents, minerRuns, streamers } from './schema';

export type ChannelPointsSortBy = 'name' | 'points' | 'lastActive' | 'lastWatched' | 'priority';
export type SortDir = 'asc' | 'desc';

export interface StreamerAnalyticsItem {
	streamerId: number | null;
	login: string;
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
	summary: {
		trackedChannels: number;
		pointsEarnedThisSession: number;
	};
	streamers: StreamerAnalyticsItem[];
	selectedStreamerLogin: string | null;
	timeline: ChannelPointSample[];
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

const getPointsEarnedThisSession = () => {
	const db = getDatabase();
	const activeRun = db
		.select({ id: minerRuns.id })
		.from(minerRuns)
		.where(isNull(minerRuns.stoppedAtMs))
		.orderBy(desc(minerRuns.startedAtMs))
		.get();

	if (!activeRun) return 0;

	const row = db
		.select({
			total: sql<number>`coalesce(sum(${channelPointEvents.pointsDelta}), 0)`
		})
		.from(channelPointEvents)
		.where(and(eq(channelPointEvents.minerRunId, activeRun.id), eq(channelPointEvents.eventType, 'points_earned')))
		.get();

	return Number(row?.total ?? 0);
};

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

const getTimeline = (streamerId: number, fromMs: number, toMs: number) => {
	const db = getDatabase();
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

	return dedupeConsecutiveBalances(samples);
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

	const summary = {
		trackedChannels: configuredStreamerNames.length,
		pointsEarnedThisSession: getPointsEarnedThisSession()
	};

	if (configuredStreamerNames.length === 0) {
		return {
			summary,
			streamers: [],
			selectedStreamerLogin: null,
			timeline: []
		};
	}

	const streamerRows = db
		.select({
			id: streamers.id,
			login: streamers.login
		})
		.from(streamers)
		.where(inArray(streamers.login, configuredStreamerNames))
		.all();

	const streamerByLogin = new Map(
		streamerRows
			.filter((item): item is { id: number; login: string } => typeof item.login === 'string')
			.map((item) => [item.login, item])
	);

	const streamerIds = streamerRows.map((item) => item.id);
	const aggregateRows =
		streamerIds.length > 0
			? db
					.select({
						streamerId: channelPointEvents.streamerId,
						pointsEarned: sql<number>`coalesce(sum(${channelPointEvents.pointsDelta}), 0)`,
						lastOfflineAtMs: sql<number | null>`max(case when ${channelPointEvents.eventType} = 'stream_down' then ${channelPointEvents.occurredAtMs} end)`,
						lastWatchedAtMs: sql<number | null>`max(case when ${channelPointEvents.eventType} = 'watch_started' or ${channelPointEvents.eventType} = 'watch_stopped' then ${channelPointEvents.occurredAtMs} end)`
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
			latestBalance: runtimeBalanceByLogin.has(streamerName) ? Number(runtimeBalance ?? 0) : fallbackBalance,
			pointsEarned: aggregate?.pointsEarned ?? 0,
			lastActiveAtMs: onlineStreamers.has(streamerName) ? requestTimestampMs : (aggregate?.lastOfflineAtMs ?? null),
			lastWatchedAtMs: aggregate?.lastWatchedAtMs ?? null
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
		? sortedItems.find((item) => item.login === selectedStreamerLogin) ?? sortedItems[0] ?? null
		: sortedItems[0] ?? null;

	const timeline =
		selected && selected.streamerId !== null ? getTimeline(selected.streamerId, fromMs, toMs) : [];

	return {
		summary,
		streamers: sortedItems,
		selectedStreamerLogin: selected?.login ?? null,
		timeline
	};
};
