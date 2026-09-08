import { BrainGateInvariantError, BudgetTracker } from "@braingate/core";
import { CapabilityRouter, type IndependenceConstraint, type ModelRef, type RouteCandidate } from "@braingate/router";
import type { AgentInvoker, AgentRequest, AgentResponse, ReviewIndependence, WorkflowEvent, WorkflowInput, WorkflowOutcome, WorkflowReceipt } from "./types.js";

const MAX_FINDINGS = 8;
const MAX_FINDING_CHARS = 1_000;
const MAX_FINDINGS_TOTAL = 4_000;
const MAX_CANDIDATE_OUTPUT_CHARS = 100_000;

function modelRef(candidate: RouteCandidate): ModelRef {
  const definition = candidate.model.definition;
  return Object.freeze({ providerId: definition.providerId, modelId: definition.modelId, quotaPool: definition.quotaPool });
}

function reviewIndependence(primary: RouteCandidate, reviewer: RouteCandidate | null, input: WorkflowInput): ReviewIndependence {
  if (reviewer === null) return Object.freeze({ level: "none", sharedQuotaPool: false, humanApprovalRequired: false });
  const a = modelRef(primary);
  const b = modelRef(reviewer);
  const level = a.providerId !== b.providerId
    ? "cross-provider" as const
    : a.modelId !== b.modelId
      ? "same-provider-different-model" as const
      : "same-model-fresh-session" as const;
  const sensitiveArchitecture = input.classification.complexity === "T4" || input.classification.risk === "critical";
  return Object.freeze({
    level,
    sharedQuotaPool: a.quotaPool === b.quotaPool,
    humanApprovalRequired: sensitiveArchitecture && level !== "cross-provider",
  });
}

function boundFindings(values: readonly string[]): readonly string[] {
  const result: string[] = [];
  let total = 0;
  for (const value of values.slice(0, MAX_FINDINGS)) {
    if (total >= MAX_FINDINGS_TOTAL) break;
    const remaining = MAX_FINDINGS_TOTAL - total;
    const normalized = value.trim().slice(0, Math.min(MAX_FINDING_CHARS, remaining));
    if (normalized.length === 0) continue;
    result.push(normalized);
    total += normalized.length;
  }
  return Object.freeze(result);
}

function boundCandidateOutput(value: string | null): string | null {
  if (value === null) return null;
  return value.slice(0, MAX_CANDIDATE_OUTPUT_CHARS);
}

function candidateContextTokens(value: string | null): number {
  if (value === null) return 0;
  return Math.ceil(Array.from(value).length / 2);
}

