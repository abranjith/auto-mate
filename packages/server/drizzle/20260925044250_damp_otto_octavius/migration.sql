CREATE TABLE `code_file` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`code_version_id` integer NOT NULL,
	`path` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_code_file_code_version_id_code_version_id_fk` FOREIGN KEY (`code_version_id`) REFERENCES `code_version`(`id`) ON DELETE CASCADE,
	CONSTRAINT "code_file_role_check" CHECK("role" in ('script','test','support')),
	CONSTRAINT "code_file_byte_size_check" CHECK("byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `code_version` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`content_digest` text,
	`dir_path` text NOT NULL,
	`entrypoint` text DEFAULT 'main.py' NOT NULL,
	`is_final` integer DEFAULT false NOT NULL,
	`tests_passed` integer,
	`declared_inputs` text,
	`declared_outputs` text,
	`summary` text,
	`sealed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_code_version_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT "code_version_status_check" CHECK("status" in ('draft','sealed','tested_pass','tested_fail','superseded')),
	CONSTRAINT "code_version_attempt_check" CHECK("attempt" >= 1),
	CONSTRAINT "code_version_sealed_check" CHECK(("status" = 'draft' and "content_digest" is null and "sealed_at" is null) or ("status" != 'draft' and "content_digest" is not null and "sealed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE `generation_attempt` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`code_version_id` integer,
	`attempt` integer NOT NULL,
	`call_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`refusal_reason` text,
	`tests_total` integer,
	`tests_passed` integer,
	`tests_failed` integer,
	`exit_code` integer,
	`manifest_present` integer,
	`diagnostic_digest` text,
	`dropped_line_count` integer,
	`duration_ms` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`settled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_generation_attempt_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_generation_attempt_code_version_id_code_version_id_fk` FOREIGN KEY (`code_version_id`) REFERENCES `code_version`(`id`) ON DELETE CASCADE,
	CONSTRAINT "generation_attempt_status_check" CHECK("status" in ('running','passed','failed','errored','timed_out','aborted','refused')),
	CONSTRAINT "generation_attempt_refusal_check" CHECK("refusal_reason" is null or "refusal_reason" in ('attempt_limit','time_limit','cost_limit','diagnostics_not_granted','runtime_unavailable')),
	CONSTRAINT "generation_attempt_refused_check" CHECK(("status" = 'refused') = ("refusal_reason" is not null)),
	CONSTRAINT "generation_attempt_attempt_check" CHECK("attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE `synthetic_fixture` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`upload_id` integer NOT NULL,
	`file_path` text NOT NULL,
	`format` text NOT NULL,
	`sheet_count` integer DEFAULT 1 NOT NULL,
	`row_count` integer NOT NULL,
	`sample_row_count` integer NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`seed` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_synthetic_fixture_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_synthetic_fixture_upload_id_upload_id_fk` FOREIGN KEY (`upload_id`) REFERENCES `upload`(`id`) ON DELETE CASCADE,
	CONSTRAINT "synthetic_fixture_format_check" CHECK("format" in ('csv','xlsx')),
	CONSTRAINT "synthetic_fixture_byte_size_check" CHECK("byte_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE `execution` ADD `retry_of_execution_id` integer REFERENCES execution(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `execution` ADD `guidance` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversation_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`at` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_conversation_event_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT "conversation_event_kind_check" CHECK("kind" in ('user_prompt','state_changed','tool_started','tool_finished','assistant_text','turn_finished','failed','clarification_requested','clarification_answered','disclosure_sent','code_version_sealed','test_run_finished','generation_settled'))
);
--> statement-breakpoint
INSERT INTO `__new_conversation_event`(`id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at`) SELECT `id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at` FROM `conversation_event`;--> statement-breakpoint
DROP TABLE `conversation_event`;--> statement-breakpoint
ALTER TABLE `__new_conversation_event` RENAME TO `conversation_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_event_execution_seq` ON `conversation_event` (`execution_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `code_file_path` ON `code_file` (`code_version_id`,`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `code_version_attempt` ON `code_version` (`execution_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `code_version_final` ON `code_version` (`execution_id`) WHERE "code_version"."is_final" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `code_version_draft` ON `code_version` (`execution_id`) WHERE "code_version"."status" = 'draft';--> statement-breakpoint
CREATE INDEX `code_version_digest` ON `code_version` (`content_digest`);--> statement-breakpoint
CREATE INDEX `execution_retry_of` ON `execution` (`retry_of_execution_id`) WHERE "execution"."retry_of_execution_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `generation_attempt_number` ON `generation_attempt` (`execution_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `generation_attempt_version` ON `generation_attempt` (`code_version_id`) WHERE "generation_attempt"."code_version_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `generation_attempt_call` ON `generation_attempt` (`call_id`) WHERE "generation_attempt"."call_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `synthetic_fixture_upload` ON `synthetic_fixture` (`execution_id`,`upload_id`);