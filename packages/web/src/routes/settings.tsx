import { createFileRoute } from '@tanstack/react-router';
import { ds } from '../design-system/tokens';

/** Show the future settings location. @returns A labelled placeholder panel. */
function Settings() { return <section className={ds.card}><h1 className={ds.sectionTitle}>Settings</h1><p>Provider settings arrive in FEAT-102.</p></section>; }
export const Route = createFileRoute('/settings')({ component: Settings });
