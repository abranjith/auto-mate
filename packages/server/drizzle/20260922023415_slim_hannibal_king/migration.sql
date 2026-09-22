CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `app_meta` (`key`, `value`) VALUES ('schema_version', '1');
--> statement-breakpoint
INSERT INTO `app_meta` (`key`, `value`) VALUES ('app_version', '0.1.0');
--> statement-breakpoint
INSERT INTO `app_meta` (`key`, `value`) VALUES ('installed_at', CAST(unixepoch() AS text));
