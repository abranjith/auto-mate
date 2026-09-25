import { ds } from '../../design-system/tokens';

/**
 * What the code was checked against, and what a change would mean. A result
 * is bound to this runtime: if Python or a package changes, the code is
 * checked again before it can run.
 */
export function RuntimeNote({ description, changes }: { description: string; changes?: readonly string[] }) {
  return (
    <div className={ds.runtimeNote}>
      <p>Checked against {description}. If Python or an installed package changes, the code is checked again before it can run.</p>
      {changes && changes.length > 0 ? (
        <>
          <p>The environment changed since the check, so it is being checked again:</p>
          <ul className={ds.gateList}>{changes.map((change) => <li key={change}>{change}.</li>)}</ul>
        </>
      ) : null}
    </div>
  );
}
