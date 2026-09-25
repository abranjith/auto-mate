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
      sql`${table.kind} in ('user_prompt','state_changed','tool_started','tool_finished','assistant_text','turn_finished','failed','clarification_requested','clarification_answered','disclosure_sent')`,
    ),
    uniqueIndex('conversation_event_execution_seq').on(
      table.executionId,
      table.seq,
    ),
  ],
);

/**
 * One uploaded input file (FEAT-104). Created when its bytes land in
 * `uploads/staged/`; `task_id` is set when a task claims it. The original
 * bytes are kept for the life of the task (D12). `original_filename` is a
 * display label only and never builds a path.
 */
export const upload = sqliteTable(
  'upload',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').references(() => task.id, { onDelete: 'cascade' }),
    originalFilename: text('original_filename').notNull(),
    storedFilename: text('stored_filename').notNull(),
    filePath: text('file_path').notNull(),
    format: text('format').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    encoding: text('encoding'),
    profileStatus: text('profile_status').notNull().default('pending'),
    profileErrorCode: text('profile_error_code'),
    profileErrorMessage: text('profile_error_message'),
    profileDurationMs: integer('profile_duration_ms'),
    stagedAt: integer('staged_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    attachedAt: integer('attached_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check('upload_format_check', sql`${table.format} in ('csv','xlsx')`),
    check(
      'upload_profile_status_check',
      sql`${table.profileStatus} in ('pending','profiling','profiled','failed')`,
    ),
    check('upload_byte_size_check', sql`${table.byteSize} >= 0`),
    index('upload_task_id').on(table.taskId),
    index('upload_staged')
      .on(table.stagedAt)
      .where(sql`${table.taskId} is null`),
  ],
);

/** One profiled table: the whole of a CSV, or one worksheet of a workbook. */
export const uploadProfile = sqliteTable(
  'upload_profile',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    uploadId: integer('upload_id')
      .notNull()
      .references(() => upload.id, { onDelete: 'cascade' }),
    sheetName: text('sheet_name'),
    sheetIndex: integer('sheet_index').notNull().default(0),
    isHidden: integer('is_hidden', { mode: 'boolean' }).notNull().default(false),
    rowCount: integer('row_count').notNull(),
    rowCountExact: integer('row_count_exact', { mode: 'boolean' })
      .notNull()
      .default(true),
    columnCount: integer('column_count').notNull(),
    hasHeader: integer('has_header', { mode: 'boolean' }).notNull(),
    headerRowIndex: integer('header_row_index'),
    delimiter: text('delimiter'),
    dialect: text('dialect'),
    raggedRowCount: integer('ragged_row_count').notNull().default(0),
    blankRowCount: integer('blank_row_count').notNull().default(0),
    mergedCellCount: integer('merged_cell_count').notNull().default(0),
    formulaCellCount: integer('formula_cell_count').notNull().default(0),
    sampleRows: text('sample_rows').notNull(),
    notes: text('notes').notNull().default('[]'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check('upload_profile_row_count_check', sql`${table.rowCount} >= 0`),
    uniqueIndex('upload_profile_sheet').on(table.uploadId, table.sheetIndex),
  ],
);

/** One column of one profiled table, promoted to rows so inputs can be compared by query. */
export const uploadColumn = sqliteTable(
  'upload_column',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => uploadProfile.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    originalName: text('original_name'),
    inferredType: text('inferred_type').notNull(),
    typeConfidence: real('type_confidence').notNull(),
    isMixedType: integer('is_mixed_type', { mode: 'boolean' })
      .notNull()
      .default(false),
    nullCount: integer('null_count').notNull().default(0),
    blankCount: integer('blank_count').notNull().default(0),
    valueCount: integer('value_count').notNull().default(0),
    distinctCount: integer('distinct_count'),
    isHighCardinality: integer('is_high_cardinality', { mode: 'boolean' })
      .notNull()
      .default(false),
    stats: text('stats'),
    topValues: text('top_values'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check(
      'upload_column_inferred_type_check',
      sql`${table.inferredType} in ('integer','decimal','boolean','date','datetime','string','empty')`,
    ),
    check(
      'upload_column_type_confidence_check',
      sql`${table.typeConfidence} between 0.0 and 1.0`,
    ),
    // D04 as a data constraint: a high-cardinality column holds no values to disclose.
    check(
      'upload_column_high_cardinality_check',
      sql`${table.isHighCardinality} = 0 or (${table.distinctCount} is null and ${table.topValues} is null)`,
    ),
    uniqueIndex('upload_column_position').on(table.profileId, table.position),
    index('upload_column_name').on(table.name),
  ],
);

