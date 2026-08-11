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
CREATE TABLE "schema_version" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer NOT NULL
);
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
INSERT INTO "schema_version" ("id", "version") VALUES (1, 2);
