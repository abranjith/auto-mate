// ---------------------------------------------------------------------------
// The generation-phase Python dependency set (FEAT-106 TASK-004).
//
// PROVISIONAL against open D05. This is the smallest set that lets a CSV/XLSX
// preparation-and-reporting script and its pytest tests import: pandas for
// tables, openpyxl for workbooks, plotly for reports, pytest for the agent's
// own tests. FEAT-108 owns the final set and its version/update policy, and
// this is the one file that changes when D05 resolves.
//
// The agent is told this list and told it cannot install anything else;
// per-task package installation is deferred (D05).
// ---------------------------------------------------------------------------

/** Packages installed into `~/.automate/env/`. Provisional against open D05; owned by FEAT-108 thereafter. */
export const GENERATION_DEPENDENCY_SET = ['pandas', 'openpyxl', 'plotly', 'pytest'] as const;

/** The lowest Python the environment accepts, matching FEAT-101's doctor check. */
export const PYTHON_REQUIREMENT = '>=3.11';

/**
 * Render the environment's `pyproject.toml`.
 *
 * @param dependencies Package names, in the order they are listed.
 * @returns TOML text for a non-package uv project; byte-identical for the same input.
 * @example renderPyproject(GENERATION_DEPENDENCY_SET)
 */
export function renderPyproject(dependencies: readonly string[] = GENERATION_DEPENDENCY_SET): string {
  return [
    '# Written by Auto-Mate (FEAT-106). Do not edit: the application rewrites this file.',
    '# Provisional dependency set pending decision D05; FEAT-108 owns the final policy.',
    '[project]',
    'name = "automate-generation-env"',
    'version = "0.0.0"',
    `requires-python = "${PYTHON_REQUIREMENT}"`,
    `dependencies = [${dependencies.map((name) => JSON.stringify(name)).join(', ')}]`,
    '',
    '[tool.uv]',
    'package = false',
    '',
  ].join('\n');
}
