CREATE TABLE `creator_response_chunks` (
	`job_id` text NOT NULL,
	`revision` integer NOT NULL,
	`part` integer NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`job_id`, `revision`, `part`),
	FOREIGN KEY (`job_id`) REFERENCES `creator_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `playlist_response_chunks` (
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`part` integer NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`session_id`, `revision`, `part`),
	FOREIGN KEY (`session_id`) REFERENCES `playlist_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
