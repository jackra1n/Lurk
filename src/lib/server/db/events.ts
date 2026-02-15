import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDatabase, initializeDatabase } from './client';
import {
	balanceSamples,
	channelPointEvents,
	minerRuns,
	streamSessions,
	streamers
} from './schema';
import { getLogger } from '$lib/server/logger';

const logger = getLogger('EventStore');

type EventType =
	| 'stream_up'
	| 'stream_down'
	| 'claim_available'
	| 'claim_attempt'
	| 'claim_success'
	| 'claim_failed'
	| 'points_earned'
	| 'watch_started'
	| 'watch_stopped'
	| 'minute_watched_tick'
	| 'minute_watched_tick_failed'
	| 'context_snapshot';

type EventSource = 'pubsub' | 'gql_context' | 'gql_stream' | 'spade' | 'system';

interface StreamerRef {
	login?: string | null;
	channelId?: string | null;
}

interface EventInput {
	streamer: StreamerRef;
	eventType: EventType;
	source: EventSource;
	occurredAtMs?: number;
	reasonCode?: string | null;
	pointsDelta?: number | null;
	balanceAfter?: number | null;
	claimId?: string | null;
	broadcastId?: string | null;
	viewersCount?: number | null;
	title?: string | null;
	gameName?: string | null;
	payload?: unknown;
}

interface MinerRunInput {
	startReason: string;
	userId?: string | null;
	username?: string | null;
}

let activeMinerRunId: number | null = null;
const openStreamSessionByStreamerId = new Map<number, number>();

const normalizeLogin = (login?: string | null) => {
	if (!login) return null;
	const normalized = login.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
};

const normalizeChannelId = (channelId?: string | null) => {
	if (!channelId) return null;
	const normalized = channelId.trim();
	return normalized.length > 0 ? normalized : null;
};

const serializePayload = (payload: unknown) => {
	if (payload === undefined) return null;

	try {
		return JSON.stringify(payload);
	} catch {
		return JSON.stringify({ serializationError: true });
	}
};

const ensureStreamer = (streamer: StreamerRef) => {
	const db = getDatabase();
	const login = normalizeLogin(streamer.login);
	const channelId = normalizeChannelId(streamer.channelId);
	const now = Date.now();

	if (!login && !channelId) {
		throw new Error('Streamer reference requires login or channelId');
	}

	if (channelId) {
		const row = db
			.select({
				id: streamers.id
			})
			.from(streamers)
			.where(eq(streamers.channelId, channelId))
			.get();

		if (row) {
			db
				.update(streamers)
				.set({
					...(login ? { login } : {}),
					channelId,
					updatedAtMs: now
				})
				.where(eq(streamers.id, row.id))
				.run();

			return row.id;
		}
	}

	if (login) {
		const row = db
			.select({
				id: streamers.id
			})
			.from(streamers)
			.where(eq(streamers.login, login))
			.get();

		if (row) {
			db
				.update(streamers)
				.set({
					login,
					...(channelId ? { channelId } : {}),
					updatedAtMs: now
				})
				.where(eq(streamers.id, row.id))
				.run();

			return row.id;
		}
	}

	const inserted = db
		.insert(streamers)
		.values({
			login,
			channelId,
			createdAtMs: now,
			updatedAtMs: now
		})
		.returning({ id: streamers.id })
		.get();

	if (!inserted) {
		throw new Error('Failed to upsert streamer');
	}

	return inserted.id;
};

const findOpenStreamSessionId = (streamerId: number) => {
	const cached = openStreamSessionByStreamerId.get(streamerId);
	if (cached) return cached;

	const db = getDatabase();
	const row = db
		.select({
			id: streamSessions.id
		})
		.from(streamSessions)
		.where(and(eq(streamSessions.streamerId, streamerId), isNull(streamSessions.endedAtMs)))
		.orderBy(desc(streamSessions.startedAtMs))
		.get();

	if (!row) return null;

	openStreamSessionByStreamerId.set(streamerId, row.id);
	return row.id;
};

const openStreamSession = (streamerId: number, input: EventInput) => {
	const db = getDatabase();
	const existingSessionId = findOpenStreamSessionId(streamerId);

	if (existingSessionId) {
		const nextValues = {
			...(input.broadcastId !== undefined && input.broadcastId !== null
				? { broadcastId: input.broadcastId }
				: {}),
			...(input.title !== undefined && input.title !== null ? { title: input.title } : {}),
			...(input.gameName !== undefined && input.gameName !== null ? { gameName: input.gameName } : {})
		};

		if (Object.keys(nextValues).length > 0) {
			db.update(streamSessions).set(nextValues).where(eq(streamSessions.id, existingSessionId)).run();
		}

		return existingSessionId;
	}

	const inserted = db
		.insert(streamSessions)
		.values({
			streamerId,
			broadcastId: input.broadcastId ?? null,
			title: input.title ?? null,
			gameName: input.gameName ?? null,
			startedAtMs: input.occurredAtMs ?? Date.now(),
			createdAtMs: Date.now()
		})
		.returning({ id: streamSessions.id })
		.get();

	if (!inserted) {
		throw new Error('Failed to create stream session');
	}

	openStreamSessionByStreamerId.set(streamerId, inserted.id);
	return inserted.id;
};

