import { describeLimitBreach, HISTORY_STATUS_GROUPS, RepositoryError, TERMINAL_STATUSES, type HistoryStatusGroup, type RunRecord, type RunTimelineItem, type RunTimelinePage, type TaskCounts, type TaskHistoryItem, type TaskHistoryPage } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { statusLiterals } from '../status-sql';

type SqlRow = Record<string, unknown>;
type PageOptions = { cursor?: number; limit: number };
type TaskOptions = PageOptions & { group?: HistoryStatusGroup | 'all'; q?: string };
const iso = (epoch: unknown): string | null => epoch === null || epoch === undefined ? null : new Date(Number(epoch) * 1000).toISOString();
const number = (value: unknown): number => Number(value ?? 0);
const text = (value: unknown): string => String(value ?? '');
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

/** Read-only projection of task history. No protected payload column is selected here. */
export class HistoryRepository {
  constructor(private readonly connection: DatabaseConnection) {}

  /** List each task once, sorted by its latest execution id. */
  listTasks(options: TaskOptions): TaskHistoryPage {
    return this.read(() => {
      const group = options.group ?? 'all';
      const where = ["not exists (select 1 from execution later where later.task_id = e.task_id and later.id > e.id)"];
      const args: (string | number)[] = [];
      if (options.cursor !== undefined) { where.push('e.id < ?'); args.push(options.cursor); }
      // Literal, not bound: only a literal list lets `needs_you` use the partial `execution_parked` index.
      if (group !== 'all') where.push(`e.status in (${statusLiterals(HISTORY_STATUS_GROUPS[group])})`);
      if (options.q?.trim()) { where.push("(t.name like ? escape '\\' or t.description like ? escape '\\')"); args.push(...Array(2).fill(`%${escapeLike(options.q.trim())}%`)); }
      const rows = this.all(`select e.id runId, e.status, e.trigger, e.created_at runCreatedAt, e.completed_at completedAt, e.duration_ms durationMs, e.error_code errorCode, t.id taskId, t.name, t.created_at taskCreatedAt, er.kind reuseKind, er.template_id templateId, er.template_name templateName, er.revision_number revisionNumber from execution e join task t on t.id = e.task_id left join execution_reuse er on er.execution_id = e.id where ${where.join(' and ')} order by e.id desc limit ?`, [...args, options.limit + 1]);
      const page = rows.slice(0, options.limit);
      const ids = page.map((row) => number(row.taskId));
      const runIds = page.map((row) => number(row.runId));
      const runCounts = this.grouped('execution', 'task_id', ids);
      const inputCounts = this.grouped('upload', 'task_id', ids);
      const outputCounts = this.grouped('artifact', 'execution_id', runIds);
      const statusTimes = this.statusTimes(runIds);
      const items = page.map((row) => presentTaskItem(row, runCounts, inputCounts, outputCounts, statusTimes));
      return { items, nextCursor: rows.length > options.limit ? String(items.at(-1)?.latestRun.id) : null, hasMore: rows.length > options.limit };
    });
  }

  /** Page tasks that have used this saved task, with one row per task. */
  listTemplateTasks(templateId: number, options: PageOptions): TaskHistoryPage {
    return this.read(() => {
      const rows = this.all(`select e.id runId, e.status, e.trigger, e.created_at runCreatedAt, e.completed_at completedAt, e.duration_ms durationMs, e.error_code errorCode, t.id taskId, t.name, t.created_at taskCreatedAt, er.kind reuseKind, er.template_id templateId, er.template_name templateName, er.revision_number revisionNumber from execution e join task t on t.id = e.task_id left join execution_reuse er on er.execution_id = e.id where exists (select 1 from execution_reuse r join execution re on re.id = r.execution_id where r.template_id = ? and re.task_id = t.id) and not exists (select 1 from execution later where later.task_id = e.task_id and later.id > e.id) ${options.cursor === undefined ? '' : 'and e.id < ?'} order by e.id desc limit ?`, [templateId, ...(options.cursor === undefined ? [] : [options.cursor]), options.limit + 1]);
      const page = rows.slice(0, options.limit);
      const taskIds = page.map((row) => number(row.taskId));
      const runIds = page.map((row) => number(row.runId));
      const runs = this.grouped('execution', 'task_id', taskIds);
      const inputs = this.grouped('upload', 'task_id', taskIds);
      const outputs = this.grouped('artifact', 'execution_id', runIds);
      const times = this.statusTimes(runIds);
      const items = page.map((row) => presentTaskItem(row, runs, inputs, outputs, times));
      return { items, nextCursor: rows.length > options.limit ? String(items.at(-1)?.latestRun.id) : null, hasMore: rows.length > options.limit };
    });
  }

