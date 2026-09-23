import type { AgentConfig, ProviderCatalogResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';

/** Reasoning levels the adapter accepts; an unknown value is rejected at session open. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Props for {@link ModelSelector}. */
export interface ModelSelectorProps {
  /** The selection currently shown in the form. */
  readonly draft: AgentConfig;
  /** The catalog the provider and model lists are built from. */
  readonly catalog: ProviderCatalogResponse | undefined;
  /** True while a save is in flight; every control is disabled. */
  readonly saving: boolean;
  /** True when the draft differs from the saved selection. */
  readonly dirty: boolean;
  /** A plain-English failure from the last save, rendered above the button. */
  readonly errorMessage?: string;
  /** Apply one edit to the draft. */
  readonly onChange: (patch: Partial<AgentConfig>) => void;
  /** Submit the draft. */
  readonly onSave: () => void;
}

/**
 * Provider, model, and reasoning-level selection.
 *
 * Changing the provider filters the model list to that provider and moves the
 * selection to its first model, so the form can never submit a pair the catalog
 * does not contain.
 *
 * @param props See {@link ModelSelectorProps}.
 * @returns The selection form.
 * @example <ModelSelector draft={draft} catalog={catalog} saving={false} dirty onChange={patch} onSave={save} />
 */
export function ModelSelector(props: ModelSelectorProps) {
  const providers = props.catalog?.providers ?? [];
  const models = providers.find((provider) => provider.id === props.draft.provider)?.models ?? [];

  /** Move to another provider, taking its first model so the pair stays valid. */
  function selectProvider(id: string): void {
    const first = providers.find((provider) => provider.id === id)?.models[0]?.id;
    props.onChange({ provider: id, ...(first !== undefined ? { model: first } : {}) });
  }

  return <section className={ds.card} aria-labelledby="model-selection-heading">
    <h2 id="model-selection-heading" className={ds.sectionTitle}>Model selection</h2>
    <div className={ds.stack}>
      <div className={ds.row}>
        <div className={ds.field}>
          <label className={ds.label} htmlFor="agent-provider">Provider</label>
          <select id="agent-provider" className={ds.select} value={props.draft.provider} disabled={props.saving}
            onChange={(event) => selectProvider(event.target.value)}>
            {providers.length === 0 ? <option value={props.draft.provider}>{props.draft.provider}</option> : null}
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select>
        </div>
        <div className={ds.field}>
          <label className={ds.label} htmlFor="agent-model">Model</label>
          <select id="agent-model" className={ds.select} value={props.draft.model} disabled={props.saving}
            onChange={(event) => props.onChange({ model: event.target.value })}>
            {models.some((model) => model.id === props.draft.model) ? null : <option value={props.draft.model}>{props.draft.model}</option>}
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </div>
        <div className={ds.field}>
          <label className={ds.label} htmlFor="agent-thinking">Reasoning effort</label>
          <select id="agent-thinking" className={ds.select} value={props.draft.thinking ?? 'high'} disabled={props.saving}
            onChange={(event) => props.onChange({ thinking: event.target.value })}>
            {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </div>
      </div>
      {props.errorMessage === undefined ? null : <p className={ds.statusDanger} role="alert">{props.errorMessage}</p>}
      <div className={ds.row}>
        <button type="button" className={ds.btnPrimary} disabled={!props.dirty || props.saving} onClick={props.onSave}>
          {props.saving ? 'Saving…' : 'Save selection'}
        </button>
        <span className={ds.statusMuted}>{props.dirty ? 'Unsaved changes' : 'Saved'}</span>
      </div>
    </div>
  </section>;
}
