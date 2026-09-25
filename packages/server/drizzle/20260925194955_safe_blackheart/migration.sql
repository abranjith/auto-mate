CREATE TABLE `runtime_environment` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`spec_digest` text NOT NULL,
	`lock_digest` text NOT NULL,
	`python_version` text NOT NULL,
	`uv_version` text NOT NULL,
	`platform` text NOT NULL,
	`arch` text NOT NULL,
	`status` text DEFAULT 'preparing' NOT NULL,
	`fingerprint` text,
	`package_json` text,
	`launcher_digest` text,
	`failure_reason` text,
	`duration_ms` integer,
	`prepared_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "runtime_environment_kind_check" CHECK("kind" in ('script','verify')),
	CONSTRAINT "runtime_environment_status_check" CHECK("status" in ('preparing','ready','failed','aborted')),
	CONSTRAINT "runtime_environment_settled_check" CHECK(("status" = 'preparing' and "prepared_at" is null) or ("status" != 'preparing' and "prepared_at" is not null)),
	CONSTRAINT "runtime_environment_ready_check" CHECK(("status" = 'ready' and "fingerprint" is not null and "package_json" is not null) or ("status" != 'ready' and "fingerprint" is null and "package_json" is null))
);
--> statement-breakpoint
-- Foreign keys are disabled by migrateDatabase before the migrator's transaction.
CREATE TABLE `__new_script_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`code_version_id` integer NOT NULL,
	`approval_id` integer NOT NULL,
	`content_digest` text NOT NULL,
	`runtime_fingerprint` text NOT NULL,
	`dir_path` text NOT NULL,
	`input_manifest` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`stdout` text,
	`stderr` text,
	`output_truncated` integer DEFAULT false NOT NULL,
	`manifest_present` integer,
	`manifest_json` text,
	`declared_output_count` integer,
	`produced_output_count` integer,
	`output_byte_count` integer,
	`limit_breached` text,
	`runtime_lock_digest` text,
	`duration_ms` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`settled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_script_run_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_script_run_code_version_id_code_version_id_fk` FOREIGN KEY (`code_version_id`) REFERENCES `code_version`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_script_run_approval_id_execution_approval_id_fk` FOREIGN KEY (`approval_id`) REFERENCES `execution_approval`(`id`) ON DELETE CASCADE,
	CONSTRAINT "script_run_status_check" CHECK("status" in ('running','succeeded','failed','errored','timed_out','aborted')),
	CONSTRAINT "script_run_settled_check" CHECK(("status" = 'running' and "settled_at" is null) or ("status" != 'running' and "settled_at" is not null)),
	CONSTRAINT "script_run_limit_breached_check" CHECK("limit_breached" is null or "limit_breached" in ('time','memory','output_bytes','output_files')),
	CONSTRAINT "script_run_time_status_check" CHECK("limit_breached" is not 'time' or "status" = 'timed_out')
);
--> statement-breakpoint
INSERT INTO `__new_script_run`(`id`, `execution_id`, `code_version_id`, `approval_id`, `content_digest`, `runtime_fingerprint`, `dir_path`, `input_manifest`, `status`, `exit_code`, `stdout`, `stderr`, `output_truncated`, `manifest_present`, `manifest_json`, `declared_output_count`, `produced_output_count`, `duration_ms`, `started_at`, `settled_at`, `created_at`) SELECT `id`, `execution_id`, `code_version_id`, `approval_id`, `content_digest`, `runtime_fingerprint`, `dir_path`, `input_manifest`, `status`, `exit_code`, `stdout`, `stderr`, `output_truncated`, `manifest_present`, `manifest_json`, `declared_output_count`, `produced_output_count`, `duration_ms`, `started_at`, `settled_at`, `created_at` FROM `script_run`;--> statement-breakpoint
DROP TABLE `script_run`;--> statement-breakpoint
ALTER TABLE `__new_script_run` RENAME TO `script_run`;--> statement-breakpoint
CREATE TABLE `__new_conversation_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`at` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_conversation_event_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT "conversation_event_kind_check" CHECK("kind" in ('user_prompt','state_changed','tool_started','tool_finished','assistant_text','turn_finished','failed','clarification_requested','clarification_answered','disclosure_sent','code_version_sealed','test_run_finished','generation_settled','verification_finished','approval_decided','run_finished','review_decided','runtime_prepared'))
);
--> statement-breakpoint
INSERT INTO `__new_conversation_event`(`id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at`) SELECT `id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at` FROM `conversation_event`;--> statement-breakpoint
DROP TABLE `conversation_event`;--> statement-breakpoint
ALTER TABLE `__new_conversation_event` RENAME TO `conversation_event`;--> statement-breakpoint
CREATE UNIQUE INDEX `script_run_execution` ON `script_run` (`execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_event_execution_seq` ON `conversation_event` (`execution_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_environment_scope` ON `runtime_environment` (`kind`,`spec_digest`,`lock_digest`,`platform`,`arch`);--> statement-breakpoint
CREATE INDEX `runtime_environment_fingerprint` ON `runtime_environment` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `runtime_environment_ready` ON `runtime_environment` (`kind`) WHERE "runtime_environment"."status" = 'ready';--> statement-breakpoint
CREATE TEMP TABLE `__fk_guard_0006` (`orphans` integer NOT NULL CHECK(`orphans` = 0));--> statement-breakpoint
INSERT INTO `__fk_guard_0006` (`orphans`) SELECT count(*) FROM pragma_foreign_key_check;--> statement-breakpoint
DROP TABLE `__fk_guard_0006`;
