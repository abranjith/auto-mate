/** A safe application error with a stable code and optional request identifier. */
export class AutoMateError extends Error {
  /** Construct an application error. @param code Stable machine code. @param message Plain-English message. @param details Private diagnostic details. @param correlationId Request identifier. @example new AutoMateError('NOT_FOUND', 'The page was not found.') */
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }

  /** Return the public API envelope, excluding diagnostic details. @returns A safe JSON-compatible error object. @example error.toJSON() */
  toJSON(): { error: { code: string; message: string; correlationId?: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.correlationId ? { correlationId: this.correlationId } : {}),
      },
    };
  }
}
