import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Application-level metadata; domain tables are owned by later features. */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey().notNull(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** A user's durable plain-language task definition. */
export const task = sqliteTable(
  'task',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check(
      'task_description_not_blank',
      sql`length(trim(${table.description})) > 0`,
    ),
  ],
);

/** One stateful run of a task. */
export const execution = sqliteTable(
  'execution',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    trigger: text('trigger').notNull().default('manual'),
    agentSessionId: text('agent_session_id'),
    agentLogPath: text('agent_log_path'),
    provider: text('provider'),
    model: text('model'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    usageTurns: integer('usage_turns'),
    usageInputTokens: integer('usage_input_tokens'),
    usageOutputTokens: integer('usage_output_tokens'),
    usageCostUsd: real('usage_cost_usd'),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check(
      'execution_status_check',
      sql`${table.status} in ('pending','generating','verifying','executing','waiting','completed','failed','aborted')`,
    ),
    check(
      'execution_trigger_check',
      sql`${table.trigger} in ('manual','rerun')`,
    ),
    index('execution_task_id').on(table.taskId),
    index('execution_active')
      .on(table.status)
      .where(
        sql`${table.status} in ('pending','generating','verifying','executing','waiting')`,
      ),
  ],
);

/** Append-only transcript row, ordered independently for every execution. */
export const conversationEvent = sqliteTable(
  'conversation_event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: integer('execution_id')
      .notNull()
      .references(() => execution.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    at: text('at').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check(
      'conversation_event_kind_check',
      sql`${table.kind} in ('user_prompt','state_changed','tool_started','tool_finished','assistant_text','turn_finished','failed')`,
    ),
    uniqueIndex('conversation_event_execution_seq').on(
      table.executionId,
      table.seq,
    ),
  ],
);
