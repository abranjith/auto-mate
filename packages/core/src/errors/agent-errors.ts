// ---------------------------------------------------------------------------
// Typed agent startup failures (FEAT-102 TASK-001).
//
// Thrown from `AgentProvider.open()`; the provider never degrades to a null or
// stub client. Messages must be actionable and secret-free: they may name the
// credential SOURCE that was tried and how to configure it, never key
// material, a stack trace, or an internal path.
// ---------------------------------------------------------------------------

import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';

/** Base class for typed agent startup failures. */
export abstract class AgentStartupError extends AutoMateError {
  /** Project this error onto the render-safe seam shape. @returns A code and message safe for the UI and logs. @example error.toAgentError() */
  toAgentError(): { readonly code: string; readonly message: string } {
    return { code: this.code, message: this.message };
  }
}

/** The requested provider/model pair is unknown to the model runtime. */
export class AgentModelNotFoundError extends AgentStartupError {
  /** @param provider Provider key that was searched. @param modelId Model id that missed. @param availableHint Plain-English list of known ids. @example new AgentModelNotFoundError('anthropic', 'nope', 'Known anthropic models include: claude-sonnet-5.') */
  constructor(provider: string, modelId: string, availableHint: string) {
    super(
      ERROR_CODES.AGENT_MODEL_NOT_FOUND,
      `Model "${modelId}" was not found for provider "${provider}". ${availableHint} Pick a listed model on the Settings page, or define a custom one in the application's models.json.`,
    );
  }
}

/** No usable credential could be resolved for the selected provider. */
export class AgentAuthUnavailableError extends AgentStartupError {
  /** @param provider Provider key that has no credential. @param sourcesTried Human list of the sources searched. @param fixHint How to supply a credential. @example new AgentAuthUnavailableError('anthropic', 'the managed store, ANTHROPIC_API_KEY', 'Set ANTHROPIC_API_KEY.') */
  constructor(provider: string, sourcesTried: string, fixHint: string) {
    super(
      ERROR_CODES.AGENT_AUTH_UNAVAILABLE,
      `No credential is available for provider "${provider}" (tried: ${sourcesTried}). ${fixHint}`,
    );
  }
}

/** The provider backend cannot be reached or refused the connection. */
export class AgentProviderUnavailableError extends AgentStartupError {
  /** @param provider Provider key that is unreachable. @param reason Sanitized reason. @example new AgentProviderUnavailableError('anthropic', 'the request timed out') */
  constructor(provider: string, reason: string) {
    super(ERROR_CODES.AGENT_PROVIDER_UNAVAILABLE, `Provider "${provider}" is unavailable: ${reason}`);
  }
}

/** Session construction failed for a reason other than model or credential resolution. */
export class AgentSessionStartFailedError extends AgentStartupError {
  /** @param reason Sanitized reason the session could not start. @example new AgentSessionStartFailedError('the working directory does not exist') */
  constructor(reason: string) {
    super(ERROR_CODES.AGENT_SESSION_START_FAILED, `The agent session failed to start: ${reason}`);
  }
}

/** The saved or submitted agent configuration points at something that does not exist. */
export class AgentConfigInvalidError extends AgentStartupError {
  /** @param message Plain-English explanation of what is wrong and how to fix it. @example new AgentConfigInvalidError('The personal Pi credential file you selected does not exist.') */
  constructor(message: string) {
    super(ERROR_CODES.AGENT_CONFIG_INVALID, message);
  }
}