/** One immutable approval of exact disclosure bytes and recipient. */
export const disclosureConsent = sqliteTable(
  'disclosure_consent',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').references(() => task.id, { onDelete: 'cascade' }),
    uploadIds: text('upload_ids').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    payloadSnapshot: text('payload_snapshot').notNull(),
    byteSize: integer('byte_size').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    scopeContext: integer('scope_context', { mode: 'boolean' }).notNull().default(true),
    scopeDiagnostics: integer('scope_diagnostics', { mode: 'boolean' }).notNull().default(false),
    grantedAt: integer('granted_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('disclosure_consent_byte_size_check', sql`${table.byteSize} >= 0`),
    index('disclosure_consent_task').on(table.taskId),
    uniqueIndex('disclosure_consent_digest').on(table.taskId, table.payloadDigest, table.provider, table.model).where(sql`${table.revokedAt} is null`),
  ],
);

/** Append-only proof of bytes authorized for a provider transmission. */
export const disclosureTransmission = sqliteTable(
  'disclosure_transmission',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: integer('execution_id').notNull().references(() => execution.id, { onDelete: 'cascade' }),
    consentId: integer('consent_id').notNull().references(() => disclosureConsent.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    payloadSnapshot: text('payload_snapshot'),
    byteSize: integer('byte_size').notNull(),
    summary: text('summary').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    at: integer('at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('disclosure_transmission_kind_check', sql`${table.kind} in ('context','diagnostics')`),
    check('disclosure_transmission_byte_size_check', sql`${table.byteSize} >= 0`),
    check('disclosure_transmission_snapshot_check', sql`(${table.kind} = 'context' and ${table.payloadSnapshot} is null) or (${table.kind} = 'diagnostics' and ${table.payloadSnapshot} is not null)`),
    index('disclosure_transmission_execution').on(table.executionId),
  ],
);

/** One pre-flight or agent-originated question batch. */
export const clarification = sqliteTable(
  'clarification',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: integer('execution_id').notNull().references(() => execution.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    callId: text('call_id'),
    status: text('status').notNull().default('pending'),
    declineReason: text('decline_reason'),
    askedAt: integer('asked_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    settledAt: integer('settled_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('clarification_source_check', sql`${table.source} in ('preflight','agent')`),
    check('clarification_status_check', sql`${table.status} in ('pending','answered','declined','cancelled','interrupted')`),
    check('clarification_decline_reason_check', sql`${table.declineReason} is null or ${table.declineReason} in ('question_limit','waiting_capacity')`),
    index('clarification_execution').on(table.executionId),
    uniqueIndex('clarification_call').on(table.callId).where(sql`${table.callId} is not null`),
  ],
);

/** One normalized clarification question and its durable answer. */
export const clarificationQuestion = sqliteTable(
  'clarification_question',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clarificationId: integer('clarification_id').notNull().references(() => clarification.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    findingKey: text('finding_key'),
    impact: text('impact').notNull(),
    promptText: text('prompt_text').notNull(),
    rationale: text('rationale').notNull(),
    options: text('options'),
    proposedDefault: text('proposed_default').notNull(),
    answer: text('answer'),
    answerSource: text('answer_source'),
    answeredAt: integer('answered_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('clarification_question_impact_check', sql`${table.impact} in ('data_loss','meaning')`),
    check('clarification_question_answer_source_check', sql`${table.answerSource} is null or ${table.answerSource} in ('user','default','seeded')`),
    uniqueIndex('clarification_question_position').on(table.clarificationId, table.position),
    index('clarification_question_finding').on(table.findingKey).where(sql`${table.findingKey} is not null`),
  ],
);
