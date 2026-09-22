import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';

/** An invalid user input or requested path. */
export class ValidationError extends AutoMateError {
  /** @param message Public explanation. @param details Private diagnostics. @example new ValidationError('Invalid path.') */
  constructor(message: string, details?: unknown) {
    super(ERROR_CODES.VALIDATION_ERROR, message, details);
  }
}

/** A missing or invalid local prerequisite. */
export class ConfigurationError extends AutoMateError {
  /** @param message Public explanation. @param details Private diagnostics. @example new ConfigurationError('Data directory is unavailable.') */
  constructor(message: string, details?: unknown) {
    super(ERROR_CODES.CONFIGURATION_ERROR, message, details);
  }
}

/** A persistence operation that failed without exposing driver details. */
export class RepositoryError extends AutoMateError {
  /** @param message Public explanation. @param details Private diagnostics. @example new RepositoryError('Could not save metadata.') */
  constructor(message: string, details?: unknown) {
    super(ERROR_CODES.REPOSITORY_ERROR, message, details);
  }
}
