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
    /** The person's words on what was wrong with a reviewed result (FEAT-107). User input: it reaches the provider only as the user_prompt source of the feedback retry. */
    reviewFeedback: text('review_feedback'),
    /** When a person accepted or rejected the result (FEAT-107). */
    reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check(
      'execution_status_check',
      sql`${table.status} in ('pending','generating','verifying','awaiting_approval','executing','awaiting_review','waiting','completed','failed','aborted','rejected')`,
    ),
    check(
      'execution_trigger_check',
      sql`${table.trigger} in ('manual','rerun','feedback')`,
    ),
    index('execution_task_id').on(table.taskId),
    index('execution_active')
      .on(table.status)
      .where(
        sql`${table.status} in ('pending','generating','verifying','executing','waiting')`,
      ),
    // Two questions, two indexes: `execution_active` is what a restart interrupts; `execution_parked` is what waits on a person and survives one.
    index('execution_parked').on(table.status).where(sql`${table.status} in ('awaiting_approval','awaiting_review')`),
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
      sql`${table.kind} in ('user_prompt','state_changed','tool_started','tool_finished','assistant_text','turn_finished','failed','clarification_requested','clarification_answered','disclosure_sent','code_version_sealed','test_run_finished','generation_settled','verification_finished','approval_decided','run_finished','review_decided','runtime_prepared')`,
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

/**
 * One independent check pass over one sealed code version on one runtime
 * (FEAT-107). This row answers "what was checked, and what does it apply to?":
 * `content_digest` is a deliberate denormalized copy of the bytes checked and
 * `runtime_fingerprint` the runtime they were checked on. The unique index is
 * the schema-level statement of plan §6 — one result per code and runtime.
 */
export const verificationRun = sqliteTable(
  'verification_run',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: integer('execution_id').notNull().references(() => execution.id, { onDelete: 'cascade' }),
    codeVersionId: integer('code_version_id').notNull().references(() => codeVersion.id, { onDelete: 'cascade' }),
    contentDigest: text('content_digest').notNull(),
    runtimeFingerprint: text('runtime_fingerprint').notNull(),
    /** The JSON the fingerprint was computed from, so a change can be named rather than hashed. */
    runtimeDetail: text('runtime_detail').notNull(),
    status: text('status').notNull().default('running'),
    blockingCount: integer('blocking_count').notNull().default(0),
    advisoryCount: integer('advisory_count').notNull().default(0),
    summary: text('summary'),
    durationMs: integer('duration_ms'),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    settledAt: integer('settled_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('verification_run_status_check', sql`${table.status} in ('running','passed','failed','errored','timed_out','aborted')`),
    check('verification_run_counts_check', sql`${table.blockingCount} >= 0 and ${table.advisoryCount} >= 0`),
    // Settled-ness is one fact, not two fields that can disagree.
    check('verification_run_settled_check', sql`(${table.status} = 'running' and ${table.settledAt} is null) or (${table.status} != 'running' and ${table.settledAt} is not null)`),
    uniqueIndex('verification_run_scope').on(table.codeVersionId, table.runtimeFingerprint),
    index('verification_run_execution').on(table.executionId),
  ],
);

/** One check within a pass. Every key appears on every settled pass: an absent row and a passed check must never look alike. */
export const verificationCheck = sqliteTable(
  'verification_check',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    verificationRunId: integer('verification_run_id').notNull().references(() => verificationRun.id, { onDelete: 'cascade' }),
    checkKey: text('check_key').notNull(),
    status: text('status').notNull(),
    /** Resolved from the gate policy at write time, so a later policy change never rewrites why a run was allowed. */
    isBlocking: integer('is_blocking', { mode: 'boolean' }).notNull(),
    summary: text('summary').notNull(),
    detail: text('detail'),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('verification_check_key_check', sql`${table.checkKey} in ('integrity','contract_entrypoint','contract_inputs','contract_outputs','lint','security','tests')`),
    check('verification_check_status_check', sql`${table.status} in ('passed','failed','skipped','errored')`),
    uniqueIndex('verification_check_key').on(table.verificationRunId, table.checkKey),
  ],
);

/** One concrete thing a check found. `message` is tool output about model-written code: untrusted input to the DOM. */
export const verificationFinding = sqliteTable(
  'verification_finding',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    checkId: integer('check_id').notNull().references(() => verificationCheck.id, { onDelete: 'cascade' }),
    ruleCode: text('rule_code').notNull(),
    severity: text('severity').notNull(),
    confidence: text('confidence'),
    /** Relative to the version directory, never absolute. */
    filePath: text('file_path'),
    line: integer('line'),
    column: integer('column'),
    message: text('message').notNull(),
    isBlocking: integer('is_blocking', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('verification_finding_severity_check', sql`${table.severity} in ('high','medium','low','info')`),
    check('verification_finding_confidence_check', sql`${table.confidence} is null or ${table.confidence} in ('high','medium','low')`),
    index('verification_finding_check').on(table.checkId),
    index('verification_finding_blocking').on(table.checkId).where(sql`${table.isBlocking} = 1`),
  ],
);

/**
 * A person's pre-run authorization (FEAT-107): the row that makes the gate a
 * fact rather than a screen. It binds to the code digest, the runtime
 * fingerprint, and the digest of the exact intent displayed.
 */
