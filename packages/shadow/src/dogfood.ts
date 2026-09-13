import {
  BrainGateInvariantError,
  executionAttribution,
  executionRecord,
  deriveOutcome,
  failureKindFromCode,
  isTerminalTaskState,
  ledgerStateFor,
  registerActiveRun,
  type ExecutionBudget,
  type FailureKind,
  type FinalizationPlan,
  type ObservationRole,
  type RegisteredProject,
  type TaskClassification,
  type TaskFinalizer,
  type TaskLedger,
  type TaskReceipt,
} from "@braingate/core";
import { buildTaskBrief, recordTaskBrief, recordWorkflowReceipt } from "@braingate/observability";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type ModelRef, type RouteCandidate, type RoutePin, type RouteResult } from "@braingate/router";
import { WorkflowEngine, type WorkflowReceipt, type WorkflowRole, type WorkflowOutcome } from "@braingate/workflows";
import type { CodexIsolationAttestation } from "./codex-isolation.js";
import type { GrokIsolationAttestation } from "./grok-isolation.js";
import { SubscriptionShadowAgentInvoker, type NativeSessionResolver, type RoleActivity } from "./invoker.js";
import type { QuotaReading } from "./quota-readings.js";
import { planShadowInvocation, shadowProviderRoleStatus, snapshotPrimaryEligibility } from "./profiles.js";
import type { TaskSnapshotProvider } from "./snapshot-provider.js";
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
  isolation: { readonly codex?: CodexIsolationAttestation; readonly grok?: GrokIsolationAttestation; readonly grokSnapshot?: GrokIsolationAttestation; readonly acceptances?: readonly OperatorProviderAcceptance[] } = {},
): readonly string[] {
  return Object.freeze(snapshots.filter((snapshot) => {
    const acceptance = (isolation.acceptances ?? []).find((item) => item.providerId === snapshot.providerId);
    // Read-primary is the one role that may run on a provider whose entire reach is the workspace it
    // was pointed at, because BrainGate now hands it a copy of the project instead of the checkout.
    // The question is the same one the invocation asks, from the same function, so the plan cannot
    // name a model the invocation would then refuse.
    const snapshotEligible = role === "primary" && snapshotPrimaryEligibility({
      providerId: snapshot.providerId,
      snapshot,
      ...(isolation.codex === undefined ? {} : { codexIsolation: isolation.codex }),
      ...(isolation.grok === undefined ? {} : { grokIsolation: isolation.grok }),
      ...(isolation.grokSnapshot === undefined ? {} : { grokSnapshotIsolation: isolation.grokSnapshot }),
    }).eligible;
    if (!shadowProviderRoleStatus(snapshot.providerId, role, { ...(acceptance === undefined ? {} : { acceptance }), snapshotPrimary: snapshotEligible }).enabled) return true;
    // A provider whose isolation is proven per run, not per install, is not routable until this
    // run has the proof. Excluding it here means the router never selects it and the operator
    // never sees a plan naming a model the invocation would then refuse.
    if (snapshot.providerId === "openai" && role === "reviewer" && isolation.codex === undefined) return true;
    if (snapshot.providerId === "xai" && isolation.grok === undefined) return true;
    return false;
  }).map((snapshot) => snapshot.providerId));
}

/** Whether a task has reached a terminal state, from the ledger rather than from a guess. */
function taskIsFinished(ledger: TaskLedger, taskId: string): boolean | undefined {
  try { return isTerminalTaskState(ledger.receipt(taskId).task.state); }
  catch { return undefined; }
}

const ROUTE_ROLE: Readonly<Record<string, ObservationRole["role"]>> = Object.freeze({
  coder: "primary",
  primary: "primary",
  planner: "planner",
  reviewer: "reviewer",
  judge: "judge",
});

function observationRole(role: string, definition: { readonly providerId: string; readonly modelId: string }): ObservationRole | null {
  const mapped = ROUTE_ROLE[role];
  if (mapped === undefined) return null;
  return Object.freeze({ role: mapped, providerId: definition.providerId, modelId: definition.modelId });
}

function addRole(into: ObservationRole[], entry: ObservationRole | null): void {
  if (entry === null) return;
  if (into.some((existing) => existing.role === entry.role && existing.providerId === entry.providerId && existing.modelId === entry.modelId)) return;
  into.push(entry);
}

