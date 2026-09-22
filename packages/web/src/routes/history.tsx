import { createFileRoute } from '@tanstack/react-router';
import { ds } from '../design-system/tokens';

/** Show the future history location. @returns A labelled placeholder panel. */
function History() { return <section className={ds.card}><h1 className={ds.sectionTitle}>History</h1><p>Execution history arrives in FEAT-110.</p></section>; }
export const Route = createFileRoute('/history')({ component: History });
