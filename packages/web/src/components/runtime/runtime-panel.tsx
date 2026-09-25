import { useEffect, useState } from 'react';
import { type RuntimeEnvironmentView, type RuntimeKind, type RuntimeReadiness } from '@automate/core';
import { codeFor, messageFor } from '../../api/agent-queries';
import { usePrepareRuntime, useRuntimeStatus } from '../../api/runtime-queries';
import { ds } from '../../design-system/tokens';
import { RuntimeLimitsNote } from './runtime-limits-note';

function Environment({ kind, state, busy, onPrepare, elapsed, pinned }: { readonly kind: RuntimeKind; readonly state: RuntimeReadiness; readonly busy: boolean; readonly onPrepare: () => void; readonly elapsed: number; readonly pinned: string }) {
  const environment: RuntimeEnvironmentView | null = state.environment;
  const preparing = environment?.status === 'preparing' || busy;
  return <div className={ds.runtimeEnvironment}>
    <div className={ds.row}><h3 className={ds.label}>{kind === 'script' ? 'Script Python' : 'Code checkers'}</h3><span className={state.ready ? ds.runtimeReady : preparing ? ds.runtimePreparing : ds.runtimeFailed}>{environment?.status ?? 'not prepared'}</span></div>
    <p className={ds.hint}>Pinned Python {pinned}{environment ? ` · resolved ${environment.pythonVersion} · lock ${environment.lockDigest}` : ''}</p>
    {preparing ? <p className={ds.statusMuted}>Preparing for {elapsed} seconds… The first setup downloads Python and packages.</p> : null}
    {!state.ready && !preparing ? <p className={ds.statusDanger}>{state.reason}</p> : null}
    {environment?.failureReason?.includes('lockfile') ? <p className={ds.statusDanger}>The installed build has a lockfile problem. A maintainer needs to regenerate it in the repository.</p> : null}
    {environment?.preparedAt ? <p className={ds.hint}>Prepared {new Date(environment.preparedAt).toLocaleString()}</p> : null}
    {environment ? <p className={ds.hint}>{environment.packageCount} packages</p> : null}
    {environment?.packages.length ? <ul className={ds.gateList}>{environment.packages.map(({ name, version }) => <li key={name}>{name} {version}</li>)}</ul> : null}
    <button type="button" className={ds.btnSmall} disabled={preparing} onClick={onPrepare}>Prepare now</button>
  </div>;
}

/** Show both locked Python environments and a manual retry on Settings. */
export function RuntimePanel() {
  const status = useRuntimeStatus();
  const prepare = usePrepareRuntime();
  const [started, setStarted] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const preparing = prepare.isPending || status.data?.script.environment?.status === 'preparing' || status.data?.verify.environment?.status === 'preparing';
    if (!preparing) return;
    const anchor = started ?? Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - anchor) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [prepare.isPending, started, status.data]);
  const start = (kind: RuntimeKind) => { setStarted(Date.now()); setElapsed(0); prepare.mutate(kind); };
  return <section className={ds.card} aria-label="Python runtime">
    <h2 className={ds.sectionTitle}>Python runtime</h2>
    {status.isPending ? <p className={ds.statusMuted}>Loading runtime status…</p> : null}
    {status.isError ? <p className={ds.statusDanger} role="alert">{messageFor(status.error)}</p> : null}
    {status.data ? <><div className={ds.runtimeGrid}>
      <Environment kind="script" state={status.data.script} busy={prepare.isPending && prepare.variables === 'script'} onPrepare={() => start('script')} elapsed={elapsed} pinned={status.data.pinnedPythonVersion} />
      <Environment kind="verify" state={status.data.verify} busy={prepare.isPending && prepare.variables === 'verify'} onPrepare={() => start('verify')} elapsed={elapsed} pinned={status.data.pinnedPythonVersion} />
    </div><RuntimeLimitsNote capabilities={status.data.capabilities} /></> : null}
    {prepare.isError ? <p className={ds.statusDanger} role="alert">{codeFor(prepare.error) === 'RUNTIME_LOCK_MISMATCH' ? 'The installed build has a lockfile problem. A maintainer must run pnpm runtime:lock in the repository.' : messageFor(prepare.error)}</p> : null}
  </section>;
}
