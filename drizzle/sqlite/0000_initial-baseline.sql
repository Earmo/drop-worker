CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auth_challenges_expires` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`type` text NOT NULL,
	`content` text,
	`title` text,
	`object_key` text,
	`original_name` text,
	`display_name` text,
	`mime_type` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_items_owner_created` ON `items` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_items_owner_deleted` ON `items` (`owner_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_items_owner_favorite` ON `items` (`owner_id`,`favorite`);--> statement-breakpoint
CREATE INDEX `idx_items_owner_type` ON `items` (`owner_id`,`type`);--> statement-breakpoint
CREATE TABLE `local_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`owner_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_sessions_token_hash_unique` ON `local_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_local_sessions_expires` ON `local_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `migration_state` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schema_version` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `schema_version` (`id`, `version`) VALUES (1, 4);
--> statement-breakpoint
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
	`code_encrypted` text,
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
CREATE INDEX `idx_shares_retention` ON `shares` (`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`object_key` text NOT NULL,
	`provider_upload_id` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`parts_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_uploads_owner_status` ON `uploads` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_uploads_expires` ON `uploads` (`expires_at`);
