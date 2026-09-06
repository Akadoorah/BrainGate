import {
  BrainGateInvariantError,
  type ExecutionBudget,
  type RegisteredProject,
  type TaskClassification,
  type TaskLedger,
  type TaskReceipt,
} from "@braingate/core";
import { buildTaskBrief, recordTaskBrief, recordWorkflowReceipt } from "@braingate/observability";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type ModelRef, type RouteResult } from "@braingate/router";
import { WorkflowEngine, type WorkflowReceipt } from "@braingate/workflows";
import { SubscriptionShadowAgentInvoker } from "./invoker.js";
import { planShadowInvocation, shadowProviderStatus } from "./profiles.js";
import { assertShadowProjectCwd } from "./process-executor.js";
import type { ShadowProcessExecutor, ShadowRolePayload, SubscriptionAttestation } from "./types.js";

function modelRef(route: RouteResult): ModelRef {
  const definition = route.selected.model.definition;
  return Object.freeze({ providerId: definition.providerId, modelId: definition.modelId, quotaPool: definition.quotaPool });
}

function preflightPayload(role: "primary" | "reviewer", task: string, context: unknown): ShadowRolePayload {
  return Object.freeze({ schemaVersion: 1, role, phase: "preflight", task, findings: Object.freeze([]), context, responseContract: Object.freeze(role === "primary" ? { kind: "work", output: "string" } : { kind: "review", verdict: ["approve", "request_changes", "disagree"], findings: "string[]" }) });
}

function snapshotFor(snapshots: readonly ProviderSnapshot[], providerId: string): ProviderSnapshot {
  const snapshot = snapshots.find((candidate) => candidate.providerId === providerId);
  if (snapshot === undefined) throw new BrainGateInvariantError("SHADOW_SNAPSHOT_MISSING", `No provider discovery snapshot for ${providerId}.`);
  return snapshot;
}

function attestationFor(attestations: readonly SubscriptionAttestation[], providerId: string): Readonly<{ attestation?: SubscriptionAttestation }> {
  const attestation = attestations.find((item) => item.providerId === providerId);
  return attestation === undefined ? Object.freeze({}) : Object.freeze({ attestation });
}

export interface ShadowDogfoodResult {
  readonly dryRun: boolean;
  readonly taskId: string;
  readonly taskReceipt: TaskReceipt;
  readonly workflow: WorkflowReceipt | null;
}

export class ShadowDogfoodRunner {
  readonly #project: RegisteredProject;
  readonly #ledger: TaskLedger;
  readonly #router: CapabilityRouter;
  readonly #snapshots: readonly ProviderSnapshot[];
  readonly #attestations: readonly SubscriptionAttestation[];
  readonly #executor: ShadowProcessExecutor | undefined;

  constructor(input: {
    readonly project: RegisteredProject;
    readonly ledger: TaskLedger;
    readonly router: CapabilityRouter;
    readonly snapshots: readonly ProviderSnapshot[];
    readonly attestations?: readonly SubscriptionAttestation[];
    readonly executor?: ShadowProcessExecutor;
  }) {
    this.#project = input.project;
    this.#ledger = input.ledger;
    this.#router = input.router;
    this.#snapshots = input.snapshots;
    this.#attestations = input.attestations ?? [];
    this.#executor = input.executor;
  }

