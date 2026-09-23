/** Semantic classes consumed by application components. */
export const ds = {
  page: 'min-h-screen bg-[var(--surface)] text-[var(--text)] font-sans',
  card: 'rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-6 shadow-sm',
  btnPrimary:
    'rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-foreground)] hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50 disabled:cursor-not-allowed',
  btnGhost:
    'rounded-lg border border-[var(--border)] px-4 py-2 text-[var(--text)] hover:bg-[var(--surface)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50 disabled:cursor-not-allowed',
  navLink:
    'rounded-lg px-4 py-2 text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
  navLinkActive:
    'bg-[var(--surface-raised)] text-[var(--accent)] font-semibold',
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
  stack: 'flex flex-col gap-4',
  stackTight: 'flex flex-col gap-2',
  row: 'flex flex-wrap items-center gap-3',
  field: 'flex flex-col gap-1',
  label: 'text-sm font-medium text-[var(--text-muted)]',
  select:
    'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50',
  input:
    'w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50',
  listPlain: 'flex flex-col gap-3 list-none p-0 m-0',
  listItem: 'rounded-lg border border-[var(--border)] p-3',
  hint: 'text-sm text-[var(--text-muted)] leading-relaxed',
  cardStack: 'flex flex-col gap-6',
  composer: 'mt-4 flex flex-col gap-3',
  textarea:
    'min-h-36 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50',
  counter: 'self-end text-xs text-[var(--text-muted)]',
  conversation:
    'flex max-h-[65vh] flex-col gap-3 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4',
  userMessage:
    'ml-auto max-w-[85%] rounded-xl bg-[var(--accent)] p-3 text-[var(--accent-foreground)]',
  assistantMessage:
    'mr-auto max-w-[90%] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3',
  eventLine: 'text-sm text-[var(--text-muted)]',
  toolCard: 'rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3',
  codeBlock:
    'overflow-x-auto rounded-lg bg-[var(--surface)] p-3 font-mono text-sm',
  badge:
    'rounded-full border border-[var(--border)] px-3 py-1 text-sm font-medium',
  failurePanel:
    'rounded-lg border border-[var(--danger)] p-4 text-[var(--danger)]',
} as const;
