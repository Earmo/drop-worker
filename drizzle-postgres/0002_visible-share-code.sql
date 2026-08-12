ALTER TABLE "shares" ADD COLUMN "code_encrypted" text;
--> statement-breakpoint
UPDATE "schema_version" SET "version" = 4 WHERE "id" = 1;
