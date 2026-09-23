CREATE TABLE `conversation_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`execution_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`at` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_conversation_event_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE,
	CONSTRAINT "conversation_event_kind_check" CHECK("kind" in ('user_prompt','state_changed','tool_started','tool_finished','assistant_text','turn_finished','failed'))
);
--> statement-breakpoint
CREATE TABLE `execution` (
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_execution_task_id_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON DELETE CASCADE,
	CONSTRAINT "execution_status_check" CHECK("status" in ('pending','generating','verifying','executing','waiting','completed','failed','aborted')),
	CONSTRAINT "execution_trigger_check" CHECK("trigger" in ('manual','rerun'))
);
--> statement-breakpoint
CREATE TABLE `task` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "task_description_not_blank" CHECK(length(trim("description")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_event_execution_seq` ON `conversation_event` (`execution_id`,`seq`);--> statement-breakpoint
CREATE INDEX `execution_task_id` ON `execution` (`task_id`);--> statement-breakpoint
CREATE INDEX `execution_active` ON `execution` (`status`) WHERE "execution"."status" in ('pending','generating','verifying','executing','waiting');