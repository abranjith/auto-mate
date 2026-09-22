import { createRootRoute, Outlet } from '@tanstack/react-router';
import { AppNav } from '../components/app-nav';
import { ServerStatus } from '../components/server-status';
import { ThemeToggle } from '../components/theme-toggle';
import { ds } from '../design-system/tokens';

/** Render the shared shell. @returns Header, navigation, and the active page. */
function RootLayout() {
  return <div className={ds.page}>
    <header className={ds.surface}><div className={`${ds.layout} ${ds.header}`}>
      <strong className={ds.title}>Auto-Mate</strong>
      <AppNav />
      <ServerStatus />
      <ThemeToggle />
    </div></header>
    <main className={ds.layout}><Outlet /></main>
  </div>;
}

/** Explain an unknown route. @returns A safe not-found panel. */
function NotFound() { return <div className={ds.card}><h1 className={ds.sectionTitle}>Page not found</h1><p>Choose a page from the navigation above.</p></div>; }

/** Explain a route failure. @returns A safe message without stack details. */
function RouteError() { return <div className={ds.card}><h1 className={ds.sectionTitle}>This page could not be opened</h1><p>Try reloading the page.</p></div>; }

export const Route = createRootRoute({ component: RootLayout, notFoundComponent: NotFound, errorComponent: RouteError });
