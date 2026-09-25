import { ds } from '../../design-system/tokens';

/** Render the core capability sentences verbatim, including the Windows gap. */
export function RuntimeLimitsNote({ capabilities }: { readonly capabilities: readonly string[] }) {
  return <div className={ds.runtimeLimits}><h3 className={ds.label}>What this computer enforces</h3><ul className={ds.gateList}>{capabilities.map((sentence) => <li key={sentence}>{sentence}</li>)}</ul></div>;
}
