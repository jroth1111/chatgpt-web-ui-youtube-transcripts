CREATE TABLE `transcript_chunks` (
	`snapshot_id` text NOT NULL,
	`page` integer NOT NULL,
	`first_index` integer NOT NULL,
	`segments_json` text NOT NULL,
	PRIMARY KEY(`snapshot_id`, `page`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `transcript_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `extractor_leases` (
	`slot` integer PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcript_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`video_id` text NOT NULL,
	`request_lang` text NOT NULL,
	`resolved_lang` text NOT NULL,
	`track_id` text NOT NULL,
	`extractor_version` text NOT NULL,
	`cache_key` text NOT NULL,
	`retrieved_ms` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`bytes` integer NOT NULL,
	`page_count` integer NOT NULL,
	`metadata_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_snapshot_lookup` ON `transcript_snapshots` (`owner_key`,`video_id`,`request_lang`,`extractor_version`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_snapshot_expiry` ON `transcript_snapshots` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_snapshot_cache_key` ON `transcript_snapshots` (`cache_key`);