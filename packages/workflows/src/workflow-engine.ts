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

/**
 * Two independent approaches, as one brief the executor can act on.
 *
 * Not a summary and not a vote: summarising would need a third model, and voting would discard
 * the half that was right about the part the other missed. They are labelled by provider and
 * handed over whole, with the instruction that reconciling them is part of the work — which is
 * what the executor is for.
 */
export function mergedApproaches(plans: readonly { readonly model: ModelRef; readonly output: string }[]): string {
  const sections = plans.map((plan, index) => [
    `## Approach ${String(index + 1)} — ${plan.model.providerId}/${plan.model.modelId}`,
    "",
    plan.output.trim(),
  ].join("\n"));
  return [
    "Two independent approaches to this task were produced in parallel by different providers.",
    "Where they agree, follow them. Where they differ, choose the one better supported by the",
    "context you were given and say in your output which you followed and why.",
    "",
    ...sections,
  ].join("\n");
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
    let secondPlan: RouteCandidate | null = null;
    let approach: string | null = null;
    if (input.budget.separatePlanningPass && input.budget.maxPlanners > 0) {
      // Planning has its own exclusion list. Reusing the executor's would tie the two together
      // exactly where they differ: a provider confined to a staged workspace can plan from the
      // task and the supplied context, and cannot execute against the checkout it never sees.
      const plannerExcluded = input.excludeProviders?.planner ?? primaryExcluded;
      const routePlanner = (independence?: IndependenceConstraint): RouteCandidate => this.#router.route({
        role: "planner",
        classification: input.classification,
        budget: input.budget,
        requiredContextTokens: input.requiredContextTokens,
        writeRequired: false,
        ...(independence === undefined ? {} : { independence }),
        ...(plannerExcluded === undefined ? {} : { excludeProviders: plannerExcluded }),
      }).selected;

      try {
        plan = routePlanner();
      } catch (error) {
        // No model declares a planning capability. The task still runs; it simply plans and
        // executes in one pass, as it did before this stage existed.
        if (!isNoEligibleModel(error)) throw error;
        emit("planner.unavailable", "planner", null, "no model declares a planner capability");
      }

      // A second opinion is worth having only from somewhere else. Two planners on one
      // subscription share a pool, a model family and the same blind spot, and cost twice for
      // the privilege — so this is cross-provider or it does not happen.
      if (plan !== null && input.budget.maxPlanners > 1 && tracker.remainingProviderCalls() > 1) {
        try {
          secondPlan = routePlanner({ mode: "required", level: "cross-provider", models: [modelRef(plan)] });
        } catch (error) {
          if (!isNoEligibleModel(error)) throw error;
          emit("planner.single", "planner", modelRef(plan), "no independent provider was available for a second approach");
        }
      }

      if (plan !== null && secondPlan === null) {
        const planned = await invoke("planner", plan, "planning", [], null, false);
        if (planned.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Planner response was not work.");
        approach = planned.output;
      } else if (plan !== null && secondPlan !== null) {
        // Together, not in turn: the concurrency the budget already grants is what makes a
        // second subscription free in wall-clock terms rather than twice as slow.
        const [first, second] = await Promise.all([
          invoke("planner", plan, "planning-a", [], null, false),
          invoke("planner", secondPlan, "planning-b", [], null, false),
        ]);
        if (first.kind !== "work" || second.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Planner response was not work.");
        approach = mergedApproaches([
          { model: modelRef(plan), output: first.output },
          { model: modelRef(secondPlan), output: second.output },
        ]);
        emit("planner.parallel", "planner", modelRef(secondPlan), `${modelRef(plan).providerId}+${modelRef(secondPlan).providerId}`);
      }
    }

    const initial = await invoke("primary", primary, "initial", [], approach, false);
    if (initial.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Primary response was not work.");
    finalOutput = initial.output;

    const needsReview = input.budget.reviewerPolicy === "required" || (input.budget.reviewerPolicy === "optional" && input.optionalReview);
    if (!needsReview) return this.#receipt(input, "completed_without_review", plan, primary, null, null, events, tracker, finalOutput, secondPlan);

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

    if (reviewerResponse.verdict === "approve") return this.#receipt(input, "approved", plan, primary, reviewer, null, events, tracker, finalOutput, secondPlan);

    if (reviewerResponse.verdict === "disagree") {
      return await this.#resolveDisagreement(input, plan, primary, reviewer, reviewerResponse.findings, events, tracker, finalOutput, invoke, secondPlan);
    }

    if (input.budget.maxRepairRounds < 1) return this.#receipt(input, "blocked_changes_required", plan, primary, reviewer, null, events, tracker, finalOutput, secondPlan);
    tracker.recordRepairRound();
    const findings = boundFindings(reviewerResponse.findings);
    const repair = await invoke("primary", primary, "repair-1", findings, finalOutput, false);
    if (repair.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Repair response was not work.");
    finalOutput = repair.output;
    emit("repair.completed", "primary", primaryRef, `findings:${findings.length}`);

    if (input.budget.maxReviewers < 2 || tracker.snapshot().providerCalls >= input.budget.maxProviderCalls) {
      return this.#receipt(input, "repaired_needs_review", plan, primary, reviewer, null, events, tracker, finalOutput, secondPlan);
    }

    reviewerResponse = await invoke("reviewer", reviewer, "review-2", [], finalOutput, true);
    if (reviewerResponse.kind !== "review") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Reviewer response was not review.");
    emit(`review.${reviewerResponse.verdict}`, "reviewer", modelRef(reviewer), reviewerResponse.verdict);
    if (reviewerResponse.verdict === "approve") return this.#receipt(input, "approved_after_repair", plan, primary, reviewer, null, events, tracker, finalOutput, secondPlan);
    if (reviewerResponse.verdict === "disagree") {
      return await this.#resolveDisagreement(input, plan, primary, reviewer, reviewerResponse.findings, events, tracker, finalOutput, invoke, secondPlan);
    }
    return this.#receipt(input, "repaired_needs_review", plan, primary, reviewer, null, events, tracker, finalOutput, secondPlan);
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
    secondPlanner: RouteCandidate | null = null,
  ): Promise<WorkflowReceipt> {
    if (input.budget.councilPolicy !== "disagreement-only" || input.budget.maxCouncilRounds < 1) {
      return this.#receipt(input, "blocked_disagreement", plan, primary, reviewer, null, events, tracker, finalOutput, secondPlanner);
    }
    if (tracker.snapshot().reviewers >= input.budget.maxReviewers || tracker.snapshot().providerCalls >= input.budget.maxProviderCalls) {
      return this.#receipt(input, "blocked_disagreement", plan, primary, reviewer, null, events, tracker, finalOutput, secondPlanner);
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
    return this.#receipt(input, response.verdict === "approve" ? "approved_by_judge" : "blocked_changes_required", plan, primary, reviewer, judge, events, tracker, finalOutput, secondPlanner);
  }

  #receipt(input: WorkflowInput, outcome: WorkflowOutcome, planner: RouteCandidate | null, primary: RouteCandidate, reviewer: RouteCandidate | null, judge: RouteCandidate | null, events: WorkflowEvent[], tracker: BudgetTracker, finalOutput: string, secondPlanner: RouteCandidate | null = null): WorkflowReceipt {
    return Object.freeze({ outcome, planner, secondPlanner, primary, reviewer, judge, reviewIndependence: reviewIndependence(primary, reviewer, input), events: Object.freeze([...events]), budget: tracker.snapshot(), finalOutput });
  }
}