  /** Page one task's runs in newest-first id order. */
  listRuns(taskId: number, options: PageOptions): RunTimelinePage {
    return this.read(() => {
      const rows = this.all(`select e.id, e.task_id taskId, e.status, e.trigger, e.retry_of_execution_id retryOfExecutionId, e.guidance, e.review_feedback reviewFeedback, e.created_at createdAt, e.completed_at completedAt, e.duration_ms durationMs, e.error_code errorCode, er.kind reuseKind, er.template_id templateId, er.template_name templateName, er.revision_number revisionNumber, (select count(*) from artifact a where a.execution_id = e.id) outputCount, ${RUN_NUMBER_SQL} runNumber from execution e left join execution_reuse er on er.execution_id = e.id where e.task_id = ? ${options.cursor === undefined ? '' : 'and e.id < ?'} order by e.id desc limit ?`, [taskId, ...(options.cursor === undefined ? [] : [options.cursor]), options.limit + 1]);
      const items: RunTimelineItem[] = rows.slice(0, options.limit).map((row) => ({
        id: number(row.id), taskId: number(row.taskId), runNumber: number(row.runNumber), status: text(row.status) as RunTimelineItem['status'], trigger: text(row.trigger) as RunTimelineItem['trigger'],
        retryOfExecutionId: row.retryOfExecutionId === null ? null : number(row.retryOfExecutionId), hasGuidance: row.guidance !== null, hasReviewFeedback: row.reviewFeedback !== null,
        createdAt: iso(row.createdAt)!, completedAt: iso(row.completedAt), durationMs: row.durationMs === null ? null : number(row.durationMs), errorCode: row.errorCode === null ? null : text(row.errorCode), outputCount: number(row.outputCount), reuse: reuseSummary(row),
      }));
      return { items, nextCursor: rows.length > options.limit ? String(items.at(-1)?.id) : null, hasMore: rows.length > options.limit };
    });
  }

  /** Counts used by the task detail and deletion confirmation. */
  taskCounts(taskId: number): TaskCounts {
    return this.read(() => {
      const row = this.one(`select (select count(*) from execution where task_id = ?) runs, (select count(*) from upload where task_id = ?) inputs, (select count(*) from artifact where task_id = ?) outputs, (select id from execution where task_id = ? and status not in (${statusLiterals(TERMINAL_STATUSES)}) order by id desc limit 1) openRunId`, [taskId, taskId, taskId, taskId]);
      const saved = this.all('select distinct tt.name name from template_revision tr join task_template tt on tt.id = tr.template_id join execution e on e.id = tr.source_execution_id where e.task_id = ? order by tt.id', [taskId]);
      return { runs: number(row?.runs), inputs: number(row?.inputs), outputs: number(row?.outputs), openRunId: row?.openRunId == null ? null : number(row.openRunId), savedAs: saved.map((item) => text(item.name)) };
    });
  }

  /** Build a summary record; owning feature routes retain the full detail. */
  getRunRecord(executionId: number): RunRecord | undefined {
    return this.read(() => {
      const e = this.one(`select id, task_id taskId, status, trigger, retry_of_execution_id retryOfExecutionId, guidance, review_feedback reviewFeedback, provider, model, error_code errorCode, error_message errorMessage, created_at createdAt, started_at startedAt, completed_at completedAt, duration_ms durationMs, as_of_at asOfAt, as_of_date asOfDate, as_of_timezone asOfTimezone, as_of_source asOfSource, ${RUN_NUMBER_SQL} runNumber from execution e where id = ?`, [executionId]);
      if (!e) return undefined;
      return this.recordSections(e);
    });
  }

