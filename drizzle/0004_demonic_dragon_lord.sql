CREATE TABLE `transcript_defaults` (
	`owner_key` text NOT NULL,
	`video_id` text NOT NULL,
	`policy` text NOT NULL,
	`snapshot_id` text NOT NULL,
	PRIMARY KEY(`owner_key`, `video_id`, `policy`)
);
