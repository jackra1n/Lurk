import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getStreamers } from '$lib/server/config';
import { getDatabase } from './client';
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
	requestTimestampMs?: number;
	selectedStreamerLogin?: string | null;
}

const compareNumbers = (left: number, right: number, dir: SortDir) =>
	dir === 'asc' ? left - right : right - left;

const compareNullableNumbers = (left: number | null, right: number | null, dir: SortDir) => {
	if (left === null && right === null) return 0;
	if (left === null) return dir === 'asc' ? -1 : 1;
	if (right === null) return dir === 'asc' ? 1 : -1;
	return compareNumbers(left, right, dir);
};

const compareByName = (left: string, right: string, dir: SortDir) =>
	dir === 'asc' ? left.localeCompare(right) : right.localeCompare(left);

const comparePriority = (
	leftLogin: string,
	rightLogin: string,
	priorityIndexByLogin: Map<string, number>,
	dir: SortDir
) => {
	const leftIndex = priorityIndexByLogin.get(leftLogin) ?? Number.MAX_SAFE_INTEGER;
	const rightIndex = priorityIndexByLogin.get(rightLogin) ?? Number.MAX_SAFE_INTEGER;
	const byIndex = compareNumbers(leftIndex, rightIndex, dir);
	return byIndex !== 0 ? byIndex : leftLogin.localeCompare(rightLogin);
};

const getStreamerActivityGroup = (
	login: string,
	onlineStreamers: ReadonlySet<string>,
	watchedStreamers: ReadonlySet<string>
) => {
	if (watchedStreamers.has(login)) return 0;
	if (onlineStreamers.has(login)) return 1;
	return 2;
};

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
	requestTimestampMs = Date.now(),
	selectedStreamerLogin
}: ChannelPointsAnalyticsInput): ChannelPointsAnalyticsResult => {
	const db = getDatabase();
	const configuredLogins = getStreamers();
	const priorityIndexByLogin = new Map(configuredLogins.map((login, index) => [login, index]));

	const summary = {
		trackedChannels: configuredLogins.length,
		pointsEarnedThisSession: getPointsEarnedThisSession()
	};

	if (configuredLogins.length === 0) {
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
		.where(inArray(streamers.login, configuredLogins))
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
						lastWatchedAtMs: sql<number | null>`max(case when ${channelPointEvents.eventType} = 'minute_watched_tick' then ${channelPointEvents.occurredAtMs} end)`
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

	const items = configuredLogins.map((login) => {
		const streamer = streamerByLogin.get(login);
		const aggregate = streamer ? aggregateByStreamerId.get(streamer.id) : undefined;

		return {
			streamerId: streamer?.id ?? null,
			login,
			latestBalance: streamer ? getLatestBalanceByStreamerId(streamer.id) : 0,
			pointsEarned: aggregate?.pointsEarned ?? 0,
			lastActiveAtMs: onlineStreamers.has(login) ? requestTimestampMs : (aggregate?.lastOfflineAtMs ?? null),
			lastWatchedAtMs: aggregate?.lastWatchedAtMs ?? null
		} satisfies StreamerAnalyticsItem;
	});

	items.sort((left, right) => {
		if (sortBy === 'priority') return comparePriority(left.login, right.login, priorityIndexByLogin, sortDir);
		if (sortBy === 'name') return compareByName(left.login, right.login, sortDir);
		if (sortBy === 'points') return compareNumbers(left.latestBalance, right.latestBalance, sortDir);
		if (sortBy === 'lastWatched' || sortBy === 'lastActive') {
			const leftGroup = getStreamerActivityGroup(left.login, onlineStreamers, watchedStreamers);
			const rightGroup = getStreamerActivityGroup(right.login, onlineStreamers, watchedStreamers);
			const byGroup = leftGroup - rightGroup;
			if (byGroup !== 0) return byGroup;

			if (leftGroup === 0) {
				const byWatchedName = compareByName(left.login, right.login, sortDir);
				return byWatchedName !== 0 ? byWatchedName : left.login.localeCompare(right.login);
			}

			const leftTimestamp = sortBy === 'lastActive' ? left.lastActiveAtMs : left.lastWatchedAtMs;
			const rightTimestamp = sortBy === 'lastActive' ? right.lastActiveAtMs : right.lastWatchedAtMs;
			const byTimestamp = compareNullableNumbers(leftTimestamp, rightTimestamp, sortDir);
			return byTimestamp !== 0 ? byTimestamp : left.login.localeCompare(right.login);
		}

		return 0;
	});

	const selected = selectedStreamerLogin
		? items.find((item) => item.login === selectedStreamerLogin) ?? items[0] ?? null
		: items[0] ?? null;

	const timeline =
		selected && selected.streamerId !== null ? getTimeline(selected.streamerId, fromMs, toMs) : [];

	return {
		summary,
		streamers: items,
		selectedStreamerLogin: selected?.login ?? null,
		timeline
	};
};
