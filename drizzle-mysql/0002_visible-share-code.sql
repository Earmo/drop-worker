ALTER TABLE `shares` ADD `code_encrypted` text;
--> statement-breakpoint
UPDATE `schema_version` SET `version` = 4 WHERE `id` = 1;