  /** Return whether an execution row still exists, for the orphan sweep. */
  executionExists(id: number): boolean {
    return this.read(() => this.one('select id from execution where id = ?', [id]) !== undefined);
  }

  private recordSections(e: SqlRow): RunRecord {
    const id = number(e.id); const taskId = number(e.taskId);
    const runRef = (row: SqlRow) => ({ id: number(row.id), runNumber: number(row.runNumber) });
    const next = this.all(`select id, ${RUN_NUMBER_SQL} runNumber from execution e where retry_of_execution_id = ? order by id`, [id]).map(runRef);
    const previousRow = e.retryOfExecutionId === null ? undefined : this.one(`select id, ${RUN_NUMBER_SQL} runNumber from execution e where id = ?`, [number(e.retryOfExecutionId)]);
    const previous = previousRow ? runRef(previousRow) : null;
    const inputs = this.all('select id, original_filename originalFilename, format, byte_size byteSize, sha256 from upload where task_id = ? order by id', [taskId]).map((row) => ({ id: number(row.id), originalFilename: text(row.originalFilename), format: text(row.format), byteSize: number(row.byteSize), sha256: text(row.sha256) }));
    const sends = this.one('select count(*) sends, max(t.provider) provider, max(t.model) model, max(c.granted_at) grantedAt from disclosure_transmission t join disclosure_consent c on c.id = t.consent_id where t.execution_id = ?', [id]);
    const questions = this.one("select count(q.id) total, sum(q.answer_source is not null) answered, sum(q.answer_source = 'user') byPerson, sum(q.answer_source = 'seeded') seeded, sum(q.answer_source = 'default') defaulted, sum(c.status = 'declined') declined from clarification c join clarification_question q on q.clarification_id = c.id where c.execution_id = ?", [id]);
    const version = this.one('select id, attempt, content_digest digest, tests_passed testsPassed from code_version where execution_id = ? and is_final = 1 order by id desc limit 1', [id]);
    const attempts = this.one('select count(*) n from generation_attempt where execution_id = ?', [id]);
    const check = this.one('select status, blocking_count blockingCount, advisory_count advisoryCount, summary, runtime_detail runtimeDetail from verification_run where execution_id = ? order by id desc limit 1', [id]);
    const approval = this.one("select decided_at decidedAt, acknowledged_warnings acknowledgedWarnings from execution_approval where execution_id = ? and decision = 'approved' order by id desc limit 1", [id]);
    const run = this.one('select status, exit_code exitCode, duration_ms durationMs, limit_breached limitBreached, output_truncated outputTruncated, input_manifest inputManifest, declared_output_count declaredOutputCount, produced_output_count producedOutputCount, artifact_count artifactCount, unregistered_output_count unregisteredOutputCount from script_run where execution_id = ? order by id desc limit 1', [id]);
    const output = this.one('select count(*) n from artifact where execution_id = ?', [id]);
    const seq = this.one('select max(seq) n from conversation_event where execution_id = ?', [id]);
    const reuse = this.one('select kind reuseKind, template_id templateId, template_name templateName, revision_number revisionNumber, revision_digest revisionDigest, compatibility_report compatibilityReport, mapping from execution_reuse where execution_id = ?', [id]);
    return presentRecord(e, { previous, next, inputs, sends, questions, version, attempts, check, approval, run, output, seq, reuse });
  }

  private grouped(table: 'execution' | 'upload' | 'artifact', key: 'task_id' | 'execution_id', ids: number[]): Map<number, number> {
    const sql = `select ${key} k, count(*) n from ${table} where ${key} in (${ids.map(() => '?').join(',') || 'null'}) group by ${key}`;
    return new Map(this.all(sql, ids).map((row) => [number(row.k), number(row.n)]));
  }

