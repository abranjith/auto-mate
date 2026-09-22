import { Link } from '@tanstack/react-router';
import { ds } from '../design-system/tokens';

/** Render application navigation. @returns Accessible links with an active style. */
export function AppNav() {
  return <nav aria-label="Main navigation" className={ds.nav}>
    <Link to="/" activeOptions={{ exact: true }} className={ds.navLink} activeProps={{ className: `${ds.navLink} ${ds.navLinkActive}` }}>New task</Link>
    <Link to="/history" className={ds.navLink} activeProps={{ className: `${ds.navLink} ${ds.navLinkActive}` }}>History</Link>
    <Link to="/settings" className={ds.navLink} activeProps={{ className: `${ds.navLink} ${ds.navLinkActive}` }}>Settings</Link>
  </nav>;
}
