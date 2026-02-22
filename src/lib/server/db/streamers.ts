import { eq } from 'drizzle-orm';
import { getDatabase } from './client';
import { streamers } from './schema';
import {
	DEFAULT_CHANNEL_POINTS_STATUS,
	DEFAULT_CHANNEL_POINTS_STATUS_CHECKED_AT_MS,
	type ChannelPointsStatus
} from '$lib/server/miner/channel-points-status';

interface StreamerRef {
	login?: string | null;
	channelId?: string | null;
}

interface PersistedChannelPointsState {
	status: ChannelPointsStatus;
	checkedAtMs: number;
}

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

const asChannelPointsStatus = (value: string | null): ChannelPointsStatus => {
	if (value === 'enabled' || value === 'disabled') return value;
	return DEFAULT_CHANNEL_POINTS_STATUS;
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
			.select({ id: streamers.id })
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
			.select({ id: streamers.id })
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
			channelPointsStatus: DEFAULT_CHANNEL_POINTS_STATUS,
			channelPointsStatusCheckedAtMs: DEFAULT_CHANNEL_POINTS_STATUS_CHECKED_AT_MS,
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

export const getStreamerChannelPointsState = (streamer: StreamerRef): PersistedChannelPointsState => {
	const db = getDatabase();
	const login = normalizeLogin(streamer.login);
	const channelId = normalizeChannelId(streamer.channelId);
	const row = channelId
		? db
				.select({
					status: streamers.channelPointsStatus,
					checkedAtMs: streamers.channelPointsStatusCheckedAtMs
				})
				.from(streamers)
				.where(eq(streamers.channelId, channelId))
				.get()
		: login
			? db
					.select({
						status: streamers.channelPointsStatus,
						checkedAtMs: streamers.channelPointsStatusCheckedAtMs
					})
					.from(streamers)
					.where(eq(streamers.login, login))
					.get()
			: null;

	if (!row) {
		return {
			status: DEFAULT_CHANNEL_POINTS_STATUS,
			checkedAtMs: DEFAULT_CHANNEL_POINTS_STATUS_CHECKED_AT_MS
		};
	}

	return {
		status: asChannelPointsStatus(row.status),
		checkedAtMs: Number(row.checkedAtMs ?? DEFAULT_CHANNEL_POINTS_STATUS_CHECKED_AT_MS)
	};
};

export const setStreamerChannelPointsState = (
	streamer: StreamerRef,
	nextState: PersistedChannelPointsState
): void => {
	const db = getDatabase();
	const login = normalizeLogin(streamer.login);
	const channelId = normalizeChannelId(streamer.channelId);
	const streamerId = ensureStreamer({ login, channelId });

	db
		.update(streamers)
		.set({
			...(login ? { login } : {}),
			...(channelId ? { channelId } : {}),
			channelPointsStatus: nextState.status,
			channelPointsStatusCheckedAtMs: nextState.checkedAtMs,
			updatedAtMs: Date.now()
		})
		.where(eq(streamers.id, streamerId))
		.run();
};
