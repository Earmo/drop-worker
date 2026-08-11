CREATE TABLE `auth_challenges` (
	`id` varchar(64) NOT NULL,
	`email` varchar(320) NOT NULL,
	`code_hash` varchar(128) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`created_at` bigint NOT NULL,
	`expires_at` bigint NOT NULL,
	CONSTRAINT `auth_challenges_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` varchar(64) NOT NULL,
	`owner_id` varchar(255) NOT NULL,
	`type` varchar(16) NOT NULL,
	`content` text,
	`title` text,
	`object_key` text,
	`original_name` text,
	`display_name` text,
	`mime_type` varchar(255),
	`size_bytes` bigint NOT NULL DEFAULT 0,
	`favorite` int NOT NULL DEFAULT 0,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	`deleted_at` bigint,
	CONSTRAINT `items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `local_sessions` (
	`id` varchar(64) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`owner_id` varchar(255) NOT NULL,
	`email` varchar(320) NOT NULL,
	`created_at` bigint NOT NULL,
	`expires_at` bigint NOT NULL,
	CONSTRAINT `local_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_local_sessions_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `schema_version` (
	`id` int NOT NULL,
	`version` int NOT NULL,
	CONSTRAINT `schema_version_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `share_attempts` (
	`share_id` varchar(64) NOT NULL,
	`source_hash` varchar(128) NOT NULL,
	`failures` int NOT NULL DEFAULT 0,
	`locked_until` bigint NOT NULL DEFAULT 0,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `share_attempts_share_id_source_hash_pk` PRIMARY KEY(`share_id`,`source_hash`)
);
--> statement-breakpoint
CREATE TABLE `shares` (
	`id` varchar(64) NOT NULL,
	`owner_id` varchar(255) NOT NULL,
	`item_id` varchar(64) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`access_mode` varchar(16) NOT NULL,
	`code_hash` varchar(128),
	`created_at` bigint NOT NULL,
	`expires_at` bigint NOT NULL,
	`revoked_at` bigint,
	`access_count` int NOT NULL DEFAULT 0,
	`download_count` int NOT NULL DEFAULT 0,
	`last_accessed_at` bigint,
	CONSTRAINT `shares_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_shares_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` varchar(64) NOT NULL,
	`owner_id` varchar(255) NOT NULL,
	`object_key` text NOT NULL,
	`provider_upload_id` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` bigint NOT NULL,
	`fingerprint` text NOT NULL,
	`parts_json` text NOT NULL DEFAULT ('[]'),
	`status` varchar(20) NOT NULL DEFAULT 'uploading',
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	`expires_at` bigint NOT NULL,
	CONSTRAINT `uploads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_auth_challenges_expires` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_items_owner_created` ON `items` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_items_owner_deleted` ON `items` (`owner_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_items_owner_favorite` ON `items` (`owner_id`,`favorite`);--> statement-breakpoint
CREATE INDEX `idx_items_owner_type` ON `items` (`owner_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_local_sessions_expires` ON `local_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_share_attempts_updated` ON `share_attempts` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_shares_owner_created` ON `shares` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shares_item_status` ON `shares` (`item_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_shares_retention` ON `shares` (`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_uploads_owner_status` ON `uploads` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_uploads_expires` ON `uploads` (`expires_at`);
--> statement-breakpoint
INSERT INTO `schema_version` (`id`, `version`) VALUES (1, 2);
