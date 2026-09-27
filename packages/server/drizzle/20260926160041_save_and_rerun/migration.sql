CREATE TABLE `execution_input_binding` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`upload_id` integer NOT NULL,
	`position` integer NOT NULL,
	`input_name` text NOT NULL,
	CONSTRAINT `fk_execution_input_binding_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_execution_input_binding_upload_id_upload_id_fk` FOREIGN KEY (`upload_id`) REFERENCES `upload`(`id`) ON DELETE CASCADE,
	CONSTRAINT "execution_input_binding_position_check" CHECK("position" >= 0)
);
--> statement-breakpoint
CREATE TABLE `execution_reuse` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`kind` text NOT NULL,
	`template_id` integer,
	`template_revision_id` integer,
	`template_name` text NOT NULL,
	`revision_number` integer NOT NULL,
	`revision_digest` text NOT NULL,
	`compatibility_report` text,
	`compatibility_digest` text,
	`mapping` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_execution_reuse_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_execution_reuse_template_id_task_template_id_fk` FOREIGN KEY (`template_id`) REFERENCES `task_template`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_execution_reuse_template_revision_id_template_revision_id_fk` FOREIGN KEY (`template_revision_id`) REFERENCES `template_revision`(`id`) ON DELETE SET NULL,
	CONSTRAINT "execution_reuse_kind_check" CHECK("kind" in ('run','replay','repair')),
	CONSTRAINT "execution_reuse_mapping_check" CHECK("kind" = 'repair' or "mapping" is null),
	CONSTRAINT "execution_reuse_report_check" CHECK(("compatibility_report" is null) = ("compatibility_digest" is null))
);
--> statement-breakpoint
CREATE TABLE `task_template` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "task_template_name_check" CHECK(length(trim("name")) between 1 and 120),
	CONSTRAINT "task_template_description_check" CHECK(length(trim("description")) > 0)
);
--> statement-breakpoint
CREATE TABLE `template_revision` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`template_id` integer NOT NULL,
	`revision_number` integer NOT NULL,
	`source_execution_id` integer,
	`content_digest` text NOT NULL,
	`entrypoint` text NOT NULL,
	`summary` text NOT NULL,
	`declared_inputs` text NOT NULL,
	`declared_outputs` text NOT NULL,
	`input_contract` text NOT NULL,
	`contract_digest` text NOT NULL,
	`runtime_fingerprint` text NOT NULL,
	`runtime_detail` text NOT NULL,
	`reads_wall_clock` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_template_revision_template_id_task_template_id_fk` FOREIGN KEY (`template_id`) REFERENCES `task_template`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_template_revision_source_execution_id_execution_id_fk` FOREIGN KEY (`source_execution_id`) REFERENCES `execution`(`id`) ON DELETE SET NULL,
	CONSTRAINT "template_revision_number_check" CHECK("revision_number" >= 1),
	CONSTRAINT "template_revision_digest_check" CHECK(length("content_digest") = 64)
);
--> statement-breakpoint
CREATE TABLE `template_revision_file` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`revision_id` integer NOT NULL,
	`path` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	CONSTRAINT `fk_template_revision_file_revision_id_template_revision_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `template_revision`(`id`) ON DELETE CASCADE,
	CONSTRAINT "template_revision_file_role_check" CHECK("role" in ('script','test','support')),
	CONSTRAINT "template_revision_file_size_check" CHECK("byte_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE `execution` ADD `as_of_at` integer;--> statement-breakpoint
ALTER TABLE `execution` ADD `as_of_date` text;--> statement-breakpoint
ALTER TABLE `execution` ADD `as_of_timezone` text;--> statement-breakpoint
ALTER TABLE `execution` ADD `as_of_source` text;--> statement-breakpoint
CREATE UNIQUE INDEX `execution_input_binding_name` ON `execution_input_binding` (`execution_id`,`input_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_input_binding_upload` ON `execution_input_binding` (`execution_id`,`upload_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_input_binding_position` ON `execution_input_binding` (`execution_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_reuse_execution` ON `execution_reuse` (`execution_id`);--> statement-breakpoint
CREATE INDEX `execution_reuse_template` ON `execution_reuse` (`template_id`) WHERE "execution_reuse"."template_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `template_revision_number` ON `template_revision` (`template_id`,`revision_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `template_revision_source` ON `template_revision` (`source_execution_id`) WHERE "template_revision"."source_execution_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `template_revision_file_path` ON `template_revision_file` (`revision_id`,`path`);