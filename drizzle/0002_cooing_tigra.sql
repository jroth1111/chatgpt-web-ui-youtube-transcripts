CREATE TABLE `creator_job_pages` (
	`job_id` text NOT NULL,
	`revision` integer NOT NULL,
	`response_json` text NOT NULL,
	PRIMARY KEY(`job_id`, `revision`),
	FOREIGN KEY (`job_id`) REFERENCES `creator_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `creator_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`owner_key` text NOT NULL,
	`creator_url` text NOT NULL,
	`lang_key` text NOT NULL,
	`requested_limit` integer NOT NULL,
	`state_json` text NOT NULL,
	`created_ms` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revision` integer NOT NULL,
	`lease_token` text,
	`lease_expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_creator_recent` ON `creator_jobs` (`request_key`,`created_ms`);