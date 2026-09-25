// ---------------------------------------------------------------------------
// The generation budget (FEAT-106 TASK-011): attempts, wall clock, and spend.
//
// This is the SINGLE place a refusal reason is decided. The attempt count is
// read from the database on every claim — never an in-memory tally, which a
// restart would reset to zero and so hand the model a fresh set of attempts.
// The wall clock is measured from the execution's persisted start. Spend is
// accumulated only from cost the provider actually reported; with the cap at
// 0 the cost check is off, visibly, rather than silently never firing.
// ---------------------------------------------------------------------------

import {
  GENERATION_TIMEOUT_MS,
  GenerationCostLimitError,
  GenerationTimeoutError,
  MAX_GENERATION_ATTEMPTS,
  MAX_GENERATION_COST_USD,
  type AgentUsage,
  type AutoMateError,
} from '@automate/core';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { GenerationAttemptRepository } from '../db/repositories/generation-attempt-repository';

export interface BudgetLimits {
  /** `AUTOMATE_MAX_GENERATION_ATTEMPTS`. */
  readonly maxAttempts: number;
  /** `AUTOMATE_GENERATION_TIMEOUT_MS`. */
  readonly timeoutMs: number;
  /** `AUTOMATE_MAX_GENERATION_COST_USD`; 0 disables the spend check. */
  readonly maxCostUsd: number;
}
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = { maxAttempts: MAX_GENERATION_ATTEMPTS, timeoutMs: GENERATION_TIMEOUT_MS, maxCostUsd: MAX_GENERATION_COST_USD };

export type AttemptClaim =
  | { readonly granted: true; readonly used: number; readonly remainingAfter: number }
  | { readonly granted: false; readonly reason: 'attempt_limit' | 'time_limit' | 'cost_limit'; readonly used: number };

export interface GenerationBudgetDependencies {
  readonly executionId: number;
  readonly attempts: GenerationAttemptRepository;
  readonly executions: ExecutionRepository;
  readonly limits: BudgetLimits;
  /** Milliseconds since the epoch. */
  readonly clock?: () => number;
}

/** Attempt, wall-clock, and spend accounting for one execution. */
export class GenerationBudget {
  private readonly clock: () => number;
  private readonly fallbackStart: number;
  private cost = 0;
  private costReported = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private pausedMs = 0;
  private pausedAt: number | null = null;

  constructor(private readonly deps: GenerationBudgetDependencies) {
    this.clock = deps.clock ?? (() => Date.now());
    this.fallbackStart = this.clock();
  }

  get limits(): BudgetLimits { return this.deps.limits; }

  /** Attempts that count against the limit, read from the database. */
  used(): number { return this.deps.attempts.countUsed(this.deps.executionId); }

  /** Attempts left, never negative. */
  remaining(): number { return Math.max(0, this.deps.limits.maxAttempts - this.used()); }

  /** Decide whether one more `run_tests` may run. @returns A grant, or the first refusal reason in the order attempts, time, spend. */
  claimAttempt(): AttemptClaim {
    const used = this.used();
    if (used >= this.deps.limits.maxAttempts) return { granted: false, reason: 'attempt_limit', used };
    if (this.timeRemainingMs() <= 0) return { granted: false, reason: 'time_limit', used };
    if (this.costExceeded()) return { granted: false, reason: 'cost_limit', used };
    return { granted: true, used, remainingAfter: this.deps.limits.maxAttempts - used - 1 };
  }

  /** Accumulate one turn's usage, adding only the fields the provider reported. */
  recordUsage(usage: AgentUsage): void {
    if (usage.costUsd !== undefined) { this.cost += usage.costUsd; this.costReported = true; }
    if (usage.inputTokens !== undefined) this.inputTokens += usage.inputTokens;
    if (usage.outputTokens !== undefined) this.outputTokens += usage.outputTokens;
  }

  /** Provider spend so far, or null when the provider has reported none — never a materialized zero. */
  spentUsd(): number | null { return this.costReported ? this.cost : null; }

  /** Tokens reported so far. */
  tokens(): { readonly input: number; readonly output: number } { return { input: this.inputTokens, output: this.outputTokens }; }

  /**
   * Stop the wall clock while the run waits for a person (FEAT-105's `waiting`). A parked run waits
   * indefinitely by design; time spent waiting for an answer is the person's, not the agent's.
   */
  pause(): void { if (this.pausedAt === null) this.pausedAt = this.clock(); }

  /** Restart the wall clock when the run leaves `waiting`. */
  resume(): void {
    if (this.pausedAt === null) return;
    this.pausedMs += Math.max(0, this.clock() - this.pausedAt);
    this.pausedAt = null;
  }

  /** True while the clock is paused for a person's answer. */
  get paused(): boolean { return this.pausedAt !== null; }

  /** Milliseconds the run has spent generating since its persisted start, excluding time spent waiting for a person. */
  elapsedMs(): number {
    const started = this.deps.executions.getById(this.deps.executionId)?.startedAt?.getTime() ?? this.fallbackStart;
    const now = this.clock();
    const waiting = this.pausedMs + (this.pausedAt === null ? 0 : now - this.pausedAt);
    return Math.max(0, now - started - waiting);
  }

  /** Milliseconds left on the wall clock. */
  timeRemainingMs(): number { return this.deps.limits.timeoutMs - this.elapsedMs(); }

  /** The error a limit reached between turns stops the run with, or null. */
  stopReason(): AutoMateError | null {
    if (!this.paused && this.timeRemainingMs() <= 0) return this.timeoutError();
    if (this.costExceeded()) return new GenerationCostLimitError(this.deps.limits.maxCostUsd, this.cost);
    return null;
  }

  timeoutError(): GenerationTimeoutError { return new GenerationTimeoutError(this.deps.limits.timeoutMs, this.elapsedMs()); }

  private costExceeded(): boolean { return this.deps.limits.maxCostUsd > 0 && this.costReported && this.cost >= this.deps.limits.maxCostUsd; }
}
