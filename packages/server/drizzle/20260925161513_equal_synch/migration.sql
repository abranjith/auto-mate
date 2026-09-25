CREATE TABLE `execution_approval` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`code_version_id` integer NOT NULL,
	`verification_run_id` integer NOT NULL,
	`content_digest` text NOT NULL,
	`runtime_fingerprint` text NOT NULL,
	`intent_digest` text NOT NULL,
	`decision` text NOT NULL,
	`acknowledged_warnings` integer DEFAULT false NOT NULL,
	`decided_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_execution_approval_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_execution_approval_code_version_id_code_version_id_fk` FOREIGN KEY (`code_version_id`) REFERENCES `code_version`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_execution_approval_verification_run_id_verification_run_id_fk` FOREIGN KEY (`verification_run_id`) REFERENCES `verification_run`(`id`) ON DELETE CASCADE,
	CONSTRAINT "execution_approval_decision_check" CHECK("decision" in ('approved','cancelled'))
);
--> statement-breakpoint
CREATE TABLE `script_run` (
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
	`duration_ms` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`settled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_script_run_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_script_run_code_version_id_code_version_id_fk` FOREIGN KEY (`code_version_id`) REFERENCES `code_version`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_script_run_approval_id_execution_approval_id_fk` FOREIGN KEY (`approval_id`) REFERENCES `execution_approval`(`id`) ON DELETE CASCADE,
	CONSTRAINT "script_run_status_check" CHECK("status" in ('running','succeeded','failed','errored','timed_out','aborted')),
	CONSTRAINT "script_run_settled_check" CHECK(("status" = 'running' and "settled_at" is null) or ("status" != 'running' and "settled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE `verification_check` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`verification_run_id` integer NOT NULL,
	`check_key` text NOT NULL,
	`status` text NOT NULL,
	`is_blocking` integer NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_verification_check_verification_run_id_verification_run_id_fk` FOREIGN KEY (`verification_run_id`) REFERENCES `verification_run`(`id`) ON DELETE CASCADE,
	CONSTRAINT "verification_check_key_check" CHECK("check_key" in ('integrity','contract_entrypoint','contract_inputs','contract_outputs','lint','security','tests')),
	CONSTRAINT "verification_check_status_check" CHECK("status" in ('passed','failed','skipped','errored'))
);
--> statement-breakpoint
CREATE TABLE `verification_finding` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`check_id` integer NOT NULL,
	`rule_code` text NOT NULL,
	`severity` text NOT NULL,
	`confidence` text,
	`file_path` text,
	`line` integer,
	`column` integer,
	`message` text NOT NULL,
	`is_blocking` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_verification_finding_check_id_verification_check_id_fk` FOREIGN KEY (`check_id`) REFERENCES `verification_check`(`id`) ON DELETE CASCADE,
	CONSTRAINT "verification_finding_severity_check" CHECK("severity" in ('high','medium','low','info')),
	CONSTRAINT "verification_finding_confidence_check" CHECK("confidence" is null or "confidence" in ('high','medium','low'))
);
--> statement-breakpoint
CREATE TABLE `verification_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`code_version_id` integer NOT NULL,
	`content_digest` text NOT NULL,
	`runtime_fingerprint` text NOT NULL,
	`runtime_detail` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`blocking_count` integer DEFAULT 0 NOT NULL,
	`advisory_count` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`duration_ms` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`settled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_verification_run_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_verification_run_code_version_id_code_version_id_fk` FOREIGN KEY (`code_version_id`) REFERENCES `code_version`(`id`) ON DELETE CASCADE,
	CONSTRAINT "verification_run_status_check" CHECK("status" in ('running','passed','failed','errored','timed_out','aborted')),
	CONSTRAINT "verification_run_counts_check" CHECK("blocking_count" >= 0 and "advisory_count" >= 0),
	CONSTRAINT "verification_run_settled_check" CHECK(("status" = 'running' and "settled_at" is null) or ("status" != 'running' and "settled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE `execution` ADD `review_feedback` text;--> statement-breakpoint
ALTER TABLE `execution` ADD `reviewed_at` integer;--> statement-breakpoint
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
	CONSTRAINT "conversation_event_kind_check" CHECK("kind" in ('user_prompt','state_changed','tool_started','tool_finished','assistant_text','turn_finished','failed','clarification_requested','clarification_answered','disclosure_sent','code_version_sealed','test_run_finished','generation_settled','verification_finished','approval_decided','run_finished','review_decided'))
);
--> statement-breakpoint
INSERT INTO `__new_conversation_event`(`id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at`) SELECT `id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at` FROM `conversation_event`;--> statement-breakpoint
DROP TABLE `conversation_event`;--> statement-breakpoint
ALTER TABLE `__new_conversation_event` RENAME TO `conversation_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_execution` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`agent_session_id` text,
	`agent_log_path` text,
	`provider` text,
	`model` text,
	`error_code` text,
	`error_message` text,
	`usage_turns` integer,
	`usage_input_tokens` integer,
	`usage_output_tokens` integer,
	`usage_cost_usd` real,
	`started_at` integer,
	`completed_at` integer,
	`duration_ms` integer,
	`retry_of_execution_id` integer,
	`guidance` text,
	`review_feedback` text,
	`reviewed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_execution_task_id_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_execution_retry_of_execution_id_execution_id_fk` FOREIGN KEY (`retry_of_execution_id`) REFERENCES `execution`(`id`) ON DELETE SET NULL,
	CONSTRAINT "execution_status_check" CHECK("status" in ('pending','generating','verifying','awaiting_approval','executing','awaiting_review','waiting','completed','failed','aborted','rejected')),
	CONSTRAINT "execution_trigger_check" CHECK("trigger" in ('manual','rerun','feedback'))
);
--> statement-breakpoint
INSERT INTO `__new_execution`(`id`, `task_id`, `status`, `trigger`, `agent_session_id`, `agent_log_path`, `provider`, `model`, `error_code`, `error_message`, `usage_turns`, `usage_input_tokens`, `usage_output_tokens`, `usage_cost_usd`, `started_at`, `completed_at`, `duration_ms`, `retry_of_execution_id`, `guidance`, `created_at`) SELECT `id`, `task_id`, `status`, `trigger`, `agent_session_id`, `agent_log_path`, `provider`, `model`, `error_code`, `error_message`, `usage_turns`, `usage_input_tokens`, `usage_output_tokens`, `usage_cost_usd`, `started_at`, `completed_at`, `duration_ms`, `retry_of_execution_id`, `guidance`, `created_at` FROM `execution`;--> statement-breakpoint
DROP TABLE `execution`;--> statement-breakpoint
ALTER TABLE `__new_execution` RENAME TO `execution`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_event_execution_seq` ON `conversation_event` (`execution_id`,`seq`);--> statement-breakpoint
CREATE INDEX `execution_task_id` ON `execution` (`task_id`);--> statement-breakpoint
CREATE INDEX `execution_active` ON `execution` (`status`) WHERE "execution"."status" in ('pending','generating','verifying','executing','waiting');--> statement-breakpoint
CREATE INDEX `execution_parked` ON `execution` (`status`) WHERE "execution"."status" in ('awaiting_approval','awaiting_review');--> statement-breakpoint
CREATE INDEX `execution_retry_of` ON `execution` (`retry_of_execution_id`) WHERE "execution"."retry_of_execution_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `execution_approval_granted` ON `execution_approval` (`execution_id`) WHERE "execution_approval"."decision" = 'approved';--> statement-breakpoint
CREATE INDEX `execution_approval_execution` ON `execution_approval` (`execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `script_run_execution` ON `script_run` (`execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `verification_check_key` ON `verification_check` (`verification_run_id`,`check_key`);--> statement-breakpoint
CREATE INDEX `verification_finding_check` ON `verification_finding` (`check_id`);--> statement-breakpoint
CREATE INDEX `verification_finding_blocking` ON `verification_finding` (`check_id`) WHERE "verification_finding"."is_blocking" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `verification_run_scope` ON `verification_run` (`code_version_id`,`runtime_fingerprint`);--> statement-breakpoint
CREATE INDEX `verification_run_execution` ON `verification_run` (`execution_id`);--> statement-breakpoint
-- FEAT-107, hand-added: SQLite's 12-step rebuild ends with a foreign_key_check. A CHECK on a temporary table turns any orphaned row into a failed statement, so the migrator rolls the whole migration back instead of committing a broken graph.
CREATE TEMP TABLE `__fk_guard_0005` (`orphans` integer NOT NULL CHECK(`orphans` = 0));--> statement-breakpoint
INSERT INTO `__fk_guard_0005` (`orphans`) SELECT count(*) FROM pragma_foreign_key_check;--> statement-breakpoint
DROP TABLE `__fk_guard_0005`;