export const executionApproval = sqliteTable(
  'execution_approval',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: integer('execution_id').notNull().references(() => execution.id, { onDelete: 'cascade' }),
    codeVersionId: integer('code_version_id').notNull().references(() => codeVersion.id, { onDelete: 'cascade' }),
    verificationRunId: integer('verification_run_id').notNull().references(() => verificationRun.id, { onDelete: 'cascade' }),
    contentDigest: text('content_digest').notNull(),
    runtimeFingerprint: text('runtime_fingerprint').notNull(),
    intentDigest: text('intent_digest').notNull(),
    decision: text('decision').notNull(),
    acknowledgedWarnings: integer('acknowledged_warnings', { mode: 'boolean' }).notNull().default(false),
    decidedAt: integer('decided_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('execution_approval_decision_check', sql`${table.decision} in ('approved','cancelled')`),
    // One authorization per execution, so "who said this could run?" has exactly one answer.
    uniqueIndex('execution_approval_granted').on(table.executionId).where(sql`${table.decision} = 'approved'`),
    index('execution_approval_execution').on(table.executionId),
  ],
);

/**
 * The real-data run (FEAT-107). `approval_id` NOT NULL is the gate at the
 * schema level: a run row cannot exist without the approval that authorized
 * it. `stdout`/`stderr` may contain values from the person's real file —
 * stored per memory's logging rule, never logged, and never put in a prompt
 * except through FEAT-105's `recordDiagnosticTransmission`.
 */
export const scriptRun = sqliteTable(
  'script_run',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: integer('execution_id').notNull().references(() => execution.id, { onDelete: 'cascade' }),
    codeVersionId: integer('code_version_id').notNull().references(() => codeVersion.id, { onDelete: 'cascade' }),
    approvalId: integer('approval_id').notNull().references(() => executionApproval.id, { onDelete: 'cascade' }),
    contentDigest: text('content_digest').notNull(),
    /** Re-probed immediately before the run, never copied from the approval. */
    runtimeFingerprint: text('runtime_fingerprint').notNull(),
    /** Relative to the data root: `runs/{executionId}`. */
    dirPath: text('dir_path').notNull(),
    inputManifest: text('input_manifest').notNull(),
    status: text('status').notNull().default('running'),
    exitCode: integer('exit_code'),
    stdout: text('stdout'),
    stderr: text('stderr'),
    outputTruncated: integer('output_truncated', { mode: 'boolean' }).notNull().default(false),
    manifestPresent: integer('manifest_present', { mode: 'boolean' }),
    /** The verbatim declaration the script wrote. Generated-code output: untrusted. */
    manifestJson: text('manifest_json'),
    declaredOutputCount: integer('declared_output_count'),
    producedOutputCount: integer('produced_output_count'),
    outputByteCount: integer('output_byte_count'),
    limitBreached: text('limit_breached'),
    runtimeLockDigest: text('runtime_lock_digest'),
    durationMs: integer('duration_ms'),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    settledAt: integer('settled_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check('script_run_status_check', sql`${table.status} in ('running','succeeded','failed','errored','timed_out','aborted')`),
    check('script_run_settled_check', sql`(${table.status} = 'running' and ${table.settledAt} is null) or (${table.status} != 'running' and ${table.settledAt} is not null)`),
    check('script_run_limit_breached_check', sql`${table.limitBreached} is null or ${table.limitBreached} in ('time','memory','output_bytes','output_files')`),
    check('script_run_time_status_check', sql`${table.limitBreached} is not 'time' or ${table.status} = 'timed_out'`),
    uniqueIndex('script_run_execution').on(table.executionId),
  ],
);

/** One prepared, fingerprinted runtime scope. Historical rows survive task deletion. */
export const runtimeEnvironment = sqliteTable('runtime_environment', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  specDigest: text('spec_digest').notNull(),
  lockDigest: text('lock_digest').notNull(),
  pythonVersion: text('python_version').notNull(),
  uvVersion: text('uv_version').notNull(),
  platform: text('platform').notNull(),
  arch: text('arch').notNull(),
  status: text('status').notNull().default('preparing'),
  fingerprint: text('fingerprint'),
  packageJson: text('package_json'),
  launcherDigest: text('launcher_digest'),
  failureReason: text('failure_reason'),
  durationMs: integer('duration_ms'),
  preparedAt: integer('prepared_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  check('runtime_environment_kind_check', sql`${table.kind} in ('script','verify')`),
  check('runtime_environment_status_check', sql`${table.status} in ('preparing','ready','failed','aborted')`),
  check('runtime_environment_settled_check', sql`(${table.status} = 'preparing' and ${table.preparedAt} is null) or (${table.status} != 'preparing' and ${table.preparedAt} is not null)`),
  check('runtime_environment_ready_check', sql`(${table.status} = 'ready' and ${table.fingerprint} is not null and ${table.packageJson} is not null) or (${table.status} != 'ready' and ${table.fingerprint} is null and ${table.packageJson} is null)`),
  uniqueIndex('runtime_environment_scope').on(table.kind, table.specDigest, table.lockDigest, table.platform, table.arch),
  index('runtime_environment_fingerprint').on(table.fingerprint),
  index('runtime_environment_ready').on(table.kind).where(sql`${table.status} = 'ready'`),
]);
