import { and, desc, gte, inArray, sql } from 'drizzle-orm';
import { getStreamers } from '$lib/server/config';
import { getDatabase } from './client';
import { channelPointEvents, streamSessions, streamers } from './schema';

export interface StreamerActivityItem {
	login: string;
	onlineMinutes: number;
	watchedMinutes: number;
}

export interface StreamerActivityResult {
	streamers: StreamerActivityItem[];
	events: ChannelPointsRecentEventItem[];
}

type ChannelPointsRecentEventKind =
	| 'points_watch'
	| 'points_claim'
	| 'stream_online'
	| 'stream_offline'
	| 'watch_started'
	| 'watch_stopped'
	| 'other';

export interface ChannelPointsRecentEventItem {
	id: string;
	login: string;
	occurredAtMs: number;
	kind: ChannelPointsRecentEventKind;
	reasonCode: string | null;
	pointsDelta: number | null;
}

const eventTypeFilter = ['points_earned', 'stream_up', 'stream_down', 'watch_started', 'watch_stopped'] as const;
const recentEventLimit = 200;

const classifyPointsEventKind = (reasonCode: string | null): ChannelPointsRecentEventKind => {
	const normalized = reasonCode?.toUpperCase() ?? '';
	if (normalized.includes('CLAIM')) return 'points_claim';
	if (normalized.includes('WATCH')) return 'points_watch';
	return 'other';
};

const toRecentEventKind = (eventType: string, reasonCode: string | null): ChannelPointsRecentEventKind => {
	if (eventType === 'stream_up') return 'stream_online';
	if (eventType === 'stream_down') return 'stream_offline';
	if (eventType === 'watch_started') return 'watch_started';
	if (eventType === 'watch_stopped') return 'watch_stopped';
	if (eventType === 'points_earned') return classifyPointsEventKind(reasonCode);
	return 'other';
};

export const getStreamerActivity = (days: number = 7): StreamerActivityResult => {
	const db = getDatabase();
	const configuredStreamerNames = getStreamers();
	const fromMs = Date.now() - days * 24 * 60 * 60 * 1000;
	const toMs = Date.now();

	if (configuredStreamerNames.length === 0) {
		return { streamers: [], events: [] };
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
	const loginByStreamerId = new Map(
		streamerRows
			.filter((item): item is { id: number; login: string } => typeof item.login === 'string')
			.map((item) => [item.id, item.login])
	);

	const streamerIds = streamerRows.map((item) => item.id);

	const onlineTimeRows =
		streamerIds.length > 0
			? db
					.select({
						streamerId: streamSessions.streamerId,
						totalOnlineMs: sql<number | null>`sum(coalesce(${streamSessions.endedAtMs}, ${toMs}) - ${streamSessions.startedAtMs})`
					})
					.from(streamSessions)
					.where(
						and(
							inArray(streamSessions.streamerId, streamerIds),
							gte(streamSessions.startedAtMs, fromMs)
						)
					)
					.groupBy(streamSessions.streamerId)
					.all()
			: [];

	const onlineTimeByStreamerId = new Map<number, number>(
		onlineTimeRows
			.filter((row): row is { streamerId: number; totalOnlineMs: number } => row.totalOnlineMs !== null)
			.map((row) => [row.streamerId, Number(row.totalOnlineMs) / (60 * 1000)])
	);

	const watchEventsRows =
		streamerIds.length > 0
			? db
					.select({
						streamerId: channelPointEvents.streamerId,
						eventType: channelPointEvents.eventType,
						occurredAtMs: channelPointEvents.occurredAtMs
					})
					.from(channelPointEvents)
					.where(
						and(
							inArray(channelPointEvents.streamerId, streamerIds),
							gte(channelPointEvents.occurredAtMs, fromMs),
							inArray(channelPointEvents.eventType, ['watch_started', 'watch_stopped'])
						)
					)
					.orderBy(channelPointEvents.streamerId, channelPointEvents.occurredAtMs)
					.all()
			: [];

	const watchTimeByStreamerId = new Map<number, number>();
	const pendingStartByStreamerId = new Map<number, number>();

	for (const event of watchEventsRows) {
		const streamerId = event.streamerId;
		const current = watchTimeByStreamerId.get(streamerId) ?? 0;

		if (event.eventType === 'watch_started') {
			pendingStartByStreamerId.set(streamerId, Number(event.occurredAtMs));
		} else if (event.eventType === 'watch_stopped') {
			const startMs = pendingStartByStreamerId.get(streamerId);
			if (startMs !== undefined) {
				const durationMs = Number(event.occurredAtMs) - startMs;
				watchTimeByStreamerId.set(streamerId, current + durationMs);
				pendingStartByStreamerId.delete(streamerId);
			}
		}
	}

	for (const [streamerId, startMs] of pendingStartByStreamerId) {
		const current = watchTimeByStreamerId.get(streamerId) ?? 0;
		const durationMs = toMs - startMs;
		watchTimeByStreamerId.set(streamerId, current + durationMs);
	}

	const items: StreamerActivityItem[] = configuredStreamerNames.map((streamerName) => {
		const streamer = streamerByLogin.get(streamerName);
		const onlineMinutes = streamer ? Math.round((onlineTimeByStreamerId.get(streamer.id) ?? 0)) : 0;
		const watchedMinutes = streamer ? Math.round(((watchTimeByStreamerId.get(streamer.id) ?? 0) / (60 * 1000))) : 0;

		return {
			login: streamerName,
			onlineMinutes,
			watchedMinutes
		};
	});

	items.sort((a, b) => b.onlineMinutes - a.onlineMinutes);

	const recentEventsRows =
		streamerIds.length > 0
			? db
					.select({
						id: channelPointEvents.id,
						streamerId: channelPointEvents.streamerId,
						eventType: channelPointEvents.eventType,
						reasonCode: channelPointEvents.reasonCode,
						pointsDelta: channelPointEvents.pointsDelta,
						occurredAtMs: channelPointEvents.occurredAtMs
					})
					.from(channelPointEvents)
					.where(
						and(
							inArray(channelPointEvents.streamerId, streamerIds),
							gte(channelPointEvents.occurredAtMs, fromMs),
							inArray(channelPointEvents.eventType, [...eventTypeFilter])
						)
					)
					.orderBy(desc(channelPointEvents.occurredAtMs), desc(channelPointEvents.id))
					.limit(recentEventLimit)
					.all()
			: [];

	const events = recentEventsRows.flatMap((row) => {
		const login = loginByStreamerId.get(row.streamerId);
		if (!login) return [];

		const reasonCode = row.reasonCode === null ? null : String(row.reasonCode);
		const pointsDelta = row.pointsDelta === null ? null : Number(row.pointsDelta);

		return [
			{
				id: String(row.id),
				login,
				occurredAtMs: Number(row.occurredAtMs),
				kind: toRecentEventKind(String(row.eventType), reasonCode),
				reasonCode,
				pointsDelta
			} satisfies ChannelPointsRecentEventItem
		];
	});

	return { streamers: items.slice(0, 5), events };
};
