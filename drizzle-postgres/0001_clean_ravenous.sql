CREATE TABLE "migration_state" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"status" varchar(20) NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
UPDATE "schema_version" SET "version" = 3 WHERE "id" = 1;