/** What actually ran, taken from the workflow's own record rather than from what was planned. */
function rolesFromWorkflow(workflow: WorkflowReceipt): readonly ObservationRole[] {
  const roles: ObservationRole[] = [];
  const add = (candidate: RouteCandidate | null, role: string): void => {
    if (candidate === null) return;
    addRole(roles, observationRole(role, candidate.model.definition));
  };
  add(workflow.planner, "planner");
  add(workflow.secondPlanner, "planner");
  add(workflow.primary, "primary");
  add(workflow.reviewer, "reviewer");
  add(workflow.judge, "judge");
  return Object.freeze(roles);
}

/** What was planned, for a run that failed before the workflow recorded anything. */
function rolesFromRoutes(routes: readonly RouteResult[]): readonly ObservationRole[] {
  const roles: ObservationRole[] = [];
  for (const route of routes) addRole(roles, observationRole(route.role, route.selected.model.definition));
  return Object.freeze(roles);
}

/**
 * What the measurement layer needs about this run, supplied by the caller that classified it.
 *
 * Required rather than optional: an optional context is exactly how a task ends up in the ledger
 * with no observation, which is the defect M19 exists to remove. Making it required turns an
 * omission into a compile error at every construction site.
 */
export interface ShadowObservationContext {
  readonly predicted: TaskClassification;
  readonly effective: TaskClassification;
  readonly prior: unknown;
}

