CREATE TABLE `schema_version` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `schema_version` (`id`, `version`) VALUES (1, 2);
