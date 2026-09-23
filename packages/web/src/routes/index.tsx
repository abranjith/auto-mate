import { createFileRoute } from '@tanstack/react-router';
import { ds } from '../design-system/tokens';
import { TaskComposer } from '../components/conversation/task-composer';

/** Let a person describe and start a task. */
function NewTask() {
  return (
    <section className={ds.card}>
      <h1 className={ds.sectionTitle}>New task</h1>
      <p className={ds.hint}>
        Describe the work and follow the agent’s progress live.
      </p>
      <TaskComposer />
    </section>
  );
}
export const Route = createFileRoute('/')({ component: NewTask });