  async run(input: {
    readonly title: string;
    readonly task: string;
    readonly cwd: string;
    readonly classification: TaskClassification;
    readonly budget: ExecutionBudget;
    readonly requiredContextTokens: number;
    readonly context: unknown;
    readonly contextSummary: {
      readonly memoryRecords: number;
      readonly explicitCandidates: number;
      readonly includedItems: number;
      readonly estimatedTokens: number;
      readonly truncatedItems: number;
      readonly sourceLabels?: readonly string[];
    };
    readonly optionalReview?: boolean;
    readonly dryRun?: boolean;
  }): Promise<ShadowDogfoodResult> {
    if (input.task.trim().length === 0) throw new BrainGateInvariantError("SHADOW_TASK_INVALID", "Shadow task must be non-empty.");
    if (input.requiredContextTokens > input.budget.maxContextTokens) throw new BrainGateInvariantError("SHADOW_CONTEXT_BUDGET", "Required context exceeds the task Budget Governor limit.");
    const cwd = assertShadowProjectCwd(this.#project, input.cwd);
    const excludedProviders = this.#snapshots.filter((snapshot) => !shadowProviderStatus(snapshot.providerId).enabled).map((snapshot) => snapshot.providerId);

    const primaryRoute = this.#router.route({ role: "coder", classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: false, excludeProviders: excludedProviders });
    const routes: RouteResult[] = [primaryRoute];
    const primaryRef = modelRef(primaryRoute);
    const primarySnapshot = snapshotFor(this.#snapshots, primaryRef.providerId);
    planShadowInvocation({ snapshot: primarySnapshot, model: primaryRef, cwd, payload: preflightPayload("primary", input.task, input.context), ...attestationFor(this.#attestations, primaryRef.providerId) });

    const needsReview = input.budget.reviewerPolicy === "required" || (input.budget.reviewerPolicy === "optional" && (input.optionalReview ?? false));
    if (needsReview) {
      const independence = input.classification.risk === "high" || input.classification.risk === "critical"
        ? { mode: "required" as const, models: [primaryRef] }
        : { mode: "preferred" as const, models: [primaryRef] };
      const reviewerRoute = this.#router.route({ role: "reviewer", classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: false, independence, excludeProviders: excludedProviders });
      routes.push(reviewerRoute);
      const reviewerRef = modelRef(reviewerRoute);
      planShadowInvocation({ snapshot: snapshotFor(this.#snapshots, reviewerRef.providerId), model: reviewerRef, cwd, payload: preflightPayload("reviewer", input.task, input.context), ...attestationFor(this.#attestations, reviewerRef.providerId) });
    }

    const task = this.#ledger.createTask({ title: input.title, complexity: input.classification.complexity, risk: input.classification.risk });
    this.#ledger.transition(task.taskId, "planned", { shadow: true, dryRun: input.dryRun ?? false });
    const brief = buildTaskBrief({
      project: this.#project,
      task: this.#ledger.requireTask(task.taskId),
      classification: input.classification,
      budget: input.budget,
      routes,
      context: input.contextSummary,
      permissions: { executionProfile: "shadow-read-only", networkAllowed: false },
      worktree: { enabled: false, taskWorktreeLabel: null },
    });
    recordTaskBrief(this.#ledger, brief);

    if (input.dryRun ?? false) {
      this.#ledger.appendEvent(task.taskId, "shadow.dry_run", { providers: routes.map((route) => route.selected.model.definition.providerId), roles: routes.map((route) => route.role), providerCalls: 0 });
      this.#ledger.transition(task.taskId, "running", { dryRun: true, providerCalls: 0 });
      this.#ledger.transition(task.taskId, "completed", { dryRun: true, providerCalls: 0 });
      return Object.freeze({ dryRun: true, taskId: task.taskId, taskReceipt: this.#ledger.receipt(task.taskId), workflow: null });
    }

    this.#ledger.transition(task.taskId, "running", { shadow: true });
    try {
      const invoker = new SubscriptionShadowAgentInvoker({
        project: this.#project,
        cwd,
        snapshots: this.#snapshots,
        attestations: this.#attestations,
        context: input.context,
        ...(this.#executor === undefined ? {} : { executor: this.#executor }),
        ledger: this.#ledger,
        taskId: task.taskId,
      });
      const workflow = await new WorkflowEngine(this.#router, invoker).run({
        task: input.task,
        classification: input.classification,
        budget: input.budget,
        requiredContextTokens: input.requiredContextTokens,
        writeRequired: false,
        optionalReview: input.optionalReview ?? false,
      });
      this.#ledger.transition(task.taskId, "verifying", { shadow: true, outcome: workflow.outcome });
      recordWorkflowReceipt(this.#ledger, task.taskId, workflow);
      this.#ledger.transition(task.taskId, "completed", { shadow: true, outcome: workflow.outcome });
      return Object.freeze({ dryRun: false, taskId: task.taskId, taskReceipt: this.#ledger.receipt(task.taskId), workflow });
    } catch (error) {
      const current = this.#ledger.requireTask(task.taskId);
      if (current.state === "running" || current.state === "verifying" || current.state === "planned") {
        this.#ledger.transition(task.taskId, "failed", { shadow: true, code: error instanceof BrainGateInvariantError ? error.code : "UNKNOWN" });
      }
      throw error;
    }
  }
}