  private statusTimes(ids: number[]): Map<number, string> {
    const sql = `select execution_id k, at from conversation_event where kind = 'state_changed' and execution_id in (${ids.map(() => '?').join(',') || 'null'}) and seq = (select max(seq) from conversation_event latest where latest.execution_id = conversation_event.execution_id and latest.kind = 'state_changed')`;
    return new Map(this.all(sql, ids).map((row) => [number(row.k), text(row.at)]));
  }

  private one(sql: string, args: (string | number)[]): SqlRow | undefined { return this.connection.client.prepare(sql).get(...args) as SqlRow | undefined; }
  private all(sql: string, args: (string | number)[]): SqlRow[] { return this.connection.client.prepare(sql).all(...args) as SqlRow[]; }
  private read<T>(action: () => T): T { try { return action(); } catch (cause) { if (cause instanceof RepositoryError) throw cause; throw new RepositoryError('History could not be read.', cause); } }
}

/** A run's 1-based position among its task's runs, oldest first. Correlated on the outer alias `e`; runs are removed only with their task, so the number never shifts. */
const RUN_NUMBER_SQL = '(select count(*) from execution earlier where earlier.task_id = e.task_id and earlier.id <= e.id)';

function presentTaskItem(row: SqlRow, runs: Map<number, number>, inputs: Map<number, number>, outputs: Map<number, number>, times: Map<number, string>): TaskHistoryItem {
  const taskId = number(row.taskId); const runId = number(row.runId);
  return { task: { id: taskId, name: text(row.name), createdAt: iso(row.taskCreatedAt)! }, latestRun: { id: runId, status: text(row.status) as TaskHistoryItem['latestRun']['status'], trigger: text(row.trigger) as TaskHistoryItem['latestRun']['trigger'], createdAt: iso(row.runCreatedAt)!, completedAt: iso(row.completedAt), durationMs: row.durationMs === null ? null : number(row.durationMs), errorCode: row.errorCode === null ? null : text(row.errorCode), statusSince: times.get(runId) ?? null, reuse: reuseSummary(row) }, runCount: runs.get(taskId) ?? 0, inputCount: inputs.get(taskId) ?? 0, latestOutputCount: outputs.get(runId) ?? 0 };
}

function reuseSummary(row: SqlRow): TaskHistoryItem['latestRun']['reuse'] {
  if (row.reuseKind === null || row.reuseKind === undefined) return null;
  return { kind: text(row.reuseKind) as 'run' | 'replay' | 'repair', templateId: row.templateId === null ? null : number(row.templateId), templateName: text(row.templateName), revisionNumber: number(row.revisionNumber) };
}

