CREATE TABLE `share_attempts` (
	`share_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`share_id`, `source_hash`)
);
--> statement-breakpoint
CREATE INDEX `idx_share_attempts_updated` ON `share_attempts` (`updated_at`);--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`item_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`access_mode` text NOT NULL,
	`code_hash` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`access_count` integer DEFAULT 0 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`last_accessed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shares_token_hash` ON `shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_shares_owner_created` ON `shares` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shares_item_status` ON `shares` (`item_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_shares_retention` ON `shares` (`expires_at`,`revoked_at`);