export interface ShadowDogfoodResult {
  readonly dryRun: boolean;
  readonly taskId: string | null;
  readonly taskReceipt: TaskReceipt | null;
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
  readonly #grokSnapshotIsolation: GrokIsolationAttestation | undefined;
  readonly #executor: ShadowProcessExecutor | undefined;
  readonly #pin: RoutePin | undefined;
  readonly #nativeSession: NativeSessionResolver | undefined;
  readonly #snapshotStore: TaskSnapshotProvider | undefined;
  readonly #finalizer: TaskFinalizer;
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
    /**
     * The snapshot-read proof for Grok.
     *
     * Separate from the staged proof because it is a separate posture: an isolated home, its own
     * profile, and no writable root. A run that has not earned it cannot route primary to Grok.
     */
    readonly grokSnapshotIsolation?: GrokIsolationAttestation;
    readonly executor?: ShadowProcessExecutor;
    /**
     * The worker the operator named by hand, when there is one.
     *
     * Passed to every route this run makes, and to nothing else. It narrows *which* model is
     * considered and leaves every eligibility gate in place, so a manual choice can fail but can
     * never route around a policy.
     */
    readonly pin?: RoutePin | undefined;
    /** Asked per invocation whether this run continues a native provider session. */
    readonly nativeSession?: NativeSessionResolver | undefined;
    /**
     * Where a read-primary run's project copy comes from.
     *
     * Supplied by the caller (the CLI wires the execution-side implementation) so this package needs
     * no dependency on the code that copies projects. Absent it, a snapshot-capable provider is left
     * out of the primary candidate set rather than handed the checkout.
     */
    readonly snapshotStore?: TaskSnapshotProvider;
    /**
     * Where the run's permanent record is written.
     *
     * Required, and called exactly once per run on every exit path. The runner does not know what
     * is behind it: the CLI composes a ledger, a project-local measurement store and the result
     * directory, and an execution package that imported any of those would be the wrong shape.
     */
    readonly finalizer: TaskFinalizer;
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
    this.#grokSnapshotIsolation = input.grokSnapshotIsolation;
    this.#executor = input.executor;
    this.#pin = input.pin;
    this.#nativeSession = input.nativeSession;
    this.#snapshotStore = input.snapshotStore;
    this.#finalizer = input.finalizer;
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
    /** Classification and prior for the record. Required; see `ShadowObservationContext`. */
    readonly observation: ShadowObservationContext;
    /**
     * The goal this task is a work unit of, when it continues one.
     *
     * Optional so every existing caller keeps compiling and every one-shot run stays standalone.
     * It is recorded on the task row and nowhere else: the runner has no opinion about what a goal
     * is, and the goal's own state lives in the goals store the CLI owns.
     */
    readonly goalId?: string | null;
    readonly conversationId?: string | null;
    readonly optionalReview?: boolean;
    readonly dryRun?: boolean;
  }): Promise<ShadowDogfoodResult> {
    if (input.task.trim().length === 0) throw new BrainGateInvariantError("SHADOW_TASK_INVALID", "Shadow task must be non-empty.");
    if (input.requiredContextTokens > input.budget.maxContextTokens) throw new BrainGateInvariantError("SHADOW_CONTEXT_BUDGET", "Required context exceeds the task Budget Governor limit.");
    const dryRun = input.dryRun ?? false;

    const cwd = assertShadowProjectCwd(this.#project, input.cwd);
    const isolation = Object.freeze({
      ...(this.#codexIsolation === undefined ? {} : { codex: this.#codexIsolation }),
      ...(this.#grokIsolation === undefined ? {} : { grok: this.#grokIsolation }),
      ...(this.#grokSnapshotIsolation === undefined ? {} : { grokSnapshot: this.#grokSnapshotIsolation }),
      acceptances: this.#acceptances,
    });
    const plannerExcluded = exclusionsFor(this.#snapshots, "planner", isolation);
    const primaryExcluded = exclusionsFor(this.#snapshots, "primary", isolation);
    const reviewerExcluded = exclusionsFor(this.#snapshots, "reviewer", isolation);
    const judgeExcluded = exclusionsFor(this.#snapshots, "judge", isolation);

    // The state this task started from, measured before any provider is called.
    //
    // A snapshot is taken later, and only if a snapshot-capable provider ends up running the primary.
    // Recording the fingerprint now is what makes the later copy provably the same project the
    // planner and the context were read from: without it, an edit made while the planner worked would
    // silently be handed to the provider that answered.
    const snapshotMayBeNeeded = this.#snapshotStore !== undefined && this.#snapshots.some((item) => snapshotPrimaryEligibility({
      providerId: item.providerId,
      snapshot: item,
      ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }),
      ...(this.#grokIsolation === undefined ? {} : { grokIsolation: this.#grokIsolation }),
    }).eligible);
    if (input.dryRun !== true && this.#snapshotStore !== undefined) {
      // A copy of the operator's source left behind by a killed process is a privacy problem before it
      // is a disk problem, so a run sweeps its own project's orphans before it starts. Bounded and
      // reported; it never looks outside this project's snapshots root and never deletes a copy whose
      // process is alive.
      try { this.#snapshotStore.sweep({ isTaskFinished: (taskId) => taskIsFinished(this.#ledger, taskId) }); }
      catch { /* a sweep that cannot run is not a reason to refuse the task */ }
    }

    const primaryRoute = this.#router.route({ role: "coder", classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: false, excludeProviders: primaryExcluded, ...(this.#pin === undefined ? {} : { pin: this.#pin }) });
    const routes: RouteResult[] = [primaryRoute];
    const primaryRef = modelRef(primaryRoute);
    const primarySnapshot = snapshotFor(this.#snapshots, primaryRef.providerId);
    // Read-primary may run against a project copy, and whether it will is decided by the same
    // function the invocation uses. The check is a preview: it proves the invocation is
    // constructible and names the workspace mode, without creating a snapshot for a plan.
    const primarySnapshotEligible = snapshotPrimaryEligibility({
      providerId: primarySnapshot.providerId,
      snapshot: primarySnapshot,
      ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }),
      ...(this.#grokIsolation === undefined ? {} : { grokIsolation: this.#grokIsolation }),
      ...(this.#grokSnapshotIsolation === undefined ? {} : { grokSnapshotIsolation: this.#grokSnapshotIsolation }),
    }).eligible;
    planShadowInvocation({
      snapshot: primarySnapshot,
      model: primaryRef,
      cwd,
      payload: preflightPayload("primary", input.task, input.context),
      ...(primarySnapshotEligible ? { snapshotPrimary: true, preview: true } : {}),
      ...attestationFor(this.#attestations, primaryRef.providerId),
      ...acceptanceFor(this.#acceptances, primaryRef.providerId),
      // A provider whose isolation is proven per run is only constructible with its proof in hand,
      // and the primary route can now be one of those providers.
      ...(primaryRef.providerId === "openai" && this.#codexIsolation !== undefined ? { codexIsolation: this.#codexIsolation } : {}),
      ...(primaryRef.providerId === "xai" && this.#grokIsolation !== undefined ? { grokIsolation: this.#grokIsolation } : {}),
      ...(primaryRef.providerId === "xai" && this.#grokSnapshotIsolation !== undefined ? { grokSnapshotIsolation: this.#grokSnapshotIsolation } : {}),
    });

    const needsReview = input.budget.reviewerPolicy === "required" || (input.budget.reviewerPolicy === "optional" && (input.optionalReview ?? false));
    if (needsReview) {
      const independence = input.classification.risk === "high" || input.classification.risk === "critical"
        ? { mode: "required" as const, models: [primaryRef] }
        : { mode: "preferred" as const, models: [primaryRef] };
      const reviewerRoute = this.#router.route({ role: "reviewer", classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: false, independence, excludeProviders: reviewerExcluded, ...(this.#pin === undefined ? {} : { pin: this.#pin }) });
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

    // A dry run performs no provider call, so it creates no task: a task row is a claim that work
    // was attempted, and the record would otherwise carry an outcome for work never done. The
    // write path already returns before creating one, and this keeps the two aligned. Everything
    // above still runs, so a dry run remains a real preflight — routing and eligibility are
    // checked, which is what the caller is asking for.
    if (dryRun) {
      return Object.freeze({ dryRun: true, taskId: null, taskReceipt: null, workflow: null });
    }

    const task = this.#ledger.createTask({
      title: input.title,
      complexity: input.classification.complexity,
      risk: input.classification.risk,
      // M20: the work unit is linked to the goal it continues. Null for a one-shot run, which is a
      // task that stands alone rather than a task attached to an invented goal.
      goalId: input.goalId ?? null,
      conversationId: input.conversationId ?? null,
    });
    // Recorded here — after the task exists, before the first provider call — so the copy a later
    // failover takes is provably of the state this task started from.
    if (snapshotMayBeNeeded && this.#snapshotStore !== undefined) {
      this.#snapshotStore.beginTask({ taskId: task.taskId, source: cwd });
    }
    this.#ledger.transition(task.taskId, "planned", { shadow: true, dryRun: false });
    const brief = buildTaskBrief({ project: this.#project, task: this.#ledger.requireTask(task.taskId), classification: input.classification, budget: input.budget, routes, context: input.contextSummary, permissions: { executionProfile: "shadow-read-only", networkAllowed: false }, worktree: { enabled: false, taskWorktreeLabel: null } });
    recordTaskBrief(this.#ledger, brief);

    this.#ledger.transition(task.taskId, "running", { shadow: true });

    /**
     * Everything the finalization needs, composed in one place.
     *
     * The outcome is derived from the evidence this run recorded, through the same core function a
     * reconciler uses — so a run that dies mid-finalization and is completed later produces the
     * same record it would have produced itself.
     */
    /**
     * Who actually ran, read back from this task's own provider events.
     *
     * Computed at finalization time on purpose: the brief is written before the run and can only
     * carry the plan, so this is the record that a planner which executed on another provider, or a
     * role whose call was refused, is not lost.
     */
    const attribution = (): readonly ObservationRole[] => executionAttribution({
      events: this.#ledger.receipt(task.taskId).events,
      planned: rolesFromRoutes(routes),
    });
    const recordExecution = (): void => {
      this.#ledger.appendEvent(task.taskId, "task.execution", executionRecord(attribution()));
    };

    const planFor = (options: {
      readonly workflow: WorkflowOutcome | null;
      readonly failureKind: FailureKind | null;
      readonly result: FinalizationPlan["result"];
      readonly roles: readonly ObservationRole[];
    }): FinalizationPlan => {
      const derived = deriveOutcome({
        mode: "ask",
        workflow: options.workflow,
        writeCompleted: false,
        writeReviewRan: false,
        writeVerdict: null,
        failureKind: options.failureKind,
        reconciled: false,
      });
      return Object.freeze({
        taskId: task.taskId,
        projectId: this.#project.projectId,
        mode: "ask" as const,
        outcome: derived.outcome,
        reviewStatus: derived.reviewStatus,
        failureKind: options.failureKind,
        basis: derived.basis,
        result: options.result,
        observation: Object.freeze({
          predicted: input.observation.predicted,
          effective: input.observation.effective,
          // Executed attribution, falling back to the planned roles when nothing was dispatched.
          roles: attribution(),
          prior: input.observation.prior,
        }),
        reconciled: false,
        ledgerState: ledgerStateFor(derived.outcome, "ask"),
      });
    };

    let finalization: FinalizationPlan | null = null;
    let workflowReceipt: WorkflowReceipt | null = null;
    let finalized = false;
    const complete = (): void => {
      if (finalized || finalization === null) return;
      finalized = true;
      this.#finalizer.finalize(finalization);
    };
    // The receipt is read *after* finalization, not as part of building the return value: a return
    // expression is evaluated before the surrounding `finally` runs, so reading it there would
    // report the state from before the outcome was recorded.
    const finish = (): TaskReceipt => {
      complete();
      return this.#ledger.receipt(task.taskId);
    };
    // A signal is the one moment this process knows it is about to stop writing. Without this the
    // task would stay `running` forever, which is how one real task sat abandoned for 33 hours.
    const unregister = registerActiveRun(() => {
      finalization ??= planFor({
        workflow: null,
        failureKind: "interrupted",
        result: Object.freeze({ kind: "none" as const, text: null, evidence: "lost-to-crash" as const }),
        roles: rolesFromRoutes(routes),
      });
      complete();
    });

    try {
      const invoker = new SubscriptionShadowAgentInvoker({ project: this.#project, cwd, snapshots: this.#snapshots, attestations: this.#attestations, acceptances: this.#acceptances, ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }), ...(this.#grokIsolation === undefined ? {} : { grokIsolation: this.#grokIsolation }), context: input.context, ...(this.#executor === undefined ? {} : { executor: this.#executor }), ledger: this.#ledger, taskId: task.taskId, ...(this.#snapshotStore === undefined ? {} : { snapshotStore: this.#snapshotStore }), ...(this.#grokSnapshotIsolation === undefined ? {} : { grokSnapshotIsolation: this.#grokSnapshotIsolation }), maxTurns: input.budget.maxInspectionTurns, timeoutMs: input.budget.maxInspectionMs, fanOut: input.budget.maxConcurrentAgents > 1, maxSubagents: input.budget.maxProviderSubagents, ...(this.#onRoleActivity === undefined ? {} : { onRoleActivity: this.#onRoleActivity }), ...(this.#onText === undefined ? {} : { onText: this.#onText }), ...(this.#onThinking === undefined ? {} : { onThinking: this.#onThinking }), ...(this.#onQuotaReading === undefined ? {} : { onQuotaReading: this.#onQuotaReading }), ...(this.#nativeSession === undefined ? {} : { nativeSession: this.#nativeSession }) });
      const sourceBefore = sourceCheckoutFingerprint(cwd);
      const workflow = await new WorkflowEngine(this.#router, invoker).run({ task: input.task, classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: false, optionalReview: input.optionalReview ?? false, ...(this.#pin === undefined ? {} : { pin: this.#pin }), excludeProviders: { planner: plannerExcluded, primary: primaryExcluded, reviewer: reviewerExcluded, judge: judgeExcluded } });
      workflowReceipt = workflow;
      assertSourceCheckoutUnchanged(cwd, sourceBefore);
      this.#ledger.transition(task.taskId, "verifying", { shadow: true, outcome: workflow.outcome });
      // The receipt is the canonical source of the outcome, and it is durable before finalization
      // begins — which is what lets a second process derive exactly the same record.
      recordWorkflowReceipt(this.#ledger, task.taskId, workflow);
      finalization = planFor({
        workflow: workflow.outcome,
        failureKind: null,
        result: workflow.finalOutput.trim().length > 0
          ? Object.freeze({ kind: "answer" as const, text: workflow.finalOutput, evidence: "redacted" as const })
          : Object.freeze({ kind: "none" as const, text: null, evidence: "unavailable" as const }),
        roles: rolesFromWorkflow(workflow),
      });
    } catch (error) {
      finalization = planFor({
        workflow: null,
        failureKind: error instanceof BrainGateInvariantError ? failureKindFromCode(error.code) : "unknown",
        result: Object.freeze({ kind: "none" as const, text: null, evidence: "lost-to-crash" as const }),
        roles: rolesFromRoutes(routes),
      });
      throw error;
    } finally {
      unregister();
      // The copy the provider read exists for this task only. Released here, which is the path every
      // exit takes — success, provider failure, and a signal, because the interrupt handler runs this
      // same finally.
      try { this.#snapshotStore?.discard(task.taskId); }
      catch { /* a snapshot that cannot be removed is a leftover, not a reason to lose the record */ }
      // Written before the observation, so the attribution the corpus stores is already durable.
      try { recordExecution(); }
      catch { /* attribution is evidence; failing to append it must not replace the run's own error */ }
      try { complete(); }
      catch { /* the record is left incomplete on purpose: reconcilers finish it, and swallowing here would hide the run's own error */ }
    }

    return Object.freeze({ dryRun: false, taskId: task.taskId, taskReceipt: finish(), workflow: workflowReceipt });
  }
}
