import { BrainGateInvariantError, BudgetTracker } from "@braingate/core";
import { CapabilityRouter, type ModelRef, type RouteCandidate } from "@braingate/router";
import type { AgentInvoker, AgentRequest, AgentResponse, WorkflowEvent, WorkflowInput, WorkflowOutcome, WorkflowReceipt } from "./types.js";

const MAX_FINDINGS = 8;
const MAX_FINDING_CHARS = 1_000;
const MAX_FINDINGS_TOTAL = 4_000;

function modelRef(candidate: RouteCandidate): ModelRef {
  const definition = candidate.model.definition;
  return Object.freeze({ providerId: definition.providerId, modelId: definition.modelId, quotaPool: definition.quotaPool });
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

function assertResponse(role: AgentRequest["role"], response: AgentResponse): void {
  if (role === "primary" && response.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Primary agent must return work output.");
  if (role === "reviewer" && response.kind !== "review") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Reviewer must return a review verdict.");
  if (role === "judge" && response.kind !== "judge") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Judge must return a judge verdict.");
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

    const primaryRoute = this.#router.route({
      role: "coder",
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      writeRequired: input.writeRequired,
      excludeProviders: input.excludeProviders?.primary,
    });
    const primary = primaryRoute.selected;
    let finalOutput = "";

    const invoke = async (role: AgentRequest["role"], candidate: RouteCandidate, phase: string, findings: readonly string[], reviewerLike: boolean): Promise<AgentResponse> => {
      tracker.reserveProviderCall({ reviewer: reviewerLike, contextTokens: input.requiredContextTokens });
      const release = tracker.beginAgent();
      const ref = modelRef(candidate);
      emit("agent.started", role, ref, phase);
      try {
        const response = await this.#invoker.invoke({ role, model: ref, phase, task: input.task, findings });
        assertResponse(role, response);
        emit("agent.completed", role, ref, phase);
        return response;
      } finally {
        release();
      }
    };

    const initial = await invoke("primary", primary, "initial", [], false);
    if (initial.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Primary response was not work.");
    finalOutput = initial.output;

    const needsReview = input.budget.reviewerPolicy === "required" || (input.budget.reviewerPolicy === "optional" && input.optionalReview);
    if (!needsReview) return this.#receipt("completed_without_review", primary, null, null, events, tracker, finalOutput);

    const primaryRef = modelRef(primary);
    const reviewerIndependence = input.classification.risk === "high" || input.classification.risk === "critical"
      ? { mode: "required" as const, models: [primaryRef] }
      : { mode: "preferred" as const, models: [primaryRef] };
    const reviewer = this.#router.route({
      role: "reviewer",
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      writeRequired: false,
      independence: reviewerIndependence,
      excludeProviders: input.excludeProviders?.reviewer,
    }).selected;
    let reviewerResponse = await invoke("reviewer", reviewer, "review-1", [], true);
    if (reviewerResponse.kind !== "review") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Reviewer response was not review.");
    emit(`review.${reviewerResponse.verdict}`, "reviewer", modelRef(reviewer), reviewerResponse.verdict);

    if (reviewerResponse.verdict === "approve") return this.#receipt("approved", primary, reviewer, null, events, tracker, finalOutput);

    if (reviewerResponse.verdict === "disagree") {
      return await this.#resolveDisagreement(input, primary, reviewer, reviewerResponse.findings, events, tracker, finalOutput, invoke);
    }

    if (input.budget.maxRepairRounds < 1) return this.#receipt("blocked_changes_required", primary, reviewer, null, events, tracker, finalOutput);
    tracker.recordRepairRound();
    const findings = boundFindings(reviewerResponse.findings);
    const repair = await invoke("primary", primary, "repair-1", findings, false);
    if (repair.kind !== "work") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Repair response was not work.");
    finalOutput = repair.output;
    emit("repair.completed", "primary", primaryRef, `findings:${findings.length}`);

    if (input.budget.maxReviewers < 2 || tracker.snapshot().providerCalls >= input.budget.maxProviderCalls) {
      return this.#receipt("repaired_needs_review", primary, reviewer, null, events, tracker, finalOutput);
    }

    reviewerResponse = await invoke("reviewer", reviewer, "review-2", [], true);
    if (reviewerResponse.kind !== "review") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Reviewer response was not review.");
    emit(`review.${reviewerResponse.verdict}`, "reviewer", modelRef(reviewer), reviewerResponse.verdict);
    if (reviewerResponse.verdict === "approve") return this.#receipt("approved_after_repair", primary, reviewer, null, events, tracker, finalOutput);
    if (reviewerResponse.verdict === "disagree") {
      return await this.#resolveDisagreement(input, primary, reviewer, reviewerResponse.findings, events, tracker, finalOutput, invoke);
    }
    return this.#receipt("repaired_needs_review", primary, reviewer, null, events, tracker, finalOutput);
  }

  async #resolveDisagreement(
    input: WorkflowInput,
    primary: RouteCandidate,
    reviewer: RouteCandidate,
    findings: readonly string[],
    events: WorkflowEvent[],
    tracker: BudgetTracker,
    finalOutput: string,
    invoke: (role: AgentRequest["role"], candidate: RouteCandidate, phase: string, findings: readonly string[], reviewerLike: boolean) => Promise<AgentResponse>,
  ): Promise<WorkflowReceipt> {
    if (input.budget.councilPolicy !== "disagreement-only" || input.budget.maxCouncilRounds < 1) {
      return this.#receipt("blocked_disagreement", primary, reviewer, null, events, tracker, finalOutput);
    }
    if (tracker.snapshot().reviewers >= input.budget.maxReviewers || tracker.snapshot().providerCalls >= input.budget.maxProviderCalls) {
      return this.#receipt("blocked_disagreement", primary, reviewer, null, events, tracker, finalOutput);
    }
    tracker.recordCouncilRound();
    const judge = this.#router.route({
      role: "judge",
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      writeRequired: false,
      independence: { mode: "preferred", models: [modelRef(primary), modelRef(reviewer)] },
      excludeProviders: input.excludeProviders?.judge,
    }).selected;
    const bounded = boundFindings(findings);
    const response = await invoke("judge", judge, "judge-1", bounded, true);
    if (response.kind !== "judge") throw new BrainGateInvariantError("WORKFLOW_RESPONSE_INVALID", "Judge response was not judge.");
    events.push(Object.freeze({ sequence: events.length + 1, kind: `judge.${response.verdict}`, role: "judge", model: modelRef(judge), detail: response.rationale.slice(0, 1_000) }));
    return this.#receipt(response.verdict === "approve" ? "approved_by_judge" : "blocked_changes_required", primary, reviewer, judge, events, tracker, finalOutput);
  }

  #receipt(outcome: WorkflowOutcome, primary: RouteCandidate, reviewer: RouteCandidate | null, judge: RouteCandidate | null, events: WorkflowEvent[], tracker: BudgetTracker, finalOutput: string): WorkflowReceipt {
    return Object.freeze({ outcome, primary, reviewer, judge, events: Object.freeze([...events]), budget: tracker.snapshot(), finalOutput });
  }
}
