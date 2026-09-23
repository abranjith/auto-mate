import type { AgentConfig, ProviderCatalogResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';

/** How each resolved credential source reads on the page. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  managed: 'the managed credential store',
  'personal-pi': 'your personal Pi credential file',
  environment: 'an environment variable',
  unavailable: 'not configured',
};

/** Props for {@link CredentialStatus}. */
export interface CredentialStatusProps {
  /** The catalog rendered as one row per provider. */
  readonly catalog: ProviderCatalogResponse | undefined;
  /** The selection currently shown in the form. */
  readonly draft: AgentConfig;
  /** True while a save is in flight. */
  readonly saving: boolean;
  /** Apply one edit to the draft. */
  readonly onChange: (patch: Partial<AgentConfig>) => void;
}

/**
 * Per-provider credential status and the personal-Pi opt-in.
 *
 * The page never renders a credential value and offers no field to type one:
 * a key is supplied through the provider's environment variable or Pi's own
 * login, both of which the remediation text explains.
 *
 * @param props See {@link CredentialStatusProps}.
 * @returns The credential panel.
 * @example <CredentialStatus catalog={catalog} draft={draft} saving={false} onChange={patch} />
 */
export function CredentialStatus(props: CredentialStatusProps) {
  const providers = props.catalog?.providers ?? [];
  const configured = providers.filter((provider) => provider.credentialAvailable);
  const missing = providers.filter((provider) => !provider.credentialAvailable);
  const selected = providers.find((provider) => provider.id === props.draft.provider);
  const personal = props.draft.auth.mode === 'personal-pi';

  return <section className={ds.card} aria-labelledby="credential-status-heading">
    <h2 id="credential-status-heading" className={ds.sectionTitle}>Credentials</h2>
    <div className={ds.stack}>
      <p className={ds.hint}>
        Auto-Mate never stores or shows an API key. It reports only whether a provider has a usable credential and where that
        credential came from.
      </p>

      {configured.length === 0
        ? <p className={ds.statusDanger}>No provider has a usable credential yet.</p>
        : <ul className={ds.listPlain} aria-label="Providers with a credential">
            {configured.map((provider) => <li key={provider.id} className={ds.listItem}>
              <span className={ds.statusSuccess}>✓ {provider.label}</span>
              <span className={ds.hint}> — using {SOURCE_LABELS[provider.credentialSource] ?? provider.credentialSource}</span>
            </li>)}
          </ul>}

      {selected !== undefined && !selected.credentialAvailable
        ? <p className={ds.statusDanger} role="alert">✗ {selected.label} has no usable credential. {selected.remediation}</p>
        : null}

      {missing.length === 0 ? null : <details>
        <summary className={ds.label}>{missing.length} provider{missing.length === 1 ? '' : 's'} without a credential</summary>
        <ul className={ds.listPlain} aria-label="Providers without a credential">
          {missing.map((provider) => <li key={provider.id} className={ds.listItem}>
            <span className={ds.statusDanger}>✗ {provider.label}</span>
            {provider.remediation === undefined ? null : <p className={ds.hint}>{provider.remediation}</p>}
          </li>)}
        </ul>
      </details>}

      <div className={ds.stackTight}>
        <label className={ds.row}>
          <input type="checkbox" checked={personal} disabled={props.saving}
            onChange={(event) => props.onChange({ auth: event.target.checked ? { mode: 'personal-pi', authPath: '' } : { mode: 'managed' } })} />
          <span className={ds.label}>Use an existing personal Pi credential file</span>
        </label>
        <p className={ds.hint}>
          Choosing this changes <strong>only</strong> which credential file Auto-Mate reads. It does not import your personal Pi
          settings, extensions, skills, prompt templates, themes, or project instructions — those stay out of every Auto-Mate session.
        </p>
        {personal ? <div className={ds.field}>
          <label className={ds.label} htmlFor="agent-auth-path">Path to your Pi auth.json</label>
          <input id="agent-auth-path" className={ds.input} type="text" spellCheck={false} disabled={props.saving}
            placeholder="for example, /home/you/.pi/auth.json"
            value={props.draft.auth.mode === 'personal-pi' ? props.draft.auth.authPath : ''}
            onChange={(event) => props.onChange({ auth: { mode: 'personal-pi', authPath: event.target.value } })} />
        </div> : null}
      </div>
    </div>
  </section>;
}
