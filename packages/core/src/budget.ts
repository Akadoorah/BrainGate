import { BrainGateInvariantError } from "./errors.js";
import type { TaskClassification } from "./classifier.js";
import type { TaskComplexity } from "./task-ledger.js";

export type ReviewerPolicy = "none" | "optional" | "required";
export type CouncilPolicy = "disabled" | "disagreement-only";

export interface ExecutionBudget {
  readonly maxProviderCalls: number;
  readonly maxConcurrentAgents: number;
  readonly maxReviewers: number;
  readonly maxRepairRounds: number;
  readonly maxAutomaticRetries: number;
  readonly maxCouncilRounds: number;
  readonly maxContextTokens: number;
  /**
   * Tool-use turns a read-only inspection may spend gathering context. It scales with
   * complexity for the same reason maxContextTokens does: a budget that allows 96k tokens of
   * context but only the turn count of a trivial lookup cannot actually reach it.
   */
  readonly maxInspectionTurns: number;
  /**
   * Wall-clock allowance for one read-only inspection. Scales with the turn allowance for the
   * same reason: turns the provider is permitted but has no time to spend are not a budget.
   */
  readonly maxInspectionMs: number;
  readonly reviewerPolicy: ReviewerPolicy;
  readonly councilPolicy: CouncilPolicy;
  readonly humanApprovalBeforeWrite: boolean;
}

const BASE_BUDGETS: Readonly<Record<TaskComplexity, ExecutionBudget>> = {
  T0: { maxProviderCalls: 1, maxConcurrentAgents: 1, maxReviewers: 0, maxRepairRounds: 0, maxAutomaticRetries: 0, maxCouncilRounds: 0, maxContextTokens: 12_000, maxInspectionTurns: 4, maxInspectionMs: 60000, reviewerPolicy: "none", councilPolicy: "disabled", humanApprovalBeforeWrite: false },
  T1: { maxProviderCalls: 1, maxConcurrentAgents: 1, maxReviewers: 0, maxRepairRounds: 0, maxAutomaticRetries: 0, maxCouncilRounds: 0, maxContextTokens: 24_000, maxInspectionTurns: 6, maxInspectionMs: 120000, reviewerPolicy: "none", councilPolicy: "disabled", humanApprovalBeforeWrite: false },
  T2: { maxProviderCalls: 2, maxConcurrentAgents: 1, maxReviewers: 1, maxRepairRounds: 1, maxAutomaticRetries: 1, maxCouncilRounds: 0, maxContextTokens: 48_000, maxInspectionTurns: 8, maxInspectionMs: 240000, reviewerPolicy: "optional", councilPolicy: "disabled", humanApprovalBeforeWrite: false },
  T3: { maxProviderCalls: 4, maxConcurrentAgents: 2, maxReviewers: 1, maxRepairRounds: 2, maxAutomaticRetries: 1, maxCouncilRounds: 0, maxContextTokens: 96_000, maxInspectionTurns: 10, maxInspectionMs: 420000, reviewerPolicy: "required", councilPolicy: "disabled", humanApprovalBeforeWrite: false },
  T4: { maxProviderCalls: 6, maxConcurrentAgents: 2, maxReviewers: 2, maxRepairRounds: 2, maxAutomaticRetries: 1, maxCouncilRounds: 1, maxContextTokens: 160_000, maxInspectionTurns: 12, maxInspectionMs: 600000, reviewerPolicy: "required", councilPolicy: "disagreement-only", humanApprovalBeforeWrite: false },
};

export function budgetFor(classification: TaskClassification, options: { writeRequested: boolean }): ExecutionBudget {
  const base = BASE_BUDGETS[classification.complexity];
  let budget: ExecutionBudget = { ...base };

  if (classification.risk === "high") {
    budget = {
      ...budget,
      maxProviderCalls: Math.max(budget.maxProviderCalls, 4),
      maxReviewers: Math.max(budget.maxReviewers, 1),
      reviewerPolicy: "required",
    };
  }

  if (classification.risk === "critical") {
    budget = {
      ...budget,
      maxProviderCalls: Math.max(budget.maxProviderCalls, 6),
      maxConcurrentAgents: Math.max(budget.maxConcurrentAgents, 2),
      maxReviewers: Math.max(budget.maxReviewers, 2),
      maxRepairRounds: Math.max(budget.maxRepairRounds, 2),
      maxCouncilRounds: Math.max(budget.maxCouncilRounds, 1),
      maxContextTokens: Math.max(budget.maxContextTokens, 160_000),
      reviewerPolicy: "required",
      councilPolicy: "disagreement-only",
      humanApprovalBeforeWrite: options.writeRequested,
    };
  }

  return Object.freeze(budget);
}

