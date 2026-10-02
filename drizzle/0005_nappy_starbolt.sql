CREATE TABLE `chapter_manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`video_id` text NOT NULL,
	`created_ms` integer NOT NULL,
	`document_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `metadata_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`input_json` text NOT NULL,
	`status` text NOT NULL,
	`created_ms` integer NOT NULL,
	`next_attempt_ms` integer NOT NULL,
	`attempts` integer NOT NULL,
	`lease_expires` integer NOT NULL,
	`worker_id` text,
	`token` text,
	`claim_key` text,
	`global_slot` integer,
	`global_token` text,
	`failure_code` text,
	`result_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_metadata_pending` ON `metadata_jobs` (`status`,`next_attempt_ms`,`created_ms`);--> statement-breakpoint
CREATE TABLE `playlist_pages` (
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`response_json` text NOT NULL,
	PRIMARY KEY(`session_id`, `revision`),
	FOREIGN KEY (`session_id`) REFERENCES `playlist_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `playlist_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`request_key` text NOT NULL,
	`state_json` text NOT NULL,
	`revision` integer NOT NULL,
	`created_ms` integer NOT NULL,
	`lease_token` text,
	`lease_expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_playlist_request` ON `playlist_sessions` (`owner_key`,`request_key`,`created_ms`);