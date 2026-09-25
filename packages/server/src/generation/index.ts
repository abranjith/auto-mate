// Generation barrel (FEAT-106): the only module routes and the composition root import.
export { CodeGenerationRunStrategy, GENERATION_SYSTEM_PROMPT } from './code-generation-run-strategy';
export type { CodeGenerationRunStrategyDependencies } from './code-generation-run-strategy';
export { CodeWorkspace } from './code-workspace';
export { FixtureService, fixtureSeed, fixturesDirPath } from './fixture-service';
export { GenerationBudget, DEFAULT_BUDGET_LIMITS } from './generation-budget';
export type { BudgetLimits, AttemptClaim } from './generation-budget';
export { GenerationLifecycle } from './generation-lifecycle';
export { GenerationRun, GenerationRuns } from './generation-run';
export { GenerationService } from './generation-service';
export { GenerationTools } from './generation-tools';
export { createGenerationStack } from './generation-stack';
export type { GenerationStackDependencies, GenerationStack } from './generation-stack';
export { parsePytestReport } from './pytest-report';