export interface BudgetSnapshot {
  readonly providerCalls: number;
  readonly activeAgents: number;
  readonly peakConcurrentAgents: number;
  readonly reviewers: number;
  readonly repairRounds: number;
  readonly automaticRetries: number;
  readonly councilRounds: number;
  readonly contextTokens: number;
}

export class BudgetTracker {
  readonly #budget: ExecutionBudget;
  #providerCalls = 0;
  #activeAgents = 0;
  #peakConcurrentAgents = 0;
  #reviewers = 0;
  #repairRounds = 0;
  #automaticRetries = 0;
  #councilRounds = 0;
  #contextTokens = 0;

  constructor(budget: ExecutionBudget) {
    this.#budget = budget;
  }

  reserveProviderCall(options: { reviewer?: boolean; contextTokens?: number } = {}): void {
    const contextTokens = options.contextTokens ?? 0;
    if (!Number.isInteger(contextTokens) || contextTokens < 0) {
      throw new BrainGateInvariantError("BUDGET_CONTEXT_INVALID", "contextTokens must be a non-negative integer.");
    }
    this.#assertBelow("BUDGET_PROVIDER_CALLS_EXCEEDED", this.#providerCalls, this.#budget.maxProviderCalls, "provider calls");
    if (options.reviewer) {
      this.#assertBelow("BUDGET_REVIEWERS_EXCEEDED", this.#reviewers, this.#budget.maxReviewers, "reviewers");
    }
    if (this.#contextTokens + contextTokens > this.#budget.maxContextTokens) {
      throw new BrainGateInvariantError("BUDGET_CONTEXT_EXCEEDED", "Task context budget would be exceeded.");
    }

    this.#providerCalls += 1;
    if (options.reviewer) this.#reviewers += 1;
    this.#contextTokens += contextTokens;
  }

  beginAgent(): () => void {
    this.#assertBelow("BUDGET_CONCURRENCY_EXCEEDED", this.#activeAgents, this.#budget.maxConcurrentAgents, "concurrent agents");
    this.#activeAgents += 1;
    this.#peakConcurrentAgents = Math.max(this.#peakConcurrentAgents, this.#activeAgents);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeAgents -= 1;
    };
  }

  recordRepairRound(): void {
    this.#assertBelow("BUDGET_REPAIRS_EXCEEDED", this.#repairRounds, this.#budget.maxRepairRounds, "repair rounds");
    this.#repairRounds += 1;
  }

  recordAutomaticRetry(): void {
    this.#assertBelow("BUDGET_RETRIES_EXCEEDED", this.#automaticRetries, this.#budget.maxAutomaticRetries, "automatic retries");
    this.#automaticRetries += 1;
  }

  recordCouncilRound(): void {
    if (this.#budget.councilPolicy === "disabled") {
      throw new BrainGateInvariantError("BUDGET_COUNCIL_DISABLED", "Council execution is disabled for this task.");
    }
    this.#assertBelow("BUDGET_COUNCIL_EXCEEDED", this.#councilRounds, this.#budget.maxCouncilRounds, "council rounds");
    this.#councilRounds += 1;
  }

  assertWriteApproval(approved: boolean): void {
    if (this.#budget.humanApprovalBeforeWrite && !approved) {
      throw new BrainGateInvariantError("BUDGET_HUMAN_APPROVAL_REQUIRED", "Human approval is required before this task may write.");
    }
  }

  snapshot(): BudgetSnapshot {
    return Object.freeze({
      providerCalls: this.#providerCalls,
      activeAgents: this.#activeAgents,
      peakConcurrentAgents: this.#peakConcurrentAgents,
      reviewers: this.#reviewers,
      repairRounds: this.#repairRounds,
      automaticRetries: this.#automaticRetries,
      councilRounds: this.#councilRounds,
      contextTokens: this.#contextTokens,
    });
  }

  #assertBelow(code: string, current: number, maximum: number, label: string): void {
    if (current >= maximum) {
      throw new BrainGateInvariantError(code, `Task budget exhausted for ${label}: ${current}/${maximum}.`);
    }
  }
}
