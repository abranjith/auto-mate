import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import type { AgentConfig, AgentConfigUpdate } from '@automate/core';
import { messageFor, useAgentConfig, useProviderCatalog, useTestConnection, useUpdateAgentConfig } from '../api/agent-queries';
import { ConnectionTest } from '../components/settings/connection-test';
import { CredentialStatus } from '../components/settings/credential-status';
import { ModelSelector } from '../components/settings/model-selector';
import { ds } from '../design-system/tokens';

/** Reduce a stored config to the fields the API accepts, so server-owned fields are never sent back. */
function toUpdate(config: AgentConfig): AgentConfigUpdate {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
    auth: config.auth,
  };
}

/** Compare a draft with the saved selection on the fields a save would send. */
function isDirty(draft: AgentConfig | undefined, saved: AgentConfig | undefined): boolean {
  if (draft === undefined || saved === undefined) return false;
  return JSON.stringify(toUpdate(draft)) !== JSON.stringify(toUpdate(saved));
}

/** Configure which AI provider and model Auto-Mate uses, and verify it works. @returns The settings page. */
function Settings() {
  const config = useAgentConfig();
  const catalog = useProviderCatalog();
  const save = useUpdateAgentConfig();
  const test = useTestConnection();
  const [draft, setDraft] = useState<AgentConfig | undefined>(undefined);

  // Seed the form once the saved selection arrives, and re-seed after a save so
  // the server's stamped `updatedAt` is what the form compares against.
  useEffect(() => { if (config.data !== undefined) setDraft(config.data); }, [config.data]);

  const dirty = isDirty(draft, config.data);

  if (config.isPending) return <section className={ds.card}><h1 className={ds.sectionTitle}>Settings</h1><p className={ds.statusMuted}>Loading your provider settings…</p></section>;
  if (config.isError || draft === undefined) {
    return <section className={ds.card}>
      <h1 className={ds.sectionTitle}>Settings</h1>
      <p className={ds.statusDanger} role="alert">{messageFor(config.error)}</p>
    </section>;
  }

  return <div className={ds.cardStack}>
    <div>
      <h1 className={ds.title}>Settings</h1>
      <p className={ds.hint}>Choose the AI provider and model Auto-Mate uses, and check that it can reach one.</p>
    </div>

    <ModelSelector
      draft={draft}
      catalog={catalog.data}
      saving={save.isPending}
      dirty={dirty}
      {...(save.isError ? { errorMessage: messageFor(save.error) } : {})}
      onChange={(patch) => setDraft({ ...draft, ...patch })}
      onSave={() => save.mutate(toUpdate(draft))}
    />

    <CredentialStatus
      catalog={catalog.data}
      draft={draft}
      saving={save.isPending}
      onChange={(patch) => setDraft({ ...draft, ...patch })}
    />

    {catalog.isError ? <p className={ds.statusDanger} role="alert">{messageFor(catalog.error)}</p> : null}

    <ConnectionTest
      pending={test.isPending}
      dirty={dirty}
      result={test.data}
      {...(test.isError ? { errorMessage: messageFor(test.error) } : {})}
      onTest={() => test.mutate()}
    />
  </div>;
}

export const Route = createFileRoute('/settings')({ component: Settings });
