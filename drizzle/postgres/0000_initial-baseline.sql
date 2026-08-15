CREATE TABLE "auth_challenges" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"code_hash" varchar(128) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"type" varchar(16) NOT NULL,
	"content" text,
	"title" text,
	"object_key" text,
	"original_name" text,
	"display_name" text,
	"mime_type" varchar(255),
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"favorite" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "local_sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"email" varchar(320) NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_state" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"status" varchar(20) NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schema_version" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
INSERT INTO "schema_version" ("id", "version") VALUES (1, 4);
--> statement-breakpoint
CREATE TABLE "share_attempts" (
	"share_id" varchar(64) NOT NULL,
	"source_hash" varchar(128) NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "share_attempts_share_id_source_hash_pk" PRIMARY KEY("share_id","source_hash")
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"item_id" varchar(64) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"access_mode" varchar(16) NOT NULL,
	"code_hash" varchar(128),
	"code_encrypted" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"access_count" integer DEFAULT 0 NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"object_key" text NOT NULL,
	"provider_upload_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"fingerprint" text NOT NULL,
	"parts_json" text DEFAULT '[]' NOT NULL,
	"status" varchar(20) DEFAULT 'uploading' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_auth_challenges_expires" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_items_owner_created" ON "items" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_items_owner_deleted" ON "items" USING btree ("owner_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_items_owner_favorite" ON "items" USING btree ("owner_id","favorite");--> statement-breakpoint
CREATE INDEX "idx_items_owner_type" ON "items" USING btree ("owner_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_local_sessions_token_hash" ON "local_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_local_sessions_expires" ON "local_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_share_attempts_updated" ON "share_attempts" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_shares_token_hash" ON "shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_shares_owner_created" ON "shares" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_shares_item_status" ON "shares" USING btree ("item_id","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "idx_shares_retention" ON "shares" USING btree ("expires_at","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_uploads_owner_status" ON "uploads" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "idx_uploads_expires" ON "uploads" USING btree ("expires_at");
--> statement-breakpoint
COMMENT ON TABLE "auth_challenges" IS '邮箱验证码登录挑战，仅保存验证码摘要和校验状态';
--> statement-breakpoint
COMMENT ON COLUMN "auth_challenges"."id" IS '验证挑战唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "auth_challenges"."email" IS '接收验证码的登录邮箱';
--> statement-breakpoint
COMMENT ON COLUMN "auth_challenges"."code_hash" IS '验证码摘要，不保存明文验证码';
--> statement-breakpoint
COMMENT ON COLUMN "auth_challenges"."attempts" IS '验证码校验失败次数';
--> statement-breakpoint
COMMENT ON COLUMN "auth_challenges"."created_at" IS '挑战创建时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "auth_challenges"."expires_at" IS '挑战过期时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON TABLE "items" IS '用户投递的文本、链接和文件的统一元数据';
--> statement-breakpoint
COMMENT ON COLUMN "items"."id" IS '内容项唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "items"."owner_id" IS '内容项所有者标识';
--> statement-breakpoint
COMMENT ON COLUMN "items"."type" IS '内容类型：text、link 或 file';
--> statement-breakpoint
COMMENT ON COLUMN "items"."content" IS '文本正文或链接地址，文件类型为空';
--> statement-breakpoint
COMMENT ON COLUMN "items"."title" IS '文本或链接标题';
--> statement-breakpoint
COMMENT ON COLUMN "items"."object_key" IS '文件在对象存储中的键，仅文件类型使用';
--> statement-breakpoint
COMMENT ON COLUMN "items"."original_name" IS '上传时的原始文件名';
--> statement-breakpoint
COMMENT ON COLUMN "items"."display_name" IS '向用户展示的文件名';
--> statement-breakpoint
COMMENT ON COLUMN "items"."mime_type" IS '文件的 MIME 类型';
--> statement-breakpoint
COMMENT ON COLUMN "items"."size_bytes" IS '文件大小，单位为字节';
--> statement-breakpoint
COMMENT ON COLUMN "items"."favorite" IS '是否收藏：0 否，1 是';
--> statement-breakpoint
COMMENT ON COLUMN "items"."created_at" IS '内容项创建时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "items"."updated_at" IS '内容项最后更新时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "items"."deleted_at" IS '软删除时间，NULL 表示未删除，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON TABLE "local_sessions" IS '本地密码或邮件验证码认证创建的登录会话';
--> statement-breakpoint
COMMENT ON COLUMN "local_sessions"."id" IS '登录会话唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "local_sessions"."token_hash" IS '浏览器会话令牌摘要，不保存原始令牌';
--> statement-breakpoint
COMMENT ON COLUMN "local_sessions"."owner_id" IS '认证后的用户所有者标识';
--> statement-breakpoint
COMMENT ON COLUMN "local_sessions"."email" IS '认证用户邮箱';
--> statement-breakpoint
COMMENT ON COLUMN "local_sessions"."created_at" IS '会话创建时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "local_sessions"."expires_at" IS '会话过期时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON TABLE "migration_state" IS '可移植存储导入任务的执行状态';
--> statement-breakpoint
COMMENT ON COLUMN "migration_state"."id" IS '迁移任务唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "migration_state"."status" IS '迁移状态：in_progress 或 complete';
--> statement-breakpoint
COMMENT ON COLUMN "migration_state"."created_at" IS '迁移创建时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "migration_state"."updated_at" IS '迁移最后更新时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON TABLE "schema_version" IS '应用数据库结构版本记录';
--> statement-breakpoint
COMMENT ON COLUMN "schema_version"."id" IS '单例记录标识，固定为 1';
--> statement-breakpoint
COMMENT ON COLUMN "schema_version"."version" IS '当前应用数据库结构版本';
--> statement-breakpoint
COMMENT ON TABLE "share_attempts" IS '按分享和访问来源记录口令失败次数与锁定状态';
--> statement-breakpoint
COMMENT ON COLUMN "share_attempts"."share_id" IS '关联的分享记录标识';
--> statement-breakpoint
COMMENT ON COLUMN "share_attempts"."source_hash" IS '访问来源标识摘要';
--> statement-breakpoint
COMMENT ON COLUMN "share_attempts"."failures" IS '连续口令校验失败次数';
--> statement-breakpoint
COMMENT ON COLUMN "share_attempts"."locked_until" IS '锁定截止时间，0 表示未锁定，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "share_attempts"."updated_at" IS '尝试状态最后更新时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON TABLE "shares" IS '内容项的公开或口令保护分享记录';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."id" IS '分享记录唯一标识';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."owner_id" IS '分享创建者的所有者标识';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."item_id" IS '关联的内容项标识';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."token_hash" IS '分享链接令牌摘要，不保存原始令牌';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."access_mode" IS '访问模式：public 或 code';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."code_hash" IS '访问口令摘要，仅口令模式使用';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."code_encrypted" IS '加密保存的访问口令，用于向所有者展示';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."created_at" IS '分享创建时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."expires_at" IS '分享过期时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."revoked_at" IS '分享撤销时间，NULL 表示未撤销，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."access_count" IS '成功访问次数';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."download_count" IS '完整文件下载次数';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."last_accessed_at" IS '最后成功访问时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON TABLE "uploads" IS '文件分片上传会话及断点续传状态';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."id" IS '上传任务唯一标识，完成后复用为内容项标识';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."owner_id" IS '上传任务所有者标识';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."object_key" IS '文件在对象存储中的目标键';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."provider_upload_id" IS '对象存储服务返回的分片上传标识';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."file_name" IS '上传文件名';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."mime_type" IS '上传文件的 MIME 类型';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."size_bytes" IS '声明的文件大小，单位为字节';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."fingerprint" IS '用于断点续传匹配的客户端文件指纹';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."parts_json" IS '已完成分片的 JSON 数组';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."status" IS '上传状态：uploading、completed、cancelled、expired、cancelling 或 expiring';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."created_at" IS '上传任务创建时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."updated_at" IS '上传任务最后更新时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "uploads"."expires_at" IS '上传任务过期时间，Unix 毫秒时间戳';