function assertResponse(role: AgentRequest["role"], response: AgentResponse): void {
  if (role === "primary" && response.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Primary agent must return work output.");
  if (role === "reviewer" && response.kind !== "review") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Reviewer must return a review verdict.");
  if (role === "judge" && response.kind !== "judge") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Judge must return a judge verdict.");
}

function isNoEligibleModel(error: unknown): boolean {
  return error instanceof BrainGateInvariantError && error.code === "ROUTE_NO_ELIGIBLE_MODEL";
}

export class WorkflowEngine {
  readonly #router: CapabilityRouter;
  readonly #invoker: AgentInvoker;

  constructor(router: CapabilityRouter, invoker: AgentInvoker) {
    this.#router = router;
    this.#invoker = invoker;
  }

  async run(input: WorkflowInput): Promise<WorkflowReceipt> {
    const tracker = new BudgetTracker(input.budget);
    const events: WorkflowEvent[] = [];
    let sequence = 0;
    const emit = (kind: string, role: WorkflowEvent["role"], model: ModelRef | null, detail: string) => {
      events.push(Object.freeze({ sequence: ++sequence, kind, role, model, detail }));
    };

    const primaryExcluded = input.excludeProviders?.primary;
    const primaryRoute = this.#router.route({
      role: "coder",
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      writeRequired: input.writeRequired,
      ...(primaryExcluded === undefined ? {} : { excludeProviders: primaryExcluded }),
    });
    const primary = primaryRoute.selected;
    let finalOutput = "";

    const invoke = async (
      role: AgentRequest["role"],
      candidate: RouteCandidate,
      phase: string,
      findings: readonly string[],
      candidateOutput: string | null,
      reviewerLike: boolean,
    ): Promise<AgentResponse> => {
      const boundedCandidate = boundCandidateOutput(candidateOutput);
      tracker.reserveProviderCall({ reviewer: reviewerLike, contextTokens: input.requiredContextTokens + candidateContextTokens(boundedCandidate) });
      const release = tracker.beginAgent();
      const ref = modelRef(candidate);
      emit("agent.started", role, ref, phase);
      try {
        const response = await this.#invoker.invoke({ role, model: ref, phase, task: input.task, findings, candidateOutput: boundedCandidate });
        assertResponse(role, response);
        emit("agent.completed", role, ref, phase);
        return response;
      } finally {
        release();
      }
    };

    // A separate planning pass, on complex work only (ADR: the budget decides). The planner is
    // routed on its own capability, so the strongest model available decides the approach while
    // a cheaper one carries it out — which is the point of routing across a shared quota. Its
    // plan is handed to the executor as the candidate to work from, not as a suggestion.
    let plan: RouteCandidate | null = null;
    let approach: string | null = null;
    if (input.budget.separatePlanningPass) {
      // Planning has its own exclusion list. Reusing the executor's would tie the two together
      // exactly where they differ: a provider confined to a staged workspace can plan from the
      // task and the supplied context, and cannot execute against the checkout it never sees.
      const plannerExcluded = input.excludeProviders?.planner ?? primaryExcluded;
      try {
        plan = this.#router.route({
          role: "planner",
          classification: input.classification,
          budget: input.budget,
          requiredContextTokens: input.requiredContextTokens,
          writeRequired: false,
          ...(plannerExcluded === undefined ? {} : { excludeProviders: plannerExcluded }),
        }).selected;
      } catch (error) {
        // No model declares a planning capability. The task still runs; it simply plans and
        // executes in one pass, as it did before this stage existed.
        if (!isNoEligibleModel(error)) throw error;
        emit("planner.unavailable", "planner", null, "no model declares a planner capability");
      }
      if (plan !== null) {
        const planned = await invoke("planner", plan, "planning", [], null, false);
        if (planned.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Planner response was not work.");
        approach = planned.output;
      }
    }

    const initial = await invoke("primary", primary, "initial", [], approach, false);
    if (initial.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Primary response was not work.");
    finalOutput = initial.output;

    const needsReview = input.budget.reviewerPolicy === "required" || (input.budget.reviewerPolicy === "optional" && input.optionalReview);
    if (!needsReview) return this.#receipt(input, "completed_without_review", plan, primary, null, null, events, tracker, finalOutput);

    const primaryRef = modelRef(primary);
    const reviewerExcluded = input.excludeProviders?.reviewer;
    const routeReviewer = (independence: IndependenceConstraint): RouteCandidate => this.#router.route({
      role: "reviewer",
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens + candidateContextTokens(finalOutput),
      writeRequired: false,
      independence,
      ...(reviewerExcluded === undefined ? {} : { excludeProviders: reviewerExcluded }),
    }).selected;

    let reviewer: RouteCandidate;
    if (input.classification.risk === "critical") {
      reviewer = routeReviewer({ mode: "required", level: "cross-provider", models: [primaryRef] });
    } else {
      try {
        reviewer = routeReviewer({ mode: "required", level: "cross-provider", models: [primaryRef] });
      } catch (error) {
        if (!isNoEligibleModel(error)) throw error;
        try {
          reviewer = routeReviewer({ mode: "required", level: "different-model", models: [primaryRef] });
        } catch (differentModelError) {
          if (!isNoEligibleModel(differentModelError)) throw differentModelError;
          reviewer = routeReviewer({ mode: "preferred", level: "fresh-session", models: [primaryRef] });
        }
      }
    }

    const independence = reviewIndependence(primary, reviewer, input);
    emit("review.independence", "reviewer", modelRef(reviewer), `${independence.level};shared-quota=${independence.sharedQuotaPool};human-approval=${independence.humanApprovalRequired}`);

    let reviewerResponse = await invoke("reviewer", reviewer, "review-1", [], finalOutput, true);
    if (reviewerResponse.kind !== "review") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Reviewer response was not review.");
    emit(`review.${reviewerResponse.verdict}`, "reviewer", modelRef(reviewer), reviewerResponse.verdict);

    if (reviewerResponse.verdict === "approve") return this.#receipt(input, "approved", plan, primary, reviewer, null, events, tracker, finalOutput);

    if (reviewerResponse.verdict === "disagree") {
      return await this.#resolveDisagreement(input, plan, primary, reviewer, reviewerResponse.findings, events, tracker, finalOutput, invoke);
    }

    if (input.budget.maxRepairRounds < 1) return this.#receipt(input, "blocked_changes_required", plan, primary, reviewer, null, events, tracker, finalOutput);
    tracker.recordRepairRound();
    const findings = boundFindings(reviewerResponse.findings);
    const repair = await invoke("primary", primary, "repair-1", findings, finalOutput, false);
    if (repair.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Repair response was not work.");
    finalOutput = repair.output;
    emit("repair.completed", "primary", primaryRef, `findings:${findings.length}`);

    if (input.budget.maxReviewers < 2 || tracker.snapshot().providerCalls >= input.budget.maxProviderCalls) {
      return this.#receipt(input, "repaired_needs_review", plan, primary, reviewer, null, events, tracker, finalOutput);
    }

    reviewerResponse = await invoke("reviewer", reviewer, "review-2", [], finalOutput, true);
    if (reviewerResponse.kind !== "review") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Reviewer response was not review.");
    emit(`review.${reviewerResponse.verdict}`, "reviewer", modelRef(reviewer), reviewerResponse.verdict);
    if (reviewerResponse.verdict === "approve") return this.#receipt(input, "approved_after_repair", plan, primary, reviewer, null, events, tracker, finalOutput);
    if (reviewerResponse.verdict === "disagree") {
      return await this.#resolveDisagreement(input, plan, primary, reviewer, reviewerResponse.findings, events, tracker, finalOutput, invoke);
    }
    return this.#receipt(input, "repaired_needs_review", plan, primary, reviewer, null, events, tracker, finalOutput);
  }

  async #resolveDisagreement(
    input: WorkflowInput,
    plan: RouteCandidate | null,
    primary: RouteCandidate,
    reviewer: RouteCandidate,
    findings: readonly string[],
    events: WorkflowEvent[],
    tracker: BudgetTracker,
    finalOutput: string,
    invoke: (role: AgentRequest["role"], candidate: RouteCandidate, phase: string, findings: readonly string[], candidateOutput: string | null, reviewerLike: boolean) => Promise<AgentResponse>,
  ): Promise<WorkflowReceipt> {
    if (input.budget.councilPolicy !== "disagreement-only" || input.budget.maxCouncilRounds < 1) {
      return this.#receipt(input, "blocked_disagreement", plan, primary, reviewer, null, events, tracker, finalOutput);
    }
    if (tracker.snapshot().reviewers >= input.budget.maxReviewers || tracker.snapshot().providerCalls >= input.budget.maxProviderCalls) {
      return this.#receipt(input, "blocked_disagreement", plan, primary, reviewer, null, events, tracker, finalOutput);
    }
    tracker.recordCouncilRound();
    const judgeExcluded = input.excludeProviders?.judge;
    const judge = this.#router.route({
      role: "judge",
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens + candidateContextTokens(finalOutput),
      writeRequired: false,
      independence: { mode: "preferred", level: "cross-provider", models: [modelRef(primary), modelRef(reviewer)] },
      ...(judgeExcluded === undefined ? {} : { excludeProviders: judgeExcluded }),
    }).selected;
    const bounded = boundFindings(findings);
    const response = await invoke("judge", judge, "judge-1", bounded, finalOutput, true);
    if (response.kind !== "judge") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Judge response was not judge.");
    events.push(Object.freeze({ sequence: events.length + 1, kind: `judge.${response.verdict}`, role: "judge", model: modelRef(judge), detail: response.rationale.slice(0, 1_000) }));
    return this.#receipt(input, response.verdict === "approve" ? "approved_by_judge" : "blocked_changes_required", plan, primary, reviewer, judge, events, tracker, finalOutput);
  }

  #receipt(input: WorkflowInput, outcome: WorkflowOutcome, planner: RouteCandidate | null, primary: RouteCandidate, reviewer: RouteCandidate | null, judge: RouteCandidate | null, events: WorkflowEvent[], tracker: BudgetTracker, finalOutput: string): WorkflowReceipt {
    return Object.freeze({ outcome, planner, primary, reviewer, judge, reviewIndependence: reviewIndependence(primary, reviewer, input), events: Object.freeze([...events]), budget: tracker.snapshot(), finalOutput });
  }
}
