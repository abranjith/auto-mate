CREATE TABLE `artifact` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`task_id` integer NOT NULL,
	`script_run_id` integer NOT NULL,
	`filename` text NOT NULL,
	`file_path` text NOT NULL,
	`type` text NOT NULL,
	`extension` text NOT NULL,
	`mime_type` text NOT NULL,
	`render_mode` text NOT NULL,
	`declared` integer DEFAULT true NOT NULL,
	`title` text,
	`description` text,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`content_scan` text,
	`registered_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_artifact_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_artifact_task_id_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_artifact_script_run_id_script_run_id_fk` FOREIGN KEY (`script_run_id`) REFERENCES `script_run`(`id`) ON DELETE CASCADE,
	CONSTRAINT "artifact_type_check" CHECK("type" in ('csv','xlsx','json','text','markdown','html','plotly-html','image','pdf')),
	CONSTRAINT "artifact_render_mode_check" CHECK("render_mode" in ('table','image','markdown','text','sandboxed_html','sandboxed_pdf','download_only')),
	CONSTRAINT "artifact_byte_size_check" CHECK("byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `conversation_event_kind` (
	`kind` text PRIMARY KEY,
	`owner` text NOT NULL,
	`added_in` text NOT NULL,
	CONSTRAINT "conversation_event_kind_owner_check" CHECK("owner" in ('agent','app'))
);
--> statement-breakpoint
-- Seeded BEFORE the conversation_event copy so the new foreign key is satisfiable. Must equal CONVERSATION_EVENT_KINDS in packages/core.
INSERT INTO `conversation_event_kind` (`kind`, `owner`, `added_in`) VALUES
	('user_prompt', 'app', 'FEAT-103'),
	('state_changed', 'app', 'FEAT-103'),
	('tool_started', 'agent', 'FEAT-103'),
	('tool_finished', 'agent', 'FEAT-103'),
	('assistant_text', 'agent', 'FEAT-103'),
	('turn_finished', 'agent', 'FEAT-103'),
	('failed', 'agent', 'FEAT-103'),
	('clarification_requested', 'app', 'FEAT-105'),
	('clarification_answered', 'app', 'FEAT-105'),
	('disclosure_sent', 'app', 'FEAT-105'),
	('code_version_sealed', 'app', 'FEAT-106'),
	('test_run_finished', 'app', 'FEAT-106'),
	('generation_settled', 'app', 'FEAT-106'),
	('verification_finished', 'app', 'FEAT-107'),
	('approval_decided', 'app', 'FEAT-107'),
	('run_finished', 'app', 'FEAT-107'),
	('review_decided', 'app', 'FEAT-107'),
	('runtime_prepared', 'app', 'FEAT-108'),
	('artifacts_registered', 'app', 'FEAT-109');--> statement-breakpoint
ALTER TABLE `script_run` ADD `artifact_count` integer;--> statement-breakpoint
ALTER TABLE `script_run` ADD `unregistered_output_count` integer;--> statement-breakpoint
-- Foreign keys are disabled by migrateDatabase before the migrator's transaction (a PRAGMA here is a no-op inside it).
-- conversation_event's fifth and LAST structural rebuild: its kind CHECK becomes a foreign key to conversation_event_kind.
CREATE TABLE `__new_conversation_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`at` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_conversation_event_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversation_event_kind_conversation_event_kind_kind_fk` FOREIGN KEY (`kind`) REFERENCES `conversation_event_kind`(`kind`)
);
--> statement-breakpoint
INSERT INTO `__new_conversation_event`(`id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at`) SELECT `id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at` FROM `conversation_event`;--> statement-breakpoint
DROP TABLE `conversation_event`;--> statement-breakpoint
ALTER TABLE `__new_conversation_event` RENAME TO `conversation_event`;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_event_execution_seq` ON `conversation_event` (`execution_id`,`seq`);--> statement-breakpoint
CREATE INDEX `artifact_execution` ON `artifact` (`execution_id`);--> statement-breakpoint
CREATE INDEX `artifact_task` ON `artifact` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_run_filename` ON `artifact` (`script_run_id`,`filename`);--> statement-breakpoint
CREATE TEMP TABLE `__fk_guard_0007` (`orphans` integer NOT NULL CHECK(`orphans` = 0));--> statement-breakpoint
INSERT INTO `__fk_guard_0007` (`orphans`) SELECT count(*) FROM pragma_foreign_key_check;--> statement-breakpoint
DROP TABLE `__fk_guard_0007`;
