/**
 * Same-task, quota-refusal-only failover.
 *
 * The rule this implements is deliberately narrow. A role gets **one** extra attempt, and only when
 * the provider positively said it was refusing on quota in a structured way. Nothing else fails over:
 * a timeout, a generic non-zero exit, malformed output, a sandbox that did not apply, an auth
 * failure, a safety refusal and an unknown failure all stay normal failures, because none of them
 * tells us a *different* provider would do better — and guessing costs an operator's subscription.
 *
 * Two things make this safe rather than optimistic:
 *
 * 1. The refused **quota pool** is excluded for the rest of the task, and routing is re-run — not the
 *    precomputed fallback list consumed. The fallbacks were computed before the router knew the pool
 *    was refusing, and they routinely contain other models on the same pool; retrying those would
 *    spend a call to be refused again.
 * 2. The extra call is a real provider call: it goes through the same reservation as any other, so
 *    the tier's `maxProviderCalls` still bounds the task, and the usage accounting sees it.
 */
import { BrainGateInvariantError, quotaRefusalOf, type ExecutionBudget, type ProviderQuotaRefusal } from "@braingate/core";
import type { CapabilityRouter, ModelRef, RouteCandidate } from "@braingate/router";
import type { AgentResponse } from "./types.js";

/** One automatic failover per role. A second refusal is the end of the role. */
export const MAX_ROLE_FAILOVERS = 1;

export interface FailoverAttempt {
  readonly role: string;
  readonly candidate: RouteCandidate;
  readonly phase: string;
  readonly findings: readonly string[];
  readonly candidateOutput: string | null;
  readonly reviewerLike: boolean;
}

export type AttemptFn = (attempt: FailoverAttempt) => Promise<AgentResponse>;
export type RerouteFn = () => RouteCandidate;

export interface RoleFailoverDeps {
  readonly tracker: { readonly remainingProviderCalls: () => number };
  readonly budget: ExecutionBudget;
  readonly emit: (kind: string, role: string, model: ModelRef | null, detail: string) => void;
  readonly now?: () => Date;
}

export interface Dispatched {
  readonly response: AgentResponse;
  /** The candidate that actually produced the response — after a failover, the second one. */
  readonly candidate: RouteCandidate;
  readonly failover: ProviderQuotaRefusal | null;
}

export class RoleFailover {
  readonly #deps: RoleFailoverDeps;
  readonly #excludedPools = new Set<string>();
  readonly #attempts = new Map<string, number>();

  constructor(deps: RoleFailoverDeps) {
    this.#deps = deps;
  }

  /**
   * Pools a provider has refused in this task, for the router to avoid.
   *
   * Read at route time, not captured when routing started: a planner refused early must be excluded
   * from every later decision in the same task, including the reviewer's and the judge's.
   */
  routeOptions(): { readonly excludeQuotaPools?: readonly string[] } {
    return this.#excludedPools.size === 0 ? {} : { excludeQuotaPools: Object.freeze([...this.#excludedPools]) };
  }

  get excludedQuotaPools(): readonly string[] { return Object.freeze([...this.#excludedPools]); }

  /** Every refusal seen in this task, in order, for the record. */
  readonly refusals: ProviderQuotaRefusal[] = [];

  async dispatch(attempt: FailoverAttempt, run: AttemptFn, reroute: RerouteFn): Promise<Dispatched> {
    try {
      return Object.freeze({ response: await run(attempt), candidate: attempt.candidate, failover: null });
    } catch (error) {
      const refusal = quotaRefusalOf(error);
      if (refusal === null) throw error;
      this.refusals.push(refusal);
      const from = ref(attempt.candidate);
      const used = this.#attempts.get(attempt.role) ?? 0;
      if (used >= MAX_ROLE_FAILOVERS) {
        this.#deps.emit("role.failover.failed", attempt.role, from, `failover-limit:${refusal.reason}:${refusal.quotaPool}`);
        throw error;
      }
      // The failed attempt spent its reservation, so this is the honest place to look: a task with no
      // calls left does not get a second one, however clearly the first was refused.
      if (this.#deps.tracker.remainingProviderCalls() <= 0) {
        this.#deps.emit("role.failover.failed", attempt.role, from, `budget-exhausted:${refusal.quotaPool}`);
        throw error;
      }

      this.#excludedPools.add(refusal.quotaPool);
      this.#deps.emit("role.failover.started", attempt.role, from, `${refusal.reason}:${refusal.quotaPool}`);
      let next: RouteCandidate;
      try {
        // Re-route with the pool excluded: the router decides who is next, from the same capability,
        // role, security and independence rules that chose this candidate in the first place.
        next = reroute();
      } catch (routeError) {
        this.#deps.emit("role.failover.failed", attempt.role, from, `no-eligible-fallback:${refusal.quotaPool}`);
        throw new BrainGateInvariantError(
          "ROLE_NO_ELIGIBLE_FALLBACK",
          `The ${attempt.role} provider refused this call on quota (${refusal.reason}, pool ${refusal.quotaPool}), and no other eligible model remains for ${attempt.role} once that pool is excluded. ${routeError instanceof Error ? routeError.message : String(routeError)}`,
        );
      }
      this.#attempts.set(attempt.role, used + 1);
      const to = ref(next);
      this.#deps.emit("role.failover.selected", attempt.role, to, `${from.providerId}/${from.modelId}->${to.providerId}/${to.modelId}:${refusal.quotaPool}`);
      try {
        const response = await run({ ...attempt, candidate: next });
        this.#deps.emit("role.failover.completed", attempt.role, to, attempt.phase);
        return Object.freeze({ response, candidate: next, failover: refusal });
      } catch (secondError) {
        const code = codeOf(secondError);
        // The second attempt is a real provider call, so it needs a real reservation — a role-limited
        // budget (one reviewer, for instance) can refuse it. That is not a provider failure: the
        // refusal remains the reason this task failed, and the record says what stopped the retry.
        if (code.startsWith("BUDGET_")) {
          this.#deps.emit("role.failover.failed", attempt.role, to, `budget:${code}`);
          throw error;
        }
        this.#deps.emit("role.failover.failed", attempt.role, to, `fallback-failed:${code}`);
        throw secondError;
      }
    }
  }
}

function ref(candidate: RouteCandidate): ModelRef {
  const definition = candidate.model.definition;
  return Object.freeze({ providerId: definition.providerId, modelId: definition.modelId, quotaPool: definition.quotaPool });
}

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

export type { CapabilityRouter };
