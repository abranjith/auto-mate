import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutoMateError, type AgentConfig, type ConnectionTestResponse, type ProviderCatalogResponse } from '@automate/core';
import { messageFor, useAgentConfig, useProviderCatalog, useTestConnection, useUpdateAgentConfig } from '../../api/agent-queries';
import { Route } from '../../routes/settings';

vi.mock('../../api/agent-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/agent-queries')>();
  return { ...actual, useAgentConfig: vi.fn(), useProviderCatalog: vi.fn(), useUpdateAgentConfig: vi.fn(), useTestConnection: vi.fn() };
});

const mockedConfig = vi.mocked(useAgentConfig);
const mockedCatalog = vi.mocked(useProviderCatalog);
const mockedSave = vi.mocked(useUpdateAgentConfig);
const mockedTest = vi.mocked(useTestConnection);

const SAVED: AgentConfig = {
  version: 1, provider: 'anthropic', model: 'claude-sonnet-5', thinking: 'high',
  auth: { mode: 'managed' }, updatedAt: '2026-09-22T00:00:00.000Z',
};

const CATALOG: ProviderCatalogResponse = {
  providers: [
    { id: 'anthropic', label: 'Anthropic', credentialAvailable: true, credentialSource: 'managed', models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }, { id: 'claude-opus-5', label: 'Claude Opus 5' }] },
    { id: 'openai', label: 'OpenAI', credentialAvailable: false, credentialSource: 'unavailable', models: [{ id: 'gpt-6', label: 'GPT-6' }], remediation: 'Set OPENAI_API_KEY in the environment Auto-Mate starts in.' },
  ],
};

const OK_RESULT: ConnectionTestResponse = {
  ok: true, model: 'claude-sonnet-5', provider: 'anthropic', authSource: 'managed', sessionId: 's1',
  durationMs: 812, eventCounts: { tool_started: 1, tool_finished: 1, assistant_text: 3 }, statusToolInvoked: true,
};

/** A query result stub, typed loosely because only the read fields matter here. */
function query(overrides: Record<string, unknown>) {
  return { data: undefined, error: null, isPending: false, isError: false, ...overrides } as never;
}

/** A mutation result stub, with a recording `mutate`. */
function mutation(overrides: Record<string, unknown> = {}) {
  return { mutate: vi.fn(), data: undefined, error: null, isPending: false, isError: false, ...overrides } as never;
}

/** Render the settings page component behind its route. */
function renderSettings() {
  const Settings = Route.options.component;
  if (Settings === undefined) throw new Error('The settings route has no component');
  return render(<Settings />);
}

beforeEach(() => {
  mockedConfig.mockReturnValue(query({ data: SAVED }));
  mockedCatalog.mockReturnValue(query({ data: CATALOG }));
  mockedSave.mockReturnValue(mutation());
  mockedTest.mockReturnValue(mutation());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('settings page', () => {
  it('renders the saved provider, model, and reasoning effort', () => {
    renderSettings();
    expect(screen.getByLabelText('Provider')).toHaveProperty('value', 'anthropic');
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'claude-sonnet-5');
    expect(screen.getByLabelText('Reasoning effort')).toHaveProperty('value', 'high');
  });

  it('filters the model list to the selected provider', async () => {
    renderSettings();
    const models = screen.getByLabelText('Model');
    expect([...(models as HTMLSelectElement).options].map((option) => option.value)).toEqual(['claude-sonnet-5', 'claude-opus-5']);
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'openai');
    await waitFor(() => expect([...(screen.getByLabelText('Model') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['gpt-6']));
  });

  it('disables save until something changes, then calls the mutation with the edited config', async () => {
    const mutate = vi.fn();
    mockedSave.mockReturnValue(mutation({ mutate }));
    renderSettings();
    const button = screen.getByRole('button', { name: 'Save selection' });
    expect(button).toHaveProperty('disabled', true);
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'claude-opus-5');
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    await userEvent.click(button);
    expect(mutate).toHaveBeenCalledWith({ provider: 'anthropic', model: 'claude-opus-5', thinking: 'high', auth: { mode: 'managed' } });
  });

  it('renders a 400 from the mutation in plain English and leaves the form editable', async () => {
    mockedSave.mockReturnValue(mutation({ isError: true, error: new AutoMateError('AGENT_MODEL_NOT_FOUND', 'Model "nope" was not found for provider "anthropic".') }));
    renderSettings();
    expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Model "nope" was not found for provider "anthropic".');
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'claude-opus-5');
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'claude-opus-5');
  });

  it('shows the loading state before the saved selection arrives', () => {
    mockedConfig.mockReturnValue(query({ isPending: true }));
    renderSettings();
    expect(screen.getByText(/Loading your provider settings/)).toBeTruthy();
  });

  it('shows the unreachable-server message rather than a blank page', () => {
    mockedConfig.mockReturnValue(query({ isError: true, error: new AutoMateError('CONNECTION_ERROR', 'Cannot reach the local server. Start it with pnpm dev.') }));
    renderSettings();
    expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Cannot reach the local server. Start it with pnpm dev.');
  });
});

