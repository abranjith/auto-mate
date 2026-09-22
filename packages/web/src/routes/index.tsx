import { createFileRoute } from '@tanstack/react-router';
import { ds } from '../design-system/tokens';

/** Show the future task entry location. @returns A labelled placeholder panel. */
function NewTask() { return <section className={ds.card}><h1 className={ds.sectionTitle}>New task</h1><p>Task conversation and file intake arrive in FEAT-103 and FEAT-104.</p></section>; }
export const Route = createFileRoute('/')({ component: NewTask });
