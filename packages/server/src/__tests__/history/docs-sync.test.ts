// FEAT-110 TASK-013: the History documentation is checked against the code it
// describes, so a change that makes a documented label, restart outcome, file
// tree, or route wrong fails the build instead of leaving the page stale.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ERROR_CODES, EXECUTION_STATUSES, HISTORY_STATUS_GROUPS, INTERRUPTED_ON_RESTART, PARKED_STATUSES, SURVIVES_RESTART, describeNeedsYou, describeRunState, describeTrigger } from '@automate/core';
import { TASK_OWNED_TREES } from '../../history/task-owned-trees';

const repo = path.join(import.meta.dirname, '..', '..', '..', '..', '..');
const doc = readFileSync(path.join(repo, 'docs', 'features', 'execution-history.md'), 'utf8');
/** The markdown table row that contains every one of the given fragments. */
const rowWith = (...fragments: string[]) => doc.split('\n').find((line) => line.startsWith('|') && fragments.every((fragment) => line.includes(fragment)));

describe('docs/features/execution-history.md matches the code', () => {
  it('documents every run label, trigger, and needs-you action in the words run-wording.ts uses', () => {
    const labels = new Set(EXECUTION_STATUSES.map((status) => describeRunState({ status }).label));
    labels.add(describeRunState({ status: 'failed', errorCode: ERROR_CODES.EXECUTION_INTERRUPTED }).label);
    labels.add(describeRunState({ status: 'aborted', errorCode: ERROR_CODES.EXECUTION_STOPPED_ON_SHUTDOWN }).label);
    for (const label of labels) expect(doc, label).toContain(label);
    for (const wording of [describeTrigger('manual', { hasGuidance: false }), describeTrigger('rerun', { hasGuidance: false }), describeTrigger('rerun', { hasGuidance: true }), describeTrigger('feedback', { hasGuidance: true })]) expect(doc, wording).toContain(wording);
    for (const status of PARKED_STATUSES) expect(doc, status).toContain(describeNeedsYou(status));
  });

  it('puts every status in the filter row of its History group', () => {
    const groupLabels = { needs_you: 'Needs you', running: 'Running', done: 'Done', stopped: "Didn't finish" } as const;
    for (const [group, statuses] of Object.entries(HISTORY_STATUS_GROUPS)) {
      const row = rowWith(`**${groupLabels[group as keyof typeof groupLabels]}**`);
      expect(row, group).toBeDefined();
      for (const status of statuses) expect(row, `${group}: ${status}`).toContain(`\`${status}\``);
    }
  });

  it('states the restart outcome of every open status as the partition defines it', () => {
    const interrupted = rowWith('Server restarted', '**Interrupted**');
    const survives = rowWith('Server restarted', '**Needs you**');
    expect(interrupted).toBeDefined(); expect(survives).toBeDefined();
    for (const status of INTERRUPTED_ON_RESTART) { expect(interrupted, status).toContain(`\`${status}\``); expect(survives, status).not.toContain(`\`${status}\``); }
    for (const status of SURVIVES_RESTART) { expect(survives, status).toContain(`\`${status}\``); expect(interrupted, status).not.toContain(`\`${status}\``); }
  });

  it('lists every tree a task owns, keyed as TASK_OWNED_TREES keys it', () => {
    for (const tree of TASK_OWNED_TREES) expect(doc, tree.kind).toContain(`\`${tree.kind}/{${tree.keyedBy === 'task' ? 'taskId' : 'executionId'}}/\``);
  });

  it('documents exactly the routes history-route.ts registers', () => {
    const source = readFileSync(path.join(import.meta.dirname, '..', '..', 'routes', 'history-route.ts'), 'utf8');
    const registered = [...source.matchAll(/router\.(get|post|delete|put|patch)\('([^']+)'/g)].map(([, method, route]) => `${method!.toUpperCase()} ${route!.replace(/:([A-Za-z]+)/g, '{$1}')}`).sort();
    expect(registered).toHaveLength(4);
    const apiSection = doc.slice(doc.indexOf('### History API'), doc.indexOf('## Configuration'));
    const documented = [...apiSection.matchAll(/^\| `(GET|POST|DELETE|PUT|PATCH) (\/api\/[^`?]+)/gm)].map(([, method, route]) => `${method} ${route}`).sort();
    expect(documented).toEqual(registered);
  });
});