const closeStreamSession = (streamerId: number, streamSessionId: number, endedAtMs: number) => {
	const db = getDatabase();
	db
		.update(streamSessions)
		.set({ endedAtMs })
		.where(and(eq(streamSessions.id, streamSessionId), isNull(streamSessions.endedAtMs)))
		.run();

	openStreamSessionByStreamerId.delete(streamerId);
};

const writeEvent = (streamerId: number, streamSessionId: number | null, input: EventInput) => {
	const db = getDatabase();
	const occurredAtMs = input.occurredAtMs ?? Date.now();
	const inserted = db
		.insert(channelPointEvents)
		.values({
			occurredAtMs,
			streamerId,
			minerRunId: activeMinerRunId,
			streamSessionId,
			eventType: input.eventType,
			source: input.source,
			reasonCode: input.reasonCode ?? null,
			pointsDelta: input.pointsDelta ?? null,
			balanceAfter: input.balanceAfter ?? null,
			claimId: input.claimId ?? null,
			broadcastId: input.broadcastId ?? null,
			viewersCount: input.viewersCount ?? null,
			payloadJson: serializePayload(input.payload),
			createdAtMs: Date.now()
		})
		.returning({ id: channelPointEvents.id })
		.get();

	if (!inserted) {
		throw new Error('Failed to write channel point event');
	}

	if (input.balanceAfter === null || input.balanceAfter === undefined) {
		return;
	}

	db
		.insert(balanceSamples)
		.values({
			streamerId,
			sampledAtMs: occurredAtMs,
			balance: input.balanceAfter,
			sourceEventId: inserted.id,
			createdAtMs: Date.now()
		})
		.onConflictDoUpdate({
			target: [balanceSamples.streamerId, balanceSamples.sampledAtMs],
			set: {
				balance: input.balanceAfter,
				sourceEventId: inserted.id
			}
		})
		.run();
};

const startRun = (input: MinerRunInput) => {
	if (activeMinerRunId) {
		return activeMinerRunId;
	}

	const db = getDatabase();
	const inserted = db
		.insert(minerRuns)
		.values({
			startedAtMs: Date.now(),
			startReason: input.startReason,
			userId: input.userId ?? null,
			username: input.username ?? null
		})
		.returning({ id: minerRuns.id })
		.get();

	if (!inserted) {
		throw new Error('Failed to start miner run');
	}

	activeMinerRunId = inserted.id;
	return activeMinerRunId;
};

const stopRun = (stopReason = 'stopped') => {
	if (!activeMinerRunId) {
		return;
	}

	getDatabase()
		.update(minerRuns)
		.set({
			stoppedAtMs: Date.now(),
			stopReason
		})
		.where(eq(minerRuns.id, activeMinerRunId))
		.run();

	activeMinerRunId = null;
	openStreamSessionByStreamerId.clear();
};

const recordEvent = (input: EventInput) => {
	const streamerId = ensureStreamer(input.streamer);
	let streamSessionId = findOpenStreamSessionId(streamerId);

	if (input.eventType === 'stream_up') {
		streamSessionId = openStreamSession(streamerId, input);
	}

	writeEvent(streamerId, streamSessionId, input);

	if (input.eventType === 'stream_down' && streamSessionId) {
		closeStreamSession(streamerId, streamSessionId, input.occurredAtMs ?? Date.now());
	}
};

const registerStreamer = (streamer: StreamerRef) => {
	ensureStreamer(streamer);
};

const initialize = () => {
	initializeDatabase();
};

const safe = (operation: string, action: () => void) => {
	try {
		action();
	} catch (error) {
		logger.error({ err: error, operation }, 'Database write failed');
	}
};

export const eventStore = {
	initialize,
	registerStreamer: (streamer: StreamerRef) => safe('register_streamer', () => registerStreamer(streamer)),
	startRun: (input: MinerRunInput) => safe('start_run', () => startRun(input)),
	stopRun: (stopReason?: string) => safe('stop_run', () => stopRun(stopReason)),
	recordEvent: (input: EventInput) => safe(`event:${input.eventType}`, () => recordEvent(input))
};
