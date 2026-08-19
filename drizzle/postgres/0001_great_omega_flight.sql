CREATE TABLE "share_members" (
	"share_id" varchar(64) NOT NULL,
	"item_id" varchar(64) NOT NULL,
	"position" integer NOT NULL,
	"added_at" bigint NOT NULL,
	"removed_at" bigint,
	"removal_reason" varchar(16),
	"download_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "share_members_share_id_item_id_pk" PRIMARY KEY("share_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "name" text;--> statement-breakpoint
CREATE INDEX "idx_share_members_share_active" ON "share_members" USING btree ("share_id","removed_at","position");--> statement-breakpoint
CREATE INDEX "idx_share_members_item_active" ON "share_members" USING btree ("item_id","removed_at");--> statement-breakpoint
INSERT INTO "share_members" ("share_id", "item_id", "position", "added_at", "removed_at", "removal_reason", "download_count")
SELECT "id", "item_id", 0, "created_at", NULL, NULL, "download_count" FROM "shares"
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "schema_version" SET "version" = 5 WHERE "id" = 1;
--> statement-breakpoint
COMMENT ON TABLE "share_members" IS '分享集合的当前及历史成员关系';
--> statement-breakpoint
COMMENT ON COLUMN "share_members"."share_id" IS '所属分享集合标识';
--> statement-breakpoint
COMMENT ON COLUMN "share_members"."item_id" IS '关联的内容项标识';
--> statement-breakpoint
COMMENT ON COLUMN "share_members"."position" IS '成员稳定展示顺序';
--> statement-breakpoint
COMMENT ON COLUMN "share_members"."added_at" IS '最近加入集合的时间，Unix 毫秒时间戳';
--> statement-breakpoint
COMMENT ON COLUMN "share_members"."removed_at" IS '取消成员的时间，NULL 表示当前有效';
--> statement-breakpoint
COMMENT ON COLUMN "share_members"."removal_reason" IS '取消原因：manual 或 trash';
--> statement-breakpoint
COMMENT ON COLUMN "share_members"."download_count" IS '该成员在集合中的历史下载次数';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."name" IS '所有者设置的集合名称，NULL 使用自动名称';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."item_id" IS '兼容历史单项分享的原内容项标识，新逻辑使用 share_members';
--> statement-breakpoint
COMMENT ON COLUMN "shares"."download_count" IS '兼容历史分享的下载次数迁移来源，新统计存于 share_members';
--> statement-breakpoint
COMMENT ON TABLE "shares" IS '拥有统一公开入口、访问控制和生命周期的分享集合';
