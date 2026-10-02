CREATE TABLE `acquisition_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`video_id` text NOT NULL,
	`lang_key` text NOT NULL,
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
	`snapshot_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_acquisition_pending` ON `acquisition_jobs` (`status`,`next_attempt_ms`,`created_ms`);--> statement-breakpoint
CREATE TABLE `acquisition_nonces` (
	`worker_id` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`worker_id`, `nonce`)
);
--> statement-breakpoint
CREATE INDEX `idx_acquisition_nonce_expiry` ON `acquisition_nonces` (`expires_at`);