describe('credential panel', () => {
  it('renders the available state with its source label', () => {
    renderSettings();
    const item = screen.getByText('✓ Anthropic');
    expect(item.parentElement?.textContent).toContain('using the managed credential store');
  });

  it('renders the unavailable state with remediation text', async () => {
    renderSettings();
    await userEvent.click(screen.getByText(/provider without a credential/));
    expect(screen.getByText('✗ OpenAI')).toBeTruthy();
    expect(screen.getByText(/Set OPENAI_API_KEY/)).toBeTruthy();
  });

  it('warns when the selected provider has no credential', async () => {
    renderSettings();
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'openai');
    await waitFor(() => expect(screen.getByText(/OpenAI has no usable credential/)).toBeTruthy());
  });

  it('reveals the path input and its scope explanation for the personal-pi opt-in', async () => {
    renderSettings();
    expect(screen.queryByLabelText(/Path to your Pi auth.json/)).toBeNull();
    await userEvent.click(screen.getByLabelText('Use an existing personal Pi credential file'));
    await waitFor(() => expect(screen.getByLabelText(/Path to your Pi auth.json/)).toBeTruthy());
    expect(screen.getByText(/does not import your personal Pi/)).toBeTruthy();
  });

  it('offers no field to type an API key', () => {
    renderSettings();
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('never renders a key-shaped string even when the catalog wrongly includes one', () => {
    mockedCatalog.mockReturnValue(query({
      data: { providers: [{ ...CATALOG.providers[0], label: 'Anthropic', remediation: 'sk-ant-api03-AbCdEf0123456789XyZ' }] },
    }));
    renderSettings();
    expect(document.body.textContent).not.toMatch(/sk-ant-api03-[A-Za-z0-9]+/);
  });
});

describe('connection test panel', () => {
  it('shows the pending state while a test runs', () => {
    mockedTest.mockReturnValue(mutation({ isPending: true }));
    renderSettings();
    expect(screen.getByRole('button', { name: 'Testing…' })).toHaveProperty('disabled', true);
  });

  it('calls the mutation and renders the success summary', async () => {
    const mutate = vi.fn();
    mockedTest.mockReturnValue(mutation({ mutate, data: OK_RESULT }));
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('Connected to anthropic / claude-sonnet-5 in 812 ms');
    expect(screen.getByText(/1 tool_started, 1 tool_finished, 3 assistant_text/)).toBeTruthy();
  });

  it('renders a typed failure from the session without a stack trace', () => {
    mockedTest.mockReturnValue(mutation({
      data: { ok: false, model: 'claude-sonnet-5', provider: 'anthropic', durationMs: 12, eventCounts: {}, statusToolInvoked: false, error: { code: 'AGENT_AUTH_UNAVAILABLE', message: 'No credential is available for provider "anthropic".' } },
    }));
    renderSettings();
    expect(screen.getByRole('alert').textContent).toContain('No credential is available');
    expect(screen.getByText(/Error code: AGENT_AUTH_UNAVAILABLE/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('    at ');
  });

  it('renders a request failure separately from a session failure', () => {
    mockedTest.mockReturnValue(mutation({ isError: true, error: new AutoMateError('CONNECTION_ERROR', 'Cannot reach the local server. Start it with pnpm dev.') }));
    renderSettings();
    expect(screen.getByRole('alert').textContent).toContain('Cannot reach the local server');
  });

  it('says the test uses the saved selection when the form has edits', async () => {
    renderSettings();
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'claude-opus-5');
    await waitFor(() => expect(screen.getByText(/the test uses the saved selection/)).toBeTruthy());
  });
});

describe('error message mapping', () => {
  it('uses the typed message for an application error', () => {
    expect(messageFor(new AutoMateError('X', 'A plain explanation.'))).toBe('A plain explanation.');
  });
  it('falls back to a generic line for an unknown value', () => {
    expect(messageFor({ weird: true })).toBe('Something went wrong. Check the server log for details.');
  });
  it('does not render an enormous raw error string', () => {
    expect(messageFor(new Error('x'.repeat(400)))).toBe('Something went wrong. Check the server log for details.');
  });
});
