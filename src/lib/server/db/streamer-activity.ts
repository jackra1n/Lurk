import { and, gte, inArray, sql } from 'drizzle-orm';
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
}

export const getStreamerActivity = (days: number = 7): StreamerActivityResult => {
	const db = getDatabase();
	const configuredStreamerNames = getStreamers();
	const fromMs = Date.now() - days * 24 * 60 * 60 * 1000;
	const toMs = Date.now();

	if (configuredStreamerNames.length === 0) {
		return { streamers: [] };
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

	return { streamers: items.slice(0, 5) };
};
