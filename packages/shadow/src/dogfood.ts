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
import { WorkflowEngine, type WorkflowReceipt, type WorkflowRole } from "@braingate/workflows";
import type { CodexIsolationAttestation } from "./codex-isolation.js";
import type { GrokIsolationAttestation } from "./grok-isolation.js";
import { SubscriptionShadowAgentInvoker, type RoleActivity } from "./invoker.js";
import type { QuotaReading } from "./quota-readings.js";
import { planShadowInvocation, shadowProviderRoleStatus } from "./profiles.js";
import { assertShadowProjectCwd } from "./process-executor.js";
import { assertSourceCheckoutUnchanged, sourceCheckoutFingerprint } from "./source-guard.js";
import type { OperatorProviderAcceptance, ShadowProcessExecutor, ShadowRolePayload, SubscriptionAttestation } from "./types.js";

function modelRef(route: RouteResult): ModelRef {
  const definition = route.selected.model.definition;
  return Object.freeze({ providerId: definition.providerId, modelId: definition.modelId, quotaPool: definition.quotaPool });
}

function preflightPayload(role: "primary" | "reviewer", task: string, context: unknown): ShadowRolePayload {
  return Object.freeze({ schemaVersion: 1, role, phase: "preflight", task, findings: Object.freeze([]), candidateOutput: null, context, responseContract: Object.freeze(role === "primary" ? { kind: "work", output: "string" } : { kind: "review", verdict: ["approve", "request_changes", "disagree"], findings: "string[]" }) });
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

function acceptanceFor(acceptances: readonly OperatorProviderAcceptance[], providerId: string): Readonly<{ acceptance?: OperatorProviderAcceptance }> {
  const acceptance = acceptances.find((item) => item.providerId === providerId);
  return acceptance === undefined ? Object.freeze({}) : Object.freeze({ acceptance });
}

function exclusionsFor(
  snapshots: readonly ProviderSnapshot[],
  role: WorkflowRole,
  isolation: { readonly codex?: CodexIsolationAttestation; readonly grok?: GrokIsolationAttestation; readonly acceptances?: readonly OperatorProviderAcceptance[] } = {},
): readonly string[] {
  return Object.freeze(snapshots.filter((snapshot) => {
    const acceptance = (isolation.acceptances ?? []).find((item) => item.providerId === snapshot.providerId);
    if (!shadowProviderRoleStatus(snapshot.providerId, role, acceptance === undefined ? {} : { acceptance }).enabled) return true;
    // A provider whose isolation is proven per run, not per install, is not routable until this
    // run has the proof. Excluding it here means the router never selects it and the operator
    // never sees a plan naming a model the invocation would then refuse.
    if (snapshot.providerId === "openai" && role === "reviewer" && isolation.codex === undefined) return true;
    if (snapshot.providerId === "xai" && isolation.grok === undefined) return true;
    return false;
  }).map((snapshot) => snapshot.providerId));
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
  readonly #acceptances: readonly OperatorProviderAcceptance[];
  readonly #codexIsolation: CodexIsolationAttestation | undefined;
  readonly #grokIsolation: GrokIsolationAttestation | undefined;
  readonly #executor: ShadowProcessExecutor | undefined;
  readonly #onRoleActivity: ((activity: RoleActivity) => void) | undefined;
  readonly #onText: ((text: string) => void) | undefined;
  readonly #onThinking: (() => void) | undefined;
  readonly #onQuotaReading: ((reading: QuotaReading & { readonly quotaPool: string }) => void) | undefined;

  constructor(input: {
    readonly project: RegisteredProject;
    readonly ledger: TaskLedger;
    readonly router: CapabilityRouter;
    readonly snapshots: readonly ProviderSnapshot[];
    readonly attestations?: readonly SubscriptionAttestation[];
    readonly acceptances?: readonly OperatorProviderAcceptance[];
    readonly codexIsolation?: CodexIsolationAttestation;
    readonly grokIsolation?: GrokIsolationAttestation;
    readonly executor?: ShadowProcessExecutor;
    /** Told which provider and model is working, as each role starts and finishes. */
    readonly onRoleActivity?: (activity: RoleActivity) => void;
    /** Told the model's prose as it is written, for a provider whose stream shape is known. */
    readonly onText?: (text: string) => void;
    /** Told once per role, when the model starts reasoning before it says anything. */
    readonly onThinking?: () => void;
    /** Told what a provider said about its own remaining window, when it says anything. */
    readonly onQuotaReading?: (reading: QuotaReading & { readonly quotaPool: string }) => void;
  }) {
    this.#project = input.project;
    this.#ledger = input.ledger;
    this.#router = input.router;
    this.#snapshots = input.snapshots;
    this.#attestations = input.attestations ?? [];
    this.#acceptances = input.acceptances ?? [];
    this.#codexIsolation = input.codexIsolation;
    this.#grokIsolation = input.grokIsolation;
    this.#executor = input.executor;
    this.#onRoleActivity = input.onRoleActivity;
    this.#onText = input.onText;
    this.#onThinking = input.onThinking;
    this.#onQuotaReading = input.onQuotaReading;
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
    const isolation = Object.freeze({
      ...(this.#codexIsolation === undefined ? {} : { codex: this.#codexIsolation }),
      ...(this.#grokIsolation === undefined ? {} : { grok: this.#grokIsolation }),
      acceptances: this.#acceptances,
    });
    const plannerExcluded = exclusionsFor(this.#snapshots, "planner", isolation);
    const primaryExcluded = exclusionsFor(this.#snapshots, "primary", isolation);
    const reviewerExcluded = exclusionsFor(this.#snapshots, "reviewer", isolation);
    const judgeExcluded = exclusionsFor(this.#snapshots, "judge", isolation);

    const primaryRoute = this.#router.route({ role: "coder", classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: false, excludeProviders: primaryExcluded });
    const routes: RouteResult[] = [primaryRoute];
    const primaryRef = modelRef(primaryRoute);
    const primarySnapshot = snapshotFor(this.#snapshots, primaryRef.providerId);
    planShadowInvocation({ snapshot: primarySnapshot, model: primaryRef, cwd, payload: preflightPayload("primary", input.task, input.context), ...attestationFor(this.#attestations, primaryRef.providerId), ...acceptanceFor(this.#acceptances, primaryRef.providerId) });

    const needsReview = input.budget.reviewerPolicy === "required" || (input.budget.reviewerPolicy === "optional" && (input.optionalReview ?? false));
    if (needsReview) {
      const independence = input.classification.risk === "high" || input.classification.risk === "critical"
        ? { mode: "required" as const, models: [primaryRef] }
        : { mode: "preferred" as const, models: [primaryRef] };
      const reviewerRoute = this.#router.route({ role: "reviewer", classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: false, independence, excludeProviders: reviewerExcluded });
      routes.push(reviewerRoute);
      const reviewerRef = modelRef(reviewerRoute);
      planShadowInvocation({
        snapshot: snapshotFor(this.#snapshots, reviewerRef.providerId),
        model: reviewerRef,
        cwd,
        payload: preflightPayload("reviewer", input.task, input.context),
        ...attestationFor(this.#attestations, reviewerRef.providerId),
        ...acceptanceFor(this.#acceptances, reviewerRef.providerId),
        ...(reviewerRef.providerId === "openai" && this.#codexIsolation !== undefined ? { codexIsolation: this.#codexIsolation } : {}),
        ...(reviewerRef.providerId === "xai" && this.#grokIsolation !== undefined ? { grokIsolation: this.#grokIsolation } : {}),
      });
    }

    const task = this.#ledger.createTask({ title: input.title, complexity: input.classification.complexity, risk: input.classification.risk });
    this.#ledger.transition(task.taskId, "planned", { shadow: true, dryRun: input.dryRun ?? false });
    const brief = buildTaskBrief({ project: this.#project, task: this.#ledger.requireTask(task.taskId), classification: input.classification, budget: input.budget, routes, context: input.contextSummary, permissions: { executionProfile: "shadow-read-only", networkAllowed: false }, worktree: { enabled: false, taskWorktreeLabel: null } });
    recordTaskBrief(this.#ledger, brief);

    if (input.dryRun ?? false) {
      this.#ledger.appendEvent(task.taskId, "shadow.dry_run", { providers: routes.map((route) => route.selected.model.definition.providerId), roles: routes.map((route) => route.role), providerCalls: 0 });
      this.#ledger.transition(task.taskId, "running", { dryRun: true, providerCalls: 0 });
      this.#ledger.transition(task.taskId, "completed", { dryRun: true, providerCalls: 0 });
      return Object.freeze({ dryRun: true, taskId: task.taskId, taskReceipt: this.#ledger.receipt(task.taskId), workflow: null });
    }

    this.#ledger.transition(task.taskId, "running", { shadow: true });
    try {
      const invoker = new SubscriptionShadowAgentInvoker({ project: this.#project, cwd, snapshots: this.#snapshots, attestations: this.#attestations, acceptances: this.#acceptances, ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }), ...(this.#grokIsolation === undefined ? {} : { grokIsolation: this.#grokIsolation }), context: input.context, ...(this.#executor === undefined ? {} : { executor: this.#executor }), ledger: this.#ledger, taskId: task.taskId, maxTurns: input.budget.maxInspectionTurns, timeoutMs: input.budget.maxInspectionMs, fanOut: input.budget.maxConcurrentAgents > 1, maxSubagents: input.budget.maxProviderSubagents, ...(this.#onRoleActivity === undefined ? {} : { onRoleActivity: this.#onRoleActivity }), ...(this.#onText === undefined ? {} : { onText: this.#onText }), ...(this.#onThinking === undefined ? {} : { onThinking: this.#onThinking }), ...(this.#onQuotaReading === undefined ? {} : { onQuotaReading: this.#onQuotaReading }) });
      const sourceBefore = sourceCheckoutFingerprint(cwd);
      const workflow = await new WorkflowEngine(this.#router, invoker).run({ task: input.task, classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: false, optionalReview: input.optionalReview ?? false, excludeProviders: { planner: plannerExcluded, primary: primaryExcluded, reviewer: reviewerExcluded, judge: judgeExcluded } });
      assertSourceCheckoutUnchanged(cwd, sourceBefore);
      this.#ledger.transition(task.taskId, "verifying", { shadow: true, outcome: workflow.outcome });
      recordWorkflowReceipt(this.#ledger, task.taskId, workflow);
      this.#ledger.transition(task.taskId, "completed", { shadow: true, outcome: workflow.outcome });
      return Object.freeze({ dryRun: false, taskId: task.taskId, taskReceipt: this.#ledger.receipt(task.taskId), workflow });
    } catch (error) {
      const current = this.#ledger.requireTask(task.taskId);
      if (current.state === "running" || current.state === "verifying" || current.state === "planned") this.#ledger.transition(task.taskId, "failed", { shadow: true, code: error instanceof BrainGateInvariantError ? error.code : "UNKNOWN" });
      throw error;
    }
  }
}
