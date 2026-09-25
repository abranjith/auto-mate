CREATE TABLE `clarification` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`source` text NOT NULL,
	`call_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decline_reason` text,
	`asked_at` integer DEFAULT (unixepoch()) NOT NULL,
	`settled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_clarification_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT "clarification_source_check" CHECK("source" in ('preflight','agent')),
	CONSTRAINT "clarification_status_check" CHECK("status" in ('pending','answered','declined','cancelled','interrupted')),
	CONSTRAINT "clarification_decline_reason_check" CHECK("decline_reason" is null or "decline_reason" in ('question_limit','waiting_capacity'))
);
--> statement-breakpoint
CREATE TABLE `clarification_question` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`clarification_id` integer NOT NULL,
	`position` integer NOT NULL,
	`finding_key` text,
	`impact` text NOT NULL,
	`prompt_text` text NOT NULL,
	`rationale` text NOT NULL,
	`options` text,
	`proposed_default` text NOT NULL,
	`answer` text,
	`answer_source` text,
	`answered_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_clarification_question_clarification_id_clarification_id_fk` FOREIGN KEY (`clarification_id`) REFERENCES `clarification`(`id`) ON DELETE CASCADE,
	CONSTRAINT "clarification_question_impact_check" CHECK("impact" in ('data_loss','meaning')),
	CONSTRAINT "clarification_question_answer_source_check" CHECK("answer_source" is null or "answer_source" in ('user','default','seeded'))
);
--> statement-breakpoint
CREATE TABLE `disclosure_consent` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` integer,
	`upload_ids` text NOT NULL,
	`payload_digest` text NOT NULL,
	`payload_snapshot` text NOT NULL,
	`byte_size` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`scope_context` integer DEFAULT true NOT NULL,
	`scope_diagnostics` integer DEFAULT false NOT NULL,
	`granted_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_disclosure_consent_task_id_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON DELETE CASCADE,
	CONSTRAINT "disclosure_consent_byte_size_check" CHECK("byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `disclosure_transmission` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`consent_id` integer NOT NULL,
	`kind` text NOT NULL,
	`payload_digest` text NOT NULL,
	`payload_snapshot` text,
	`byte_size` integer NOT NULL,
	`summary` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_disclosure_transmission_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_disclosure_transmission_consent_id_disclosure_consent_id_fk` FOREIGN KEY (`consent_id`) REFERENCES `disclosure_consent`(`id`) ON DELETE CASCADE,
	CONSTRAINT "disclosure_transmission_kind_check" CHECK("kind" in ('context','diagnostics')),
	CONSTRAINT "disclosure_transmission_byte_size_check" CHECK("byte_size" >= 0),
	CONSTRAINT "disclosure_transmission_snapshot_check" CHECK(("kind" = 'context' and "payload_snapshot" is null) or ("kind" = 'diagnostics' and "payload_snapshot" is not null))
);
--> statement-breakpoint
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
	CONSTRAINT "conversation_event_kind_check" CHECK("kind" in ('user_prompt','state_changed','tool_started','tool_finished','assistant_text','turn_finished','failed','clarification_requested','clarification_answered','disclosure_sent'))
);
--> statement-breakpoint
INSERT INTO `__new_conversation_event`(`id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at`) SELECT `id`, `execution_id`, `seq`, `kind`, `payload`, `at`, `created_at` FROM `conversation_event`;--> statement-breakpoint
DROP TABLE `conversation_event`;--> statement-breakpoint
ALTER TABLE `__new_conversation_event` RENAME TO `conversation_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_event_execution_seq` ON `conversation_event` (`execution_id`,`seq`);--> statement-breakpoint
CREATE INDEX `clarification_execution` ON `clarification` (`execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `clarification_call` ON `clarification` (`call_id`) WHERE "clarification"."call_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `clarification_question_position` ON `clarification_question` (`clarification_id`,`position`);--> statement-breakpoint
CREATE INDEX `clarification_question_finding` ON `clarification_question` (`finding_key`) WHERE "clarification_question"."finding_key" is not null;--> statement-breakpoint
CREATE INDEX `disclosure_consent_task` ON `disclosure_consent` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `disclosure_consent_digest` ON `disclosure_consent` (`task_id`,`payload_digest`,`provider`,`model`) WHERE "disclosure_consent"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `disclosure_transmission_execution` ON `disclosure_transmission` (`execution_id`);