import { sql } from 'drizzle-orm';
import {
  check,
  index,
  type AnySQLiteColumn,
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
    /** The run this one was started from by a guidance retry (FEAT-106). SET NULL: deleting a failed run never deletes its replacement. */
    retryOfExecutionId: integer('retry_of_execution_id').references((): AnySQLiteColumn => execution.id, { onDelete: 'set null' }),
    /** The person's free-text hint that seeded this run. User input: it reaches the provider only as the user_prompt source. */
    guidance: text('guidance'),
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
    index('execution_retry_of').on(table.retryOfExecutionId).where(sql`${table.retryOfExecutionId} is not null`),
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
      sql`${table.kind} in ('user_prompt','state_changed','tool_started','tool_finished','assistant_text','turn_finished','failed','clarification_requested','clarification_answered','disclosure_sent','code_version_sealed','test_run_finished','generation_settled')`,
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

/**
 * One candidate script, sealed and immutable (FEAT-106). `content_digest` is
 * the identity FEAT-107 binds verification to and FEAT-108 executes; a draft
 * has none, and every sealed status forbids any change to its files.
 */
export const codeVersion = sqliteTable(
  'code_version',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: integer('execution_id').notNull().references(() => execution.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull().default('draft'),
    contentDigest: text('content_digest'),
    /** Relative to the data root: `scripts/{executionId}/attempt-{n}`. */
    dirPath: text('dir_path').notNull(),
    entrypoint: text('entrypoint').notNull().default('main.py'),
    isFinal: integer('is_final', { mode: 'boolean' }).notNull().default(false),
    /** Recorded, never enforced: a final version whose tests failed is a legal state that FEAT-107 judges. */
    testsPassed: integer('tests_passed', { mode: 'boolean' }),
    declaredInputs: text('declared_inputs'),
    declaredOutputs: text('declared_outputs'),
    /** The agent's own description. Model output, therefore untrusted input to the DOM. */
    summary: text('summary'),
    sealedAt: integer('sealed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('code_version_status_check', sql`${table.status} in ('draft','sealed','tested_pass','tested_fail','superseded')`),
    check('code_version_attempt_check', sql`${table.attempt} >= 1`),
    // Sealed-ness is one fact, not two fields that can disagree.
    check('code_version_sealed_check', sql`(${table.status} = 'draft' and ${table.contentDigest} is null and ${table.sealedAt} is null) or (${table.status} != 'draft' and ${table.contentDigest} is not null and ${table.sealedAt} is not null)`),
    uniqueIndex('code_version_attempt').on(table.executionId, table.attempt),
    uniqueIndex('code_version_final').on(table.executionId).where(sql`${table.isFinal} = 1`),
    uniqueIndex('code_version_draft').on(table.executionId).where(sql`${table.status} = 'draft'`),
    index('code_version_digest').on(table.contentDigest),
  ],
);

/** One file of one version: the authoritative copy. The file on disk is a projection written by the application. */
export const codeFile = sqliteTable(
  'code_file',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    codeVersionId: integer('code_version_id').notNull().references(() => codeVersion.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('code_file_role_check', sql`${table.role} in ('script','test','support')`),
    check('code_file_byte_size_check', sql`${table.byteSize} >= 0`),
    uniqueIndex('code_file_path').on(table.codeVersionId, table.path),
  ],
);

/**
 * One `run_tests` invocation and its outcome (FEAT-106). This table IS the
 * attempt limit: the cap is a COUNT over it, read from the database, so a
 * restart cannot hand the model a fresh budget.
 */
export const generationAttempt = sqliteTable(
  'generation_attempt',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: integer('execution_id').notNull().references(() => execution.id, { onDelete: 'cascade' }),
    codeVersionId: integer('code_version_id').references(() => codeVersion.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    callId: text('call_id'),
    status: text('status').notNull().default('running'),
    refusalReason: text('refusal_reason'),
    testsTotal: integer('tests_total'),
    testsPassed: integer('tests_passed'),
    testsFailed: integer('tests_failed'),
    exitCode: integer('exit_code'),
    manifestPresent: integer('manifest_present', { mode: 'boolean' }),
    /** SHA-256 of the FILTERED text handed back to the agent; the text itself lives once, in its transmission receipt. */
    diagnosticDigest: text('diagnostic_digest'),
    droppedLineCount: integer('dropped_line_count'),
    durationMs: integer('duration_ms'),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    settledAt: integer('settled_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('generation_attempt_status_check', sql`${table.status} in ('running','passed','failed','errored','timed_out','aborted','refused')`),
    check('generation_attempt_refusal_check', sql`${table.refusalReason} is null or ${table.refusalReason} in ('attempt_limit','time_limit','cost_limit','diagnostics_not_granted','runtime_unavailable')`),
    check('generation_attempt_refused_check', sql`(${table.status} = 'refused') = (${table.refusalReason} is not null)`),
    check('generation_attempt_attempt_check', sql`${table.attempt} >= 1`),
    uniqueIndex('generation_attempt_number').on(table.executionId, table.attempt),
    uniqueIndex('generation_attempt_version').on(table.codeVersionId).where(sql`${table.codeVersionId} is not null`),
    uniqueIndex('generation_attempt_call').on(table.callId).where(sql`${table.callId} is not null`),
  ],
);

/** The synthetic stand-in data one execution's tests ran against (FEAT-106). Never the real file. */
export const syntheticFixture = sqliteTable(
  'synthetic_fixture',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: integer('execution_id').notNull().references(() => execution.id, { onDelete: 'cascade' }),
    uploadId: integer('upload_id').notNull().references(() => upload.id, { onDelete: 'cascade' }),
    /** Relative: `scripts/{executionId}/fixtures/<stored_filename>`, the real upload's name by design. */
    filePath: text('file_path').notNull(),
    format: text('format').notNull(),
    sheetCount: integer('sheet_count').notNull().default(1),
    rowCount: integer('row_count').notNull(),
    sampleRowCount: integer('sample_row_count').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    seed: text('seed').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('synthetic_fixture_format_check', sql`${table.format} in ('csv','xlsx')`),
    check('synthetic_fixture_byte_size_check', sql`${table.byteSize} >= 0`),
    uniqueIndex('synthetic_fixture_upload').on(table.executionId, table.uploadId),
  ],
);
