CREATE TABLE `share_members` (
	`share_id` varchar(64) NOT NULL,
	`item_id` varchar(64) NOT NULL,
	`position` int NOT NULL,
	`added_at` bigint NOT NULL,
	`removed_at` bigint,
	`removal_reason` varchar(16),
	`download_count` int NOT NULL DEFAULT 0,
	CONSTRAINT `share_members_share_id_item_id_pk` PRIMARY KEY(`share_id`,`item_id`)
);
--> statement-breakpoint
ALTER TABLE `shares` ADD `name` text;--> statement-breakpoint
CREATE INDEX `idx_share_members_share_active` ON `share_members` (`share_id`,`removed_at`,`position`);--> statement-breakpoint
CREATE INDEX `idx_share_members_item_active` ON `share_members` (`item_id`,`removed_at`);--> statement-breakpoint
INSERT IGNORE INTO `share_members` (`share_id`, `item_id`, `position`, `added_at`, `removed_at`, `removal_reason`, `download_count`)
SELECT `id`, `item_id`, 0, `created_at`, NULL, NULL, `download_count` FROM `shares`;--> statement-breakpoint
UPDATE `schema_version` SET `version` = 5 WHERE `id` = 1;
--> statement-breakpoint
ALTER TABLE `share_members`
	MODIFY COLUMN `share_id` varchar(64) NOT NULL COMMENT '所属分享集合标识',
	MODIFY COLUMN `item_id` varchar(64) NOT NULL COMMENT '关联的内容项标识',
	MODIFY COLUMN `position` int NOT NULL COMMENT '成员稳定展示顺序',
	MODIFY COLUMN `added_at` bigint NOT NULL COMMENT '最近加入集合的时间，Unix 毫秒时间戳',
	MODIFY COLUMN `removed_at` bigint COMMENT '取消成员的时间，NULL 表示当前有效',
	MODIFY COLUMN `removal_reason` varchar(16) COMMENT '取消原因：manual 或 trash',
	MODIFY COLUMN `download_count` int NOT NULL DEFAULT 0 COMMENT '该成员在集合中的历史下载次数',
	COMMENT = '分享集合的当前及历史成员关系';
--> statement-breakpoint
ALTER TABLE `shares`
	MODIFY COLUMN `name` text COMMENT '所有者设置的集合名称，NULL 使用自动名称',
	MODIFY COLUMN `item_id` varchar(64) NOT NULL COMMENT '兼容历史单项分享的原内容项标识，新逻辑使用 share_members',
	MODIFY COLUMN `download_count` int NOT NULL DEFAULT 0 COMMENT '兼容历史分享的下载次数迁移来源，新统计存于 share_members',
	COMMENT = '拥有统一公开入口、访问控制和生命周期的分享集合';
