CREATE TABLE `balance_samples` (
	`id` integer PRIMARY KEY NOT NULL,
	`streamer_id` integer NOT NULL,
	`sampled_at_ms` integer NOT NULL,
	`balance` integer NOT NULL,
	`source_event_id` integer,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_event_id`) REFERENCES `channel_point_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_samples_streamer_sampled_unique` ON `balance_samples` (`streamer_id`,`sampled_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_balance_samples_streamer_time` ON `balance_samples` (`streamer_id`,`sampled_at_ms`);--> statement-breakpoint
CREATE TABLE `channel_point_events` (
	`id` integer PRIMARY KEY NOT NULL,
	`occurred_at_ms` integer NOT NULL,
	`streamer_id` integer NOT NULL,
	`miner_run_id` integer,
	`stream_session_id` integer,
	`event_type` text NOT NULL,
	`source` text NOT NULL,
	`reason_code` text,
	`points_delta` integer,
	`balance_after` integer,
	`claim_id` text,
	`broadcast_id` text,
	`viewers_count` integer,
	`payload_json` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`miner_run_id`) REFERENCES `miner_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`stream_session_id`) REFERENCES `stream_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_channel_point_events_streamer_time` ON `channel_point_events` (`streamer_id`,`occurred_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_channel_point_events_type_time` ON `channel_point_events` (`event_type`,`occurred_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_channel_point_events_balance_timeline` ON `channel_point_events` (`streamer_id`,`occurred_at_ms`,`balance_after`) WHERE "channel_point_events"."balance_after" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_channel_point_events_reason_time` ON `channel_point_events` (`reason_code`,`occurred_at_ms`) WHERE "channel_point_events"."reason_code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_channel_point_events_run_time` ON `channel_point_events` (`miner_run_id`,`occurred_at_ms`) WHERE "channel_point_events"."miner_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_channel_point_events_stream_session_time` ON `channel_point_events` (`stream_session_id`,`occurred_at_ms`) WHERE "channel_point_events"."stream_session_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `miner_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`started_at_ms` integer NOT NULL,
	`stopped_at_ms` integer,
	`start_reason` text NOT NULL,
	`stop_reason` text,
	`user_id` text,
	`username` text
);
--> statement-breakpoint
CREATE INDEX `idx_miner_runs_started_at` ON `miner_runs` (`started_at_ms`);--> statement-breakpoint
CREATE TABLE `stream_sessions` (
	`id` integer PRIMARY KEY NOT NULL,
	`streamer_id` integer NOT NULL,
	`broadcast_id` text,
	`title` text,
	`game_name` text,
	`started_at_ms` integer NOT NULL,
	`ended_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`streamer_id`) REFERENCES `streamers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_stream_sessions_streamer_started` ON `stream_sessions` (`streamer_id`,`started_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_stream_sessions_streamer_ended` ON `stream_sessions` (`streamer_id`,`ended_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stream_sessions_unique` ON `stream_sessions` (`streamer_id`,`broadcast_id`,`started_at_ms`);--> statement-breakpoint
CREATE TABLE `streamers` (
	`id` integer PRIMARY KEY NOT NULL,
	`login` text,
	`channel_id` text,
	`display_name` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "streamers_login_or_channel_id_check" CHECK("streamers"."login" IS NOT NULL OR "streamers"."channel_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_streamers_login_unique` ON `streamers` (`login`) WHERE "streamers"."login" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_streamers_channel_id_unique` ON `streamers` (`channel_id`) WHERE "streamers"."channel_id" IS NOT NULL;