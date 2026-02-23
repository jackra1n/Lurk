PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_streamers` (
	`id` integer PRIMARY KEY NOT NULL,
	`login` text,
	`channel_id` text,
	`display_name` text,
	`channel_points_status` text DEFAULT 'unknown' NOT NULL,
	`channel_points_status_checked_at_ms` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "streamers_login_or_channel_id_check" CHECK("__new_streamers"."login" IS NOT NULL OR "__new_streamers"."channel_id" IS NOT NULL),
	CONSTRAINT "streamers_channel_points_status_check" CHECK("__new_streamers"."channel_points_status" IN ('unknown', 'enabled', 'disabled'))
);
--> statement-breakpoint
INSERT INTO `__new_streamers`("id", "login", "channel_id", "display_name", "channel_points_status", "channel_points_status_checked_at_ms", "created_at_ms", "updated_at_ms") SELECT "id", "login", "channel_id", "display_name", 'unknown', 0, "created_at_ms", "updated_at_ms" FROM `streamers`;--> statement-breakpoint
DROP TABLE `streamers`;--> statement-breakpoint
ALTER TABLE `__new_streamers` RENAME TO `streamers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_streamers_login_unique` ON `streamers` (`login`) WHERE "streamers"."login" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_streamers_channel_id_unique` ON `streamers` (`channel_id`) WHERE "streamers"."channel_id" IS NOT NULL;