type Sections = { previous: RunRecord['chain']['previous']; next: RunRecord['chain']['next']; inputs: RunRecord['inputs']; sends?: SqlRow; questions?: SqlRow; version?: SqlRow; attempts?: SqlRow; check?: SqlRow; approval?: SqlRow; run?: SqlRow; output?: SqlRow; seq?: SqlRow; reuse?: SqlRow };
function runtimeLine(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try { const value = JSON.parse(raw) as { pythonVersion?: string; platform?: string; packages?: unknown[] }; return `Python ${value.pythonVersion ?? '?'} on ${value.platform ?? '?'} · ${value.packages?.length ?? 0} packages`; } catch { return null; }
}
function inputsMatch(raw: unknown, inputs: RunRecord['inputs']): boolean {
  if (typeof raw !== 'string') return false;
  try { const manifest = JSON.parse(raw) as { uploadId: number; sha256: string }[]; return manifest.length === inputs.length && manifest.every((entry) => inputs.some((input) => input.id === entry.uploadId && input.sha256 === entry.sha256)); } catch { return false; }
}
function presentRecord(e: SqlRow, s: Sections): RunRecord {
  const v = s.version; const c = s.check; const r = s.run; const a = s.approval;
  return {
    execution: { id: number(e.id), taskId: number(e.taskId), runNumber: number(e.runNumber), status: text(e.status) as RunRecord['execution']['status'], trigger: text(e.trigger) as RunRecord['execution']['trigger'], retryOfExecutionId: e.retryOfExecutionId === null ? null : number(e.retryOfExecutionId), provider: e.provider === null ? null : text(e.provider), model: e.model === null ? null : text(e.model), createdAt: iso(e.createdAt)!, startedAt: iso(e.startedAt), completedAt: iso(e.completedAt), durationMs: e.durationMs === null ? null : number(e.durationMs), errorCode: e.errorCode === null ? null : text(e.errorCode), errorMessage: e.errorMessage === null ? null : text(e.errorMessage) },
    personWords: { guidance: e.guidance === null ? null : text(e.guidance), reviewFeedback: e.reviewFeedback === null ? null : text(e.reviewFeedback) },
    chain: { previous: s.previous, next: s.next }, inputs: s.inputs,
    inputsReadByRun: r ? inputsMatch(r.inputManifest, s.inputs) : null,
    disclosure: number(s.sends?.sends) > 0 ? { provider: s.sends?.provider == null ? null : text(s.sends.provider), model: s.sends?.model == null ? null : text(s.sends.model), sendCount: number(s.sends?.sends), grantedAt: iso(s.sends?.grantedAt) } : null,
    questions: number(s.questions?.total) > 0 ? { total: number(s.questions?.total), answered: number(s.questions?.answered), byPerson: number(s.questions?.byPerson), seeded: number(s.questions?.seeded), defaulted: number(s.questions?.defaulted), declined: number(s.questions?.declined) } : null,
    code: v ? { id: number(v.id), attempt: number(v.attempt), digest: text(v.digest), shortDigest: text(v.digest).slice(0, 12), testsPassed: v.testsPassed === null ? null : Boolean(v.testsPassed), attemptCount: number(s.attempts?.n) } : null,
    checks: c ? { status: text(c.status), blockingCount: number(c.blockingCount), advisoryCount: number(c.advisoryCount), summary: text(c.summary), runtime: runtimeLine(c.runtimeDetail) } : null,
    approval: a ? { decidedAt: iso(a.decidedAt)!, acknowledgedWarnings: Boolean(a.acknowledgedWarnings) } : null,
    scriptRun: r ? { status: text(r.status), exitCode: r.exitCode === null ? null : number(r.exitCode), durationMs: r.durationMs === null ? null : number(r.durationMs), limitBreach: r.limitBreached === null ? null : describeLimitBreach(text(r.limitBreached) as Parameters<typeof describeLimitBreach>[0]), outputTruncated: Boolean(r.outputTruncated), declaredOutputCount: number(r.declaredOutputCount), producedOutputCount: number(r.producedOutputCount), artifactCount: number(r.artifactCount), unregisteredOutputCount: number(r.unregisteredOutputCount) } : null,
    outputs: number(s.output?.n) > 0 ? { count: number(s.output?.n) } : null,
    transcript: { lastSeq: number(s.seq?.n) },
    reuse: s.reuse ? { ...reuseSummary(s.reuse)!, revisionDigestShort: text(s.reuse.revisionDigest).slice(0, 12), compatibility: typeof s.reuse.compatibilityReport === 'string' ? compatibilitySummary(s.reuse.compatibilityReport) : null, instructions: s.reuse.reuseKind === 'repair' && e.guidance ? text(e.guidance).split('\n') : null } : null,
    asOf: e.asOfAt && e.asOfDate && e.asOfTimezone && e.asOfSource ? { at: number(e.asOfAt), date: text(e.asOfDate), timeZone: text(e.asOfTimezone), source: text(e.asOfSource) as 'now' | 'chosen' | 'copied' } : null,
  };
}
function compatibilitySummary(raw: string): { status: string; advisoryCount: number } | null {
  try { const report = JSON.parse(raw) as { status: string; findings: { severity: string }[] }; return { status: report.status, advisoryCount: report.findings.filter((item) => item.severity === 'advisory').length }; }
  catch { return null; }
}
