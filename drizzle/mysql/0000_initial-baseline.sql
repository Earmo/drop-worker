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
CREATE TABLE `migration_state` (
	`id` varchar(64) NOT NULL,
	`status` varchar(20) NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `migration_state_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `schema_version` (
	`id` int NOT NULL,
	`version` int NOT NULL,
	CONSTRAINT `schema_version_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
INSERT INTO `schema_version` (`id`, `version`) VALUES (1, 4);
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
	`code_encrypted` text,
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
ALTER TABLE `auth_challenges`
	MODIFY COLUMN `id` varchar(64) NOT NULL COMMENT '验证挑战唯一标识',
	MODIFY COLUMN `email` varchar(320) NOT NULL COMMENT '接收验证码的登录邮箱',
	MODIFY COLUMN `code_hash` varchar(128) NOT NULL COMMENT '验证码摘要，不保存明文验证码',
	MODIFY COLUMN `attempts` int NOT NULL DEFAULT 0 COMMENT '验证码校验失败次数',
	MODIFY COLUMN `created_at` bigint NOT NULL COMMENT '挑战创建时间，Unix 毫秒时间戳',
	MODIFY COLUMN `expires_at` bigint NOT NULL COMMENT '挑战过期时间，Unix 毫秒时间戳',
	COMMENT = '邮箱验证码登录挑战，仅保存验证码摘要和校验状态';
--> statement-breakpoint
ALTER TABLE `items`
	MODIFY COLUMN `id` varchar(64) NOT NULL COMMENT '内容项唯一标识',
	MODIFY COLUMN `owner_id` varchar(255) NOT NULL COMMENT '内容项所有者标识',
	MODIFY COLUMN `type` varchar(16) NOT NULL COMMENT '内容类型：text、link 或 file',
	MODIFY COLUMN `content` text COMMENT '文本正文或链接地址，文件类型为空',
	MODIFY COLUMN `title` text COMMENT '文本或链接标题',
	MODIFY COLUMN `object_key` text COMMENT '文件在对象存储中的键，仅文件类型使用',
	MODIFY COLUMN `original_name` text COMMENT '上传时的原始文件名',
	MODIFY COLUMN `display_name` text COMMENT '向用户展示的文件名',
	MODIFY COLUMN `mime_type` varchar(255) COMMENT '文件的 MIME 类型',
	MODIFY COLUMN `size_bytes` bigint NOT NULL DEFAULT 0 COMMENT '文件大小，单位为字节',
	MODIFY COLUMN `favorite` int NOT NULL DEFAULT 0 COMMENT '是否收藏：0 否，1 是',
	MODIFY COLUMN `created_at` bigint NOT NULL COMMENT '内容项创建时间，Unix 毫秒时间戳',
	MODIFY COLUMN `updated_at` bigint NOT NULL COMMENT '内容项最后更新时间，Unix 毫秒时间戳',
	MODIFY COLUMN `deleted_at` bigint COMMENT '软删除时间，NULL 表示未删除，Unix 毫秒时间戳',
	COMMENT = '用户投递的文本、链接和文件的统一元数据';
--> statement-breakpoint
ALTER TABLE `local_sessions`
	MODIFY COLUMN `id` varchar(64) NOT NULL COMMENT '登录会话唯一标识',
	MODIFY COLUMN `token_hash` varchar(128) NOT NULL COMMENT '浏览器会话令牌摘要，不保存原始令牌',
	MODIFY COLUMN `owner_id` varchar(255) NOT NULL COMMENT '认证后的用户所有者标识',
	MODIFY COLUMN `email` varchar(320) NOT NULL COMMENT '认证用户邮箱',
	MODIFY COLUMN `created_at` bigint NOT NULL COMMENT '会话创建时间，Unix 毫秒时间戳',
	MODIFY COLUMN `expires_at` bigint NOT NULL COMMENT '会话过期时间，Unix 毫秒时间戳',
	COMMENT = '本地密码或邮件验证码认证创建的登录会话';
--> statement-breakpoint
ALTER TABLE `migration_state`
	MODIFY COLUMN `id` varchar(64) NOT NULL COMMENT '迁移任务唯一标识',
	MODIFY COLUMN `status` varchar(20) NOT NULL COMMENT '迁移状态：in_progress 或 complete',
	MODIFY COLUMN `created_at` bigint NOT NULL COMMENT '迁移创建时间，Unix 毫秒时间戳',
	MODIFY COLUMN `updated_at` bigint NOT NULL COMMENT '迁移最后更新时间，Unix 毫秒时间戳',
	COMMENT = '可移植存储导入任务的执行状态';
--> statement-breakpoint
ALTER TABLE `schema_version`
	MODIFY COLUMN `id` int NOT NULL COMMENT '单例记录标识，固定为 1',
	MODIFY COLUMN `version` int NOT NULL COMMENT '当前应用数据库结构版本',
	COMMENT = '应用数据库结构版本记录';
--> statement-breakpoint
ALTER TABLE `share_attempts`
	MODIFY COLUMN `share_id` varchar(64) NOT NULL COMMENT '关联的分享记录标识',
	MODIFY COLUMN `source_hash` varchar(128) NOT NULL COMMENT '访问来源标识摘要',
	MODIFY COLUMN `failures` int NOT NULL DEFAULT 0 COMMENT '连续口令校验失败次数',
	MODIFY COLUMN `locked_until` bigint NOT NULL DEFAULT 0 COMMENT '锁定截止时间，0 表示未锁定，Unix 毫秒时间戳',
	MODIFY COLUMN `updated_at` bigint NOT NULL COMMENT '尝试状态最后更新时间，Unix 毫秒时间戳',
	COMMENT = '按分享和访问来源记录口令失败次数与锁定状态';
--> statement-breakpoint
ALTER TABLE `shares`
	MODIFY COLUMN `id` varchar(64) NOT NULL COMMENT '分享记录唯一标识',
	MODIFY COLUMN `owner_id` varchar(255) NOT NULL COMMENT '分享创建者的所有者标识',
	MODIFY COLUMN `item_id` varchar(64) NOT NULL COMMENT '关联的内容项标识',
	MODIFY COLUMN `token_hash` varchar(128) NOT NULL COMMENT '分享链接令牌摘要，不保存原始令牌',
	MODIFY COLUMN `access_mode` varchar(16) NOT NULL COMMENT '访问模式：public 或 code',
	MODIFY COLUMN `code_hash` varchar(128) COMMENT '访问口令摘要，仅口令模式使用',
	MODIFY COLUMN `code_encrypted` text COMMENT '加密保存的访问口令，用于向所有者展示',
	MODIFY COLUMN `created_at` bigint NOT NULL COMMENT '分享创建时间，Unix 毫秒时间戳',
	MODIFY COLUMN `expires_at` bigint NOT NULL COMMENT '分享过期时间，Unix 毫秒时间戳',
	MODIFY COLUMN `revoked_at` bigint COMMENT '分享撤销时间，NULL 表示未撤销，Unix 毫秒时间戳',
	MODIFY COLUMN `access_count` int NOT NULL DEFAULT 0 COMMENT '成功访问次数',
	MODIFY COLUMN `download_count` int NOT NULL DEFAULT 0 COMMENT '完整文件下载次数',
	MODIFY COLUMN `last_accessed_at` bigint COMMENT '最后成功访问时间，Unix 毫秒时间戳',
	COMMENT = '内容项的公开或口令保护分享记录';
--> statement-breakpoint
ALTER TABLE `uploads`
	MODIFY COLUMN `id` varchar(64) NOT NULL COMMENT '上传任务唯一标识，完成后复用为内容项标识',
	MODIFY COLUMN `owner_id` varchar(255) NOT NULL COMMENT '上传任务所有者标识',
	MODIFY COLUMN `object_key` text NOT NULL COMMENT '文件在对象存储中的目标键',
	MODIFY COLUMN `provider_upload_id` text NOT NULL COMMENT '对象存储服务返回的分片上传标识',
	MODIFY COLUMN `file_name` text NOT NULL COMMENT '上传文件名',
	MODIFY COLUMN `mime_type` varchar(255) NOT NULL COMMENT '上传文件的 MIME 类型',
	MODIFY COLUMN `size_bytes` bigint NOT NULL COMMENT '声明的文件大小，单位为字节',
	MODIFY COLUMN `fingerprint` text NOT NULL COMMENT '用于断点续传匹配的客户端文件指纹',
	MODIFY COLUMN `parts_json` text NOT NULL DEFAULT ('[]') COMMENT '已完成分片的 JSON 数组',
	MODIFY COLUMN `status` varchar(20) NOT NULL DEFAULT 'uploading' COMMENT '上传状态：uploading、completed、cancelled、expired、cancelling 或 expiring',
	MODIFY COLUMN `created_at` bigint NOT NULL COMMENT '上传任务创建时间，Unix 毫秒时间戳',
	MODIFY COLUMN `updated_at` bigint NOT NULL COMMENT '上传任务最后更新时间，Unix 毫秒时间戳',
	MODIFY COLUMN `expires_at` bigint NOT NULL COMMENT '上传任务过期时间，Unix 毫秒时间戳',
	COMMENT = '文件分片上传会话及断点续传状态';
