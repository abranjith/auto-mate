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
  runtimeGrid: 'grid gap-4 md:grid-cols-2',
  runtimeEnvironment: 'flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4',
  runtimeReady: 'text-sm font-medium text-[var(--success)]',
  runtimePreparing: 'text-sm font-medium text-[var(--accent)]',
  runtimeFailed: 'text-sm font-medium text-[var(--danger)]',
  runtimeLimits: 'mt-4 rounded-lg border border-[var(--border)] p-4',
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
  // File attachment (FEAT-104).
  srOnly: 'sr-only',
  dropZone:
    'flex flex-col gap-2 rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--surface)] p-4 focus-within:outline-2 focus-within:outline-[var(--accent)]',
  dropZoneActive:
    'flex flex-col gap-2 rounded-lg border-2 border-dashed border-[var(--accent)] bg-[var(--surface-raised)] p-4 focus-within:outline-2 focus-within:outline-[var(--accent)]',
  fileInput:
    'text-sm text-[var(--text)] file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--accent)] file:px-3 file:py-1 file:text-[var(--accent-foreground)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
  fileList: 'm-0 flex list-none flex-col gap-2 p-0',
  fileItem:
    'flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3',
  fileItemHeader: 'flex flex-wrap items-center justify-between gap-2',
  fileName: 'break-all font-medium',
  progress: 'h-2 w-full accent-[var(--accent)]',
  btnSmall:
    'rounded-md border border-[var(--border)] px-2 py-1 text-sm text-[var(--text)] hover:bg-[var(--surface-raised)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50',
  // Data preview (FEAT-104): every cell is text, never markup.
  profilePanel:
    'flex flex-col gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-4',
  localNotice: 'text-sm text-[var(--success)]',
  tabList: 'flex flex-wrap gap-1 border-b border-[var(--border)]',
  tab: 'rounded-t-md px-3 py-1 text-sm text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
  tabActive:
    'rounded-t-md border-b-2 border-[var(--accent)] px-3 py-1 text-sm font-semibold text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
  tableScroll:
    'max-h-96 max-w-full overflow-auto rounded-lg border border-[var(--border)]',
  dataTable: 'min-w-full border-collapse text-left text-sm',
  tableHead: 'sticky top-0 bg-[var(--surface-raised)]',
  tableHeaderCell:
    'whitespace-nowrap border-b border-[var(--border)] px-3 py-2 font-semibold',
  tableCell:
    'max-w-xs whitespace-pre-wrap break-words border-b border-[var(--border)] px-3 py-2 align-top',
  formulaLike: 'font-mono text-[var(--text-muted)]',
  truncatedCell: 'text-[var(--text-muted)]',
  noteList: 'm-0 flex list-disc flex-col gap-2 pl-5',
  noteItem: 'text-sm leading-relaxed',
  inlineCode: 'rounded bg-[var(--surface)] px-1 font-mono text-sm',
  disclosurePanel: 'mt-4 flex flex-col gap-4 rounded-xl border border-[var(--accent)] bg-[var(--surface-raised)] p-6',
  clarificationCard: 'rounded-lg border border-[var(--accent)] bg-[var(--surface)] p-4 flex flex-col gap-3',
  waitingBanner: 'rounded-lg border border-[var(--accent)] bg-[var(--surface-raised)] p-4',
  receipt: 'rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm',
  // Code generation (FEAT-106): every piece of generated code, summary, and diagnostic renders as text.
  generationProgress: 'flex flex-wrap items-center gap-3 rounded-lg border border-[var(--accent)] bg-[var(--surface-raised)] p-3 text-sm',
  progressTrack: 'h-2 w-40 accent-[var(--accent)]',
  codeCard: 'flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3',
  codeCardSummary: 'flex cursor-pointer flex-wrap items-center gap-2 text-sm font-medium',
  codeFileList: 'm-0 flex list-none flex-col gap-1 p-0 text-sm',
  codeView: 'max-h-96 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 font-mono text-sm leading-relaxed',
  codeLine: 'whitespace-pre',
  codeLineNumber: 'inline-block w-10 select-none pr-3 text-right text-[var(--text-muted)]',
  digest: 'font-mono text-xs text-[var(--text-muted)]',
  attemptPassed: 'text-sm font-medium text-[var(--success)]',
  attemptFailed: 'text-sm font-medium text-[var(--danger)]',
  testResult: 'flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm',
  diagnosticText: 'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-raised)] p-3 font-mono text-xs',
  fixtureNote: 'border-l-2 border-[var(--accent)] pl-3 text-sm text-[var(--text-muted)]',
  generationSettled: 'rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 text-sm',
  generationFailurePanel: 'flex flex-col gap-3 rounded-lg border border-[var(--danger)] bg-[var(--surface-raised)] p-4',
  // Verification, the approval gate, the run, and the review (FEAT-107). Finding messages, the agent's
  // summary, manifest text, and captured output are untrusted and always render as text.
  verificationReport: 'flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-4',
  verdictPassed: 'text-sm font-semibold text-[var(--success)]',
  verdictBlocked: 'text-sm font-semibold text-[var(--danger)]',
  checkList: 'm-0 flex list-none flex-col gap-2 p-0',
  checkRow: 'flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm',
  checkHeader: 'flex flex-wrap items-center gap-2',
  checkIcon: 'inline-block w-5 text-center font-mono',
  badgeBlocking: 'rounded-full border border-[var(--danger)] px-2 py-0.5 text-xs font-medium text-[var(--danger)]',
  badgeAdvisory: 'rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]',
  findingGroup: 'flex flex-col gap-1',
  findingFile: 'font-mono text-xs font-semibold',
  findingList: 'm-0 flex list-none flex-col gap-1 p-0',
  findingItem: 'flex flex-wrap items-baseline gap-2 text-sm',
  severityHigh: 'rounded px-1 text-xs font-semibold text-[var(--danger)]',
  severityMedium: 'rounded px-1 text-xs font-semibold text-[var(--text)]',
  severityLow: 'rounded px-1 text-xs text-[var(--text-muted)]',
  findingMessage: 'whitespace-pre-wrap break-words',
  runtimeNote: 'border-l-2 border-[var(--border)] pl-3 text-sm text-[var(--text-muted)]',
  gatePanel: 'flex flex-col gap-4 rounded-xl border border-[var(--accent)] bg-[var(--surface-raised)] p-6',
  gateList: 'm-0 flex list-disc flex-col gap-1 pl-5 text-sm',
  caveatList: 'm-0 flex list-none flex-col gap-2 p-0',
  caveat: 'border-l-2 border-[var(--danger)] pl-3 text-sm leading-relaxed',
  checkboxRow: 'flex items-start gap-2 text-sm',
  runProgress: 'flex flex-col gap-2 rounded-lg border border-[var(--accent)] bg-[var(--surface-raised)] p-3 text-sm',
  runResult: 'flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-sm',
  outputTail: 'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface)] p-3 font-mono text-xs',
  reviewPanel: 'flex flex-col gap-3 rounded-xl border border-[var(--accent)] bg-[var(--surface-raised)] p-6',
} as const;
