import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const streamers = sqliteTable(
	'streamers',
	{
		id: integer('id').primaryKey(),
		login: text('login'),
		channelId: text('channel_id'),
		displayName: text('display_name'),
		createdAtMs: integer('created_at_ms').notNull(),
		updatedAtMs: integer('updated_at_ms').notNull()
	},
	(table) => [
		check('streamers_login_or_channel_id_check', sql`${table.login} IS NOT NULL OR ${table.channelId} IS NOT NULL`),
		uniqueIndex('idx_streamers_login_unique').on(table.login).where(sql`${table.login} IS NOT NULL`),
		uniqueIndex('idx_streamers_channel_id_unique').on(table.channelId).where(sql`${table.channelId} IS NOT NULL`)
	]
);

export const minerRuns = sqliteTable(
	'miner_runs',
	{
		id: integer('id').primaryKey(),
		startedAtMs: integer('started_at_ms').notNull(),
		stoppedAtMs: integer('stopped_at_ms'),
		startReason: text('start_reason').notNull(),
		stopReason: text('stop_reason'),
		userId: text('user_id'),
		username: text('username')
	},
	(table) => [index('idx_miner_runs_started_at').on(table.startedAtMs)]
);

export const streamSessions = sqliteTable(
	'stream_sessions',
	{
		id: integer('id').primaryKey(),
		streamerId: integer('streamer_id')
			.notNull()
			.references(() => streamers.id, { onDelete: 'cascade' }),
		broadcastId: text('broadcast_id'),
		title: text('title'),
		gameName: text('game_name'),
		startedAtMs: integer('started_at_ms').notNull(),
		endedAtMs: integer('ended_at_ms'),
		createdAtMs: integer('created_at_ms').notNull()
	},
	(table) => [
		index('idx_stream_sessions_streamer_started').on(table.streamerId, table.startedAtMs),
		index('idx_stream_sessions_streamer_ended').on(table.streamerId, table.endedAtMs),
		uniqueIndex('idx_stream_sessions_unique').on(table.streamerId, table.broadcastId, table.startedAtMs)
	]
);

export const channelPointEvents = sqliteTable(
	'channel_point_events',
	{
		id: integer('id').primaryKey(),
		occurredAtMs: integer('occurred_at_ms').notNull(),
		streamerId: integer('streamer_id')
			.notNull()
			.references(() => streamers.id, { onDelete: 'cascade' }),
		minerRunId: integer('miner_run_id').references(() => minerRuns.id, { onDelete: 'set null' }),
		streamSessionId: integer('stream_session_id').references(() => streamSessions.id, { onDelete: 'set null' }),
		eventType: text('event_type').notNull(),
		source: text('source').notNull(),
		reasonCode: text('reason_code'),
		pointsDelta: integer('points_delta'),
		balanceAfter: integer('balance_after'),
		claimId: text('claim_id'),
		broadcastId: text('broadcast_id'),
		viewersCount: integer('viewers_count'),
		payloadJson: text('payload_json'),
		createdAtMs: integer('created_at_ms').notNull()
	},
	(table) => [
		index('idx_channel_point_events_streamer_time').on(table.streamerId, table.occurredAtMs),
		index('idx_channel_point_events_type_time').on(table.eventType, table.occurredAtMs),
		index('idx_channel_point_events_balance_timeline')
			.on(table.streamerId, table.occurredAtMs, table.balanceAfter)
			.where(sql`${table.balanceAfter} IS NOT NULL`),
		index('idx_channel_point_events_reason_time')
			.on(table.reasonCode, table.occurredAtMs)
			.where(sql`${table.reasonCode} IS NOT NULL`),
		index('idx_channel_point_events_run_time')
			.on(table.minerRunId, table.occurredAtMs)
			.where(sql`${table.minerRunId} IS NOT NULL`),
		index('idx_channel_point_events_stream_session_time')
			.on(table.streamSessionId, table.occurredAtMs)
			.where(sql`${table.streamSessionId} IS NOT NULL`)
	]
);

export const balanceSamples = sqliteTable(
	'balance_samples',
	{
		id: integer('id').primaryKey(),
		streamerId: integer('streamer_id')
			.notNull()
			.references(() => streamers.id, { onDelete: 'cascade' }),
		sampledAtMs: integer('sampled_at_ms').notNull(),
		balance: integer('balance').notNull(),
		sourceEventId: integer('source_event_id').references(() => channelPointEvents.id, { onDelete: 'set null' }),
		createdAtMs: integer('created_at_ms').notNull()
	},
	(table) => [
		uniqueIndex('balance_samples_streamer_sampled_unique').on(table.streamerId, table.sampledAtMs),
		index('idx_balance_samples_streamer_time').on(table.streamerId, table.sampledAtMs)
	]
);

