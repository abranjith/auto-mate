/** Semantic classes consumed by application components. */
export const ds = {
  page: 'min-h-screen bg-[var(--surface)] text-[var(--text)] font-sans',
  card: 'rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-6 shadow-sm',
  btnPrimary: 'rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-foreground)] hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
  btnGhost: 'rounded-lg border border-[var(--border)] px-4 py-2 text-[var(--text)] hover:bg-[var(--surface)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
  navLink: 'rounded-lg px-4 py-2 text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
  navLinkActive: 'bg-[var(--surface-raised)] text-[var(--accent)] font-semibold',
  surface: 'border-b border-[var(--border)] bg-[var(--surface-raised)]',
  textMuted: 'text-[var(--text-muted)]',
  layout: 'mx-auto max-w-5xl px-6 py-6',
  header: 'flex flex-wrap items-center justify-between gap-4',
  nav: 'flex flex-wrap gap-2',
  title: 'text-2xl font-bold',
  sectionTitle: 'mb-3 text-xl font-semibold',
  statusSuccess: 'text-sm text-[var(--success)]',
  statusDanger: 'text-sm text-[var(--danger)]',
  statusMuted: 'text-sm text-[var(--text-muted)]',
} as const;
