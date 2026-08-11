CREATE TABLE `migration_state` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
UPDATE `schema_version` SET `version` = 3 WHERE `id` = 1;
