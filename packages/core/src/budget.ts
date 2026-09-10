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
   * Tool-use turns an inspection may spend before BrainGate treats the run as runaway.
   *
   * This is a ceiling, not a budget, and the difference matters. Truncating at a turn limit does
   * not buy half an answer for half the price: the run ends with no result at all, and every
   * turn already spent is wasted. A limit set where work becomes expensive therefore costs more
   * than it saves — it converts a completed task into a failed one at nearly the same price.
   *
   * Cost is controlled where it is actually decided: by which model is doing the reading. The
   * same twenty files cost very differently through a deep model than a fast one, and routing
   * already chooses that. These numbers exist to stop pathology — a loop, a model that never
   * concludes — not to stop ordinary work.
   */
  readonly maxInspectionTurns: number;
  /**
   * Wall-clock allowance for one inspection, and the other half of the runaway bound. Set so a
   * task that is working normally finishes inside it, since a timeout wastes the run exactly as
   * a turn limit does.
   */
  readonly maxInspectionMs: number;
  /**
   * Whether the approach is decided by a separate, stronger model before the work is carried out.
   *
   * Off for small tasks: a plan for a one-line change costs a provider call and decides nothing.
   */
  readonly separatePlanningPass: boolean;
  /**
   * How many independent subscriptions may decide the approach at once.
   *
   * One is a plan. Two is two plans from providers that do not share a pool, a training set or a
   * blind spot, handed to the executor together — which is the only reason to own several
   * subscriptions rather than the best one.
   *
   * It is explicit policy rather than a consequence of `maxConcurrentAgents`, because
   * multi-agent execution is opt-in here by rule: a tier that has not asked for a second opinion
   * must not acquire one because the concurrency ceiling happened to allow it.
   */
  readonly maxPlanners: number;
  /**
   * Agent executions a task may spend *inside* providers, across every role.
   *
   * `maxConcurrentAgents` bounds what BrainGate runs; this bounds what a provider runs on its
   * own behalf once it has been handed helpers. Without it the two are not the same number and
   * only one of them is enforced, which is how an orchestrator turns into a swarm nobody
   * authorised — the fan-out was granted once and then never counted again.
   */
  readonly maxProviderSubagents: number;
  readonly reviewerPolicy: ReviewerPolicy;
  readonly councilPolicy: CouncilPolicy;
  readonly humanApprovalBeforeWrite: boolean;
}

const BASE_BUDGETS: Readonly<Record<TaskComplexity, ExecutionBudget>> = {
  T0: { maxProviderCalls: 1, maxConcurrentAgents: 1, maxReviewers: 0, maxRepairRounds: 0, maxAutomaticRetries: 0, maxCouncilRounds: 0, maxContextTokens: 12_000, maxInspectionTurns: 15, maxInspectionMs: 180000, maxProviderSubagents: 0, maxPlanners: 0, separatePlanningPass: false, reviewerPolicy: "none", councilPolicy: "disabled", humanApprovalBeforeWrite: false },
  T1: { maxProviderCalls: 1, maxConcurrentAgents: 1, maxReviewers: 0, maxRepairRounds: 0, maxAutomaticRetries: 0, maxCouncilRounds: 0, maxContextTokens: 24_000, maxInspectionTurns: 20, maxInspectionMs: 300000, maxProviderSubagents: 0, maxPlanners: 0, separatePlanningPass: false, reviewerPolicy: "none", councilPolicy: "disabled", humanApprovalBeforeWrite: false },
  T2: { maxProviderCalls: 2, maxConcurrentAgents: 1, maxReviewers: 1, maxRepairRounds: 1, maxAutomaticRetries: 1, maxCouncilRounds: 0, maxContextTokens: 48_000, maxInspectionTurns: 25, maxInspectionMs: 420000, maxProviderSubagents: 0, maxPlanners: 0, separatePlanningPass: false, reviewerPolicy: "optional", councilPolicy: "disabled", humanApprovalBeforeWrite: false },
  T3: { maxProviderCalls: 4, maxConcurrentAgents: 2, maxReviewers: 1, maxRepairRounds: 2, maxAutomaticRetries: 1, maxCouncilRounds: 0, maxContextTokens: 96_000, maxInspectionTurns: 35, maxInspectionMs: 600000, maxProviderSubagents: 2, maxPlanners: 1, separatePlanningPass: true, reviewerPolicy: "required", councilPolicy: "disabled", humanApprovalBeforeWrite: false },
  T4: { maxProviderCalls: 6, maxConcurrentAgents: 2, maxReviewers: 2, maxRepairRounds: 2, maxAutomaticRetries: 1, maxCouncilRounds: 1, maxContextTokens: 160_000, maxInspectionTurns: 50, maxInspectionMs: 900000, maxProviderSubagents: 4, maxPlanners: 2, separatePlanningPass: true, reviewerPolicy: "required", councilPolicy: "disagreement-only", humanApprovalBeforeWrite: false },
};

export function budgetFor(classification: TaskClassification, options: { writeRequested: boolean }): ExecutionBudget {
  const base = BASE_BUDGETS[classification.complexity];
  let budget: ExecutionBudget = { ...base };

  // A sensitive question is worth a second opinion, not a mandatory one. Medium risk makes the
  // reviewer reachable — `--review` now does something — while leaving a lookup priced as a
  // lookup. Without this the choice was "one call, no review available" or "four calls with a
  // planner", and a question about auth kept landing on the wrong side of it.
  if (classification.risk === "medium" && budget.reviewerPolicy === "none") {
    budget = {
      ...budget,
      maxProviderCalls: Math.max(budget.maxProviderCalls, 2),
      maxReviewers: Math.max(budget.maxReviewers, 1),
      reviewerPolicy: "optional",
    };
  }

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
      // Critical work gets the second opinion whatever tier it was classified as.
      maxPlanners: Math.max(budget.maxPlanners, 2),
      maxProviderSubagents: Math.max(budget.maxProviderSubagents, 4),
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

  /**
   * Provider calls still available.
   *
   * Asked before a fan-out rather than discovered inside one: two planners that start together
   * and then fail the second reservation have spent a call for an answer nobody can use.
   */
  remainingProviderCalls(): number {
    return Math.max(0, this.#budget.maxProviderCalls - this.#providerCalls);
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
