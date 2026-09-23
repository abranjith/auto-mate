export { AutoMateError } from './errors/automate-error';
export { ERROR_CODES } from './errors/error-codes';
export {
  ValidationError,
  ConfigurationError,
  RepositoryError,
} from './errors/index';
export {
  TaskNotFoundError,
  ExecutionNotFoundError,
  ExecutionNotRunningError,
  ExecutionInterruptedError,
  ExecutionLimitReachedError,
} from './errors/conversation-errors';
export {
  AgentStartupError,
  AgentModelNotFoundError,
  AgentAuthUnavailableError,
  AgentProviderUnavailableError,
  AgentSessionStartFailedError,
  AgentConfigInvalidError,
} from './errors/agent-errors';
export { HealthResponseSchema, ApiErrorSchema } from './contracts/health';
export type { HealthResponse, ApiError } from './contracts/health';
export type {
  AgentProvider,
  AgentSession,
  AgentSessionOptions,
  AgentModelSelection,
  AgentAuthSelection,
  AgentAuthSource,
  AgentEvent,
  AgentRunResult,
  AgentUsage,
  AgentError,
} from './agent/index';
export { createSanitizer } from './agent/index';
export type { Sanitizer, SanitizerOptions } from './agent/index';
export {
  AgentConfigSchema,
  AgentConfigUpdateSchema,
  DEFAULT_AGENT_CONFIG,
  AGENT_CONFIG_VERSION,
} from './agent/index';
export type { AgentConfig, AgentConfigUpdate } from './agent/index';
export {
  AgentConfigResponseSchema,
  ProviderCatalogEntrySchema,
  ProviderCatalogResponseSchema,
  ConnectionTestResponseSchema,
  CredentialSourceSchema,
} from './contracts/agent-api';
export type {
  AgentConfigResponse,
  ProviderCatalogEntryResponse,
  ProviderCatalogResponse,
  ConnectionTestResponse,
} from './contracts/agent-api';
export {
  ConversationEventSchema,
  EXECUTION_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  canTransition,
  applyTransition,
  isTerminal,
  ServerToClientMessageSchema,
  WS_CLOSE,
  executionSocketPath,
} from './conversation/index';
export type {
  ConversationEvent,
  ExecutionStatus,
  ServerToClientMessage,
} from './conversation/index';
export {
  CreateTaskRequestSchema,
  TaskSchema,
  ExecutionSummarySchema,
  TaskResponseSchema,
  CreateTaskResponseSchema,
  ConversationEventPageSchema,
  AbortResponseSchema,
} from './contracts/task-api';
export type {
  CreateTaskRequest,
  Task,
  ExecutionSummary,
  TaskResponse,
  CreateTaskResponse,
  ConversationEventPage,
} from './contracts/task-api';
