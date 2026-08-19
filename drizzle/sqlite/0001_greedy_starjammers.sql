CREATE TABLE `share_members` (
	`share_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer NOT NULL,
	`removed_at` integer,
	`removal_reason` text,
	`download_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`share_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_share_members_share_active` ON `share_members` (`share_id`,`removed_at`,`position`);--> statement-breakpoint
CREATE INDEX `idx_share_members_item_active` ON `share_members` (`item_id`,`removed_at`);--> statement-breakpoint
ALTER TABLE `shares` ADD `name` text;--> statement-breakpoint
INSERT OR IGNORE INTO `share_members` (`share_id`, `item_id`, `position`, `added_at`, `removed_at`, `removal_reason`, `download_count`)
SELECT `id`, `item_id`, 0, `created_at`, NULL, NULL, `download_count` FROM `shares`;--> statement-breakpoint
UPDATE `schema_version` SET `version` = 5 WHERE `id` = 1;
