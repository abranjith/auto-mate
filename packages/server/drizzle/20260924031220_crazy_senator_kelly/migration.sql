CREATE TABLE `upload` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer,
	`original_filename` text NOT NULL,
	`stored_filename` text NOT NULL,
	`file_path` text NOT NULL,
	`format` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`encoding` text,
	`profile_status` text DEFAULT 'pending' NOT NULL,
	`profile_error_code` text,
	`profile_error_message` text,
	`profile_duration_ms` integer,
	`staged_at` integer DEFAULT (unixepoch()) NOT NULL,
	`attached_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_upload_task_id_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON DELETE CASCADE,
	CONSTRAINT "upload_format_check" CHECK("format" in ('csv','xlsx')),
	CONSTRAINT "upload_profile_status_check" CHECK("profile_status" in ('pending','profiling','profiled','failed')),
	CONSTRAINT "upload_byte_size_check" CHECK("byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `upload_column` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`profile_id` integer NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`original_name` text,
	`inferred_type` text NOT NULL,
	`type_confidence` real NOT NULL,
	`is_mixed_type` integer DEFAULT false NOT NULL,
	`null_count` integer DEFAULT 0 NOT NULL,
	`blank_count` integer DEFAULT 0 NOT NULL,
	`value_count` integer DEFAULT 0 NOT NULL,
	`distinct_count` integer,
	`is_high_cardinality` integer DEFAULT false NOT NULL,
	`stats` text,
	`top_values` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_upload_column_profile_id_upload_profile_id_fk` FOREIGN KEY (`profile_id`) REFERENCES `upload_profile`(`id`) ON DELETE CASCADE,
	CONSTRAINT "upload_column_inferred_type_check" CHECK("inferred_type" in ('integer','decimal','boolean','date','datetime','string','empty')),
	CONSTRAINT "upload_column_type_confidence_check" CHECK("type_confidence" between 0.0 and 1.0),
	CONSTRAINT "upload_column_high_cardinality_check" CHECK("is_high_cardinality" = 0 or ("distinct_count" is null and "top_values" is null))
);
--> statement-breakpoint
CREATE TABLE `upload_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`upload_id` integer NOT NULL,
	`sheet_name` text,
	`sheet_index` integer DEFAULT 0 NOT NULL,
	`is_hidden` integer DEFAULT false NOT NULL,
	`row_count` integer NOT NULL,
	`row_count_exact` integer DEFAULT true NOT NULL,
	`column_count` integer NOT NULL,
	`has_header` integer NOT NULL,
	`header_row_index` integer,
	`delimiter` text,
	`dialect` text,
	`ragged_row_count` integer DEFAULT 0 NOT NULL,
	`blank_row_count` integer DEFAULT 0 NOT NULL,
	`merged_cell_count` integer DEFAULT 0 NOT NULL,
	`formula_cell_count` integer DEFAULT 0 NOT NULL,
	`sample_rows` text NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_upload_profile_upload_id_upload_id_fk` FOREIGN KEY (`upload_id`) REFERENCES `upload`(`id`) ON DELETE CASCADE,
	CONSTRAINT "upload_profile_row_count_check" CHECK("row_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `upload_task_id` ON `upload` (`task_id`);--> statement-breakpoint
CREATE INDEX `upload_staged` ON `upload` (`staged_at`) WHERE "upload"."task_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `upload_column_position` ON `upload_column` (`profile_id`,`position`);--> statement-breakpoint
CREATE INDEX `upload_column_name` ON `upload_column` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `upload_profile_sheet` ON `upload_profile` (`upload_id`,`sheet_index`);