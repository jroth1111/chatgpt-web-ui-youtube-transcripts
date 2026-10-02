CREATE TABLE `transcript_claims` (
	`request_key` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL
);
