import {
  BrainGateInvariantError,
  executionAttribution,
  executionRecord,
  deriveOutcome,
  failureKindFromCode,
  isWriteVerdict,
  ledgerStateFor,
  registerActiveRun,
  type ExecutionBudget,
  type FailureKind,
  type FinalizationPlan,
  type ObservationRole,
  type ExecutionProject,
  type TaskClassification,
  type TaskFinalizer,
  type TaskLedger,
  type TaskReceipt,
  type WriteVerdict,
} from "@braingate/core";
import { SafeCommandRunner, WorktreeGuard } from "@braingate/execution";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type IndependenceConstraint, type ModelRef, type RoutePin, type RouteResult } from "@braingate/router";
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { taskTitleFor } from "@braingate/security";
import { CODEX_GENERATED_IMAGES, assertSourceCheckoutUnchanged, providerQuotaRefusal, resolveCodexHome, NodeShadowProcessExecutor, extractCodexAgentMessage, planCodexVisualInvocation, SubscriptionShadowAgentInvoker, shadowProviderRoleStatus, sourceCheckoutFingerprint, type CodexIsolationAttestation, type GrokIsolationAttestation, type OperatorProviderAcceptance, type ShadowProcessExecutor, type SubscriptionAttestation } from "@braingate/shadow";
import { NodeClaudeWriteExecutor } from "./claude-write-profile.js";
import { assertWriteEligible, planWriteInvocation } from "./write-profiles.js";
import { changedPaths, snapshotWorkspace, workspaceChangesSince, type WorkspaceSnapshot } from "@braingate/shadow";
import type { ExecutionPolicyId } from "@braingate/core";
import { collectGuardedDiff } from "./diff-guard.js";
import { collectArtifacts, parseArtifactDeclarations, type CollectedArtifact } from "./artifact-collector.js";
import type { PlannedWriteRole, VisualRequest, WriteProviderExecutor, WriteRunResult, WriteTaskPlan, WriteVerificationResult } from "./types.js";

function modelRef(route: RouteResult): ModelRef {
  const definition = route.selected.model.definition;
  return Object.freeze({ providerId: definition.providerId, modelId: definition.modelId, quotaPool: definition.quotaPool });
}

/** Who this plan says will work, recorded with the run so the record names its own models. */
/** The plan's roles, as the fallback attribution for a write that never dispatched one of them. */
function observationRolesFor(roles: readonly PlannedWriteRole[]): readonly ObservationRole[] {
  const seen: ObservationRole[] = [];
  for (const role of roles) {
    if (seen.some((entry) => entry.role === role.role && entry.providerId === role.model.providerId && entry.modelId === role.model.modelId)) continue;
    seen.push(Object.freeze({ role: role.role, providerId: role.model.providerId, modelId: role.model.modelId }));
  }
  return Object.freeze(seen);
}

function snapshotFor(snapshots: readonly ProviderSnapshot[], providerId: string): ProviderSnapshot {
  const snapshot = snapshots.find((candidate) => candidate.providerId === providerId);
  if (snapshot === undefined) throw new BrainGateInvariantError("WRITE_SNAPSHOT_MISSING", `No provider discovery snapshot for ${providerId}.`);
  return snapshot;
}

function validSubscriptionAttestation(attestations: readonly SubscriptionAttestation[], providerId: string, now = new Date()): boolean {
  const value = attestations.find((entry) => entry.providerId === providerId && entry.mode === "subscription");
  if (value === undefined) return false;
  const observed = new Date(value.observedAt);
  if (Number.isNaN(observed.getTime()) || observed.getTime() > now.getTime() + 60_000 || now.getTime() - observed.getTime() > 30 * 24 * 60 * 60 * 1000) return false;
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    const expires = new Date(value.expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return false;
  }
  return true;
}

function reviewerExclusions(
  snapshots: readonly ProviderSnapshot[],
  codexIsolation: CodexIsolationAttestation | undefined,
  attestations: readonly SubscriptionAttestation[],
  proof: { readonly grokIsolation?: GrokIsolationAttestation; readonly acceptances?: readonly OperatorProviderAcceptance[] } = {},
): readonly string[] {
  return Object.freeze(snapshots.filter((snapshot) => {
    const acceptance = (proof.acceptances ?? []).find((item) => item.providerId === snapshot.providerId);
    if (!shadowProviderRoleStatus(snapshot.providerId, "reviewer", acceptance === undefined ? {} : { acceptance }).enabled) return true;
    if (snapshot.providerId === "xai") return proof.grokIsolation === undefined;
    if (snapshot.providerId === "openai") return snapshot.authState.value !== "authenticated" || snapshot.authMode.value !== "subscription" || codexIsolation === undefined;
    if (snapshot.providerId === "github-copilot") {
      if (snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription") return false;
      return !validSubscriptionAttestation(attestations, snapshot.providerId);
    }
    return snapshot.authState.value !== "authenticated" || snapshot.authMode.value !== "subscription";
  }).map((snapshot) => snapshot.providerId));
}

function assertM11Scope(classification: TaskClassification): void {
  if (classification.risk === "high" || classification.risk === "critical" || classification.complexity === "T3" || classification.complexity === "T4") {
    throw new BrainGateInvariantError("WRITE_SCOPE_BLOCKED", "M11 permits only T0-T2 low/medium-risk code changes. Auth, payment, security, migration and other high-risk writes remain blocked.");
  }
}

function isNoEligibleModel(error: unknown): boolean {
  return error instanceof BrainGateInvariantError && error.code === "ROUTE_NO_ELIGIBLE_MODEL";
}

function routeWriteReviewer(input: {
  readonly router: CapabilityRouter;
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly primaryModel: ModelRef;
  readonly excludeProviders: readonly string[];
}): RouteResult {
  const route = (independence: IndependenceConstraint): RouteResult => input.router.route({
    role: "reviewer",
    classification: input.classification,
    budget: input.budget,
    requiredContextTokens: input.requiredContextTokens,
    writeRequired: false,
    independence,
    excludeProviders: input.excludeProviders,
  });
  try {
    return route({ mode: "required", level: "cross-provider", models: [input.primaryModel] });
  } catch (error) {
    if (!isNoEligibleModel(error)) throw error;
    try {
      return route({ mode: "required", level: "different-model", models: [input.primaryModel] });
    } catch (differentModelError) {
      if (!isNoEligibleModel(differentModelError)) throw differentModelError;
      return route({ mode: "preferred", level: "fresh-session", models: [input.primaryModel] });
    }
  }
}

/**
 * Every file currently under Codex's generated-images directory, newest last.
 *
 * A missing or unreadable directory is an empty list rather than a failure: it simply means
 * nothing has been generated, which is the ordinary state before the first visual task.
 */
function generatedImages(directory: string): readonly string[] {
  const found: string[] = [];
  const walk = (path: string, depth: number): void => {
    if (depth > 3) return;
    let entries: Dirent[];
    try { entries = readdirSync(path, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.isFile()) found.push(child);
    }
  };
  walk(directory, 0);
  return Object.freeze(found.sort());
}

export function buildWriteTaskPlan(input: {
  readonly router: CapabilityRouter;
  readonly providers: readonly ProviderSnapshot[];
  readonly attestations?: readonly SubscriptionAttestation[];
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly grokIsolation?: GrokIsolationAttestation;
  readonly acceptances?: readonly OperatorProviderAcceptance[];
  /** The proof a Grok *write* needs, earned under the write sandbox profile rather than the read one. */
  readonly grokWriteIsolation?: GrokIsolationAttestation;
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly repositoryPath: string;
  readonly baseRef: string;
  /**
   * The execution boundary this write runs inside (ADR 0017).
   *
   * `worktree` is the strict mode: an isolated worktree the operator merges. `direct` edits the
   * workspace itself, which is what ordinary interactive work means — and it is why
   * `createsWorktree` is false and no merge is ever offered for it.
   */
  readonly policy?: ExecutionPolicyId;
  readonly review?: boolean;
  /**
   * The worker the operator named by hand, when there is one.
   *
   * The primary only. A write is still reviewed by whoever is independent of it, and pinning the
   * reviewer would defeat the reason a reviewer exists.
   */
  readonly pin?: RoutePin | undefined;
}): WriteTaskPlan {
  assertM11Scope(input.classification);
  if (input.requiredContextTokens > input.budget.maxContextTokens) throw new BrainGateInvariantError("WRITE_CONTEXT_BUDGET", "Required context exceeds the task Budget Governor limit.");
  // Every provider that cannot prove a bounded place to work is excluded here, rather than one
  // provider being named as the only one allowed to. The router then picks on capability among
  // whoever is left, which is what makes the executing role something more than one subscription.
  const writeProof = {
    ...(input.codexIsolation === undefined ? {} : { codexIsolation: input.codexIsolation }),
    ...(input.grokWriteIsolation === undefined ? {} : { grokIsolation: input.grokWriteIsolation }),
  };
  const primaryExcluded = input.providers
    .filter((snapshot) => {
      try {
        assertWriteEligible(snapshot, { providerId: snapshot.providerId, modelId: "", quotaPool: "" }, writeProof);
        return false;
      } catch (error) {
        // A model id this loop cannot know is checked per-model below; anything else disqualifies
        // the provider for every model it has.
        return !(error instanceof BrainGateInvariantError && error.code === "WRITE_MODEL_UNAVAILABLE");
      }
    })
    .map((snapshot) => snapshot.providerId);
  const direct = input.policy === "direct" || input.policy === "unattended";
  if (direct) {
    // Only the providers whose invocation can honestly run in the workspace. The rest are not
    // refused here but excluded from routing, so the answer to "which model" is decided by the
    // router among the ones that can, and the operator sees that in the plan.
    primaryExcluded.push("openai", "xai");
  }
  const primaryRoute = input.router.route({ role: "coder", classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: true, excludeProviders: [...new Set(primaryExcluded)], ...(input.pin === undefined ? {} : { pin: input.pin }) });
  const primaryModel = modelRef(primaryRoute);
  assertWriteEligible(snapshotFor(input.providers, primaryModel.providerId), primaryModel, writeProof);
  const roles: PlannedWriteRole[] = [Object.freeze({ role: "primary", model: primaryModel, route: primaryRoute, workspace: direct ? "workspace" : "task-worktree" })];

  const wantsReview = input.review ?? true;
  if (wantsReview) {
    const reviewerRoute = routeWriteReviewer({
      router: input.router,
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      primaryModel,
      excludeProviders: reviewerExclusions(input.providers, input.codexIsolation, input.attestations ?? [], {
        ...(input.grokIsolation === undefined ? {} : { grokIsolation: input.grokIsolation }),
        acceptances: input.acceptances ?? [],
      }),
    });
    const reviewerModel = modelRef(reviewerRoute);
    roles.push(Object.freeze({ role: "reviewer", model: reviewerModel, route: reviewerRoute, workspace: reviewerModel.providerId === "openai" ? "staged-review" : "project-read-only" }));
  }

  return Object.freeze({
    classification: input.classification,
    budget: input.budget,
    requiredContextTokens: input.requiredContextTokens,
    repositoryPath: input.repositoryPath,
    baseRef: input.baseRef,
    policy: direct ? "direct" : "worktree",
    roles: Object.freeze(roles),
    providerCallsOnPlan: 0,
    createsWorktree: false,
    // A change made in the workspace is already where the operator works. There is nothing to
    // merge, and offering a merge would imply the edit had been held somewhere.
    mergeAvailable: false,
  });
}

export class WriteDogfoodRunner {
  readonly #project: ExecutionProject;
  readonly #ledger: TaskLedger;
  readonly #router: CapabilityRouter;
  readonly #pin: RoutePin | undefined;
  readonly #providers: readonly ProviderSnapshot[];
  readonly #attestations: readonly SubscriptionAttestation[];
  readonly #codexIsolation: CodexIsolationAttestation | undefined;
  readonly #grokIsolation: GrokIsolationAttestation | undefined;
  readonly #grokWriteIsolation: GrokIsolationAttestation | undefined;
  readonly #acceptances: readonly OperatorProviderAcceptance[];
  readonly #finalizer: TaskFinalizer;
  readonly #writer: WriteProviderExecutor;
  readonly #reviewExecutor: ShadowProcessExecutor | undefined;
  readonly #visualExecutor: ShadowProcessExecutor | undefined;

  constructor(input: {
    readonly project: ExecutionProject;
    readonly ledger: TaskLedger;
    readonly router: CapabilityRouter;
    /** The worker the operator named by hand, applied to every route this runner makes. */
    readonly pin?: RoutePin | undefined;
    readonly providers: readonly ProviderSnapshot[];
    readonly attestations?: readonly SubscriptionAttestation[];
    readonly acceptances?: readonly OperatorProviderAcceptance[];
    readonly codexIsolation?: CodexIsolationAttestation;
    readonly grokIsolation?: GrokIsolationAttestation;
    /** The proof a Grok write needs, earned under the write sandbox profile. */
    readonly grokWriteIsolation?: GrokIsolationAttestation;
    readonly writer?: WriteProviderExecutor;
    readonly reviewExecutor?: ShadowProcessExecutor;
    /** Executor for the artifact-producing pass; defaults to the real one. */
    readonly visualExecutor?: ShadowProcessExecutor;
    /** Where this run's permanent record is written. Required; see `ShadowDogfoodRunner`. */
    readonly finalizer: TaskFinalizer;
  }) {
    this.#project = input.project;
    this.#ledger = input.ledger;
    this.#router = input.router;
    this.#pin = input.pin;
    this.#providers = input.providers;
    this.#attestations = input.attestations ?? [];
    this.#codexIsolation = input.codexIsolation;
    this.#grokIsolation = input.grokIsolation;
    this.#grokWriteIsolation = input.grokWriteIsolation;
    this.#acceptances = input.acceptances ?? [];
    this.#writer = input.writer ?? new NodeClaudeWriteExecutor();
    this.#reviewExecutor = input.reviewExecutor;
    this.#visualExecutor = input.visualExecutor;
    this.#finalizer = input.finalizer;
  }

  async run(input: {
    readonly task: string;
    readonly repositoryPath: string;
    readonly baseRef?: string;
    /** Defaults to `worktree`: the strict mode, and the one this path shipped with. */
    readonly policy?: ExecutionPolicyId;
    readonly classification: TaskClassification;
    readonly budget: ExecutionBudget;
    readonly requiredContextTokens: number;
    /** When present, an artifact-producing pass runs in the same worktree (ADR 0007). */
    readonly visual?: VisualRequest;
    readonly context: unknown;
    /**
     * Classification and prior for the record. Required: an optional context is how a task ends up
     * in the ledger with nothing said about it, which is the defect this milestone removes.
     */
    readonly observation: {
      readonly predicted: TaskClassification;
      readonly effective: TaskClassification;
      readonly prior: unknown;
    };
    readonly review?: boolean;
    readonly dryRun?: boolean;
    readonly env?: NodeJS.ProcessEnv;
  }): Promise<WriteRunResult> {
    if (input.task.trim().length === 0) throw new BrainGateInvariantError("WRITE_TASK_INVALID", "Write task must be non-empty.");
    const plan = buildWriteTaskPlan({
      router: this.#router,
      providers: this.#providers,
      attestations: this.#attestations,
      acceptances: this.#acceptances,
      ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }),
      ...(this.#grokIsolation === undefined ? {} : { grokIsolation: this.#grokIsolation }),
      ...(this.#grokWriteIsolation === undefined ? {} : { grokWriteIsolation: this.#grokWriteIsolation }),
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      ...(this.#pin === undefined ? {} : { pin: this.#pin }),
      repositoryPath: input.repositoryPath,
      baseRef: input.baseRef ?? "HEAD",
      ...(input.policy === undefined ? {} : { policy: input.policy }),
      review: input.review ?? true,
    });
    // The DIRECT policy: the worker runs in the workspace itself. No worktree is prepared, nothing
    // is merged, and what it changed is reported by comparing the workspace before and after.
    const direct = plan.policy === "direct";
    if (input.dryRun ?? false) return Object.freeze({ dryRun: true, taskId: null, worktree: null, changedFiles: Object.freeze([]), diff: "", verification: Object.freeze([]), review: null, readyForApproval: false, approvalRequired: true, mergePerformed: false, taskReceipt: null });

    const task = this.#ledger.createTask({ title: taskTitleFor(input.task), complexity: input.classification.complexity, risk: input.classification.risk });
    this.#ledger.transition(task.taskId, "planned", { write: true, worktreeOnly: true, mergeAvailable: false });

    /**
     * The one place this run's outcome is composed.
     *
     * It goes through the same core derivation a reconciler uses, so a run that dies between the
     * work and the record still produces the record it would have produced itself.
     */
    const planFor = (evidence: {
      readonly writeCompleted: boolean;
      readonly writeReviewRan: boolean;
      readonly writeVerdict: WriteVerdict | null;
      readonly failureKind: FailureKind | null;
      readonly result: FinalizationPlan["result"];
    }): FinalizationPlan => {
      const derived = deriveOutcome({
        mode: "write",
        workflow: null,
        writeCompleted: evidence.writeCompleted,
        writeReviewRan: evidence.writeReviewRan,
        writeVerdict: evidence.writeVerdict,
        failureKind: evidence.failureKind,
        reconciled: false,
      });
      return Object.freeze({
        taskId: task.taskId,
        projectId: this.#project.projectId,
        mode: "write" as const,
        outcome: derived.outcome,
        reviewStatus: derived.reviewStatus,
        failureKind: evidence.failureKind,
        basis: derived.basis,
        result: evidence.result,
        observation: Object.freeze({
          predicted: input.observation.predicted,
          effective: input.observation.effective,
          // Executed attribution from this task's own provider events, with the plan supplying the
          // roles that were routed and never dispatched. A reviewer the plan named but the run never
          // reached is recorded as planned, not as one that ran.
          roles: executionAttribution({ events: this.#ledger.receipt(task.taskId).events, planned: observationRolesFor(plan.roles) }),
          prior: input.observation.prior,
        }),
        reconciled: false,
        ledgerState: ledgerStateFor(derived.outcome, "write"),
      });
    };
    let finalization: FinalizationPlan | null = null;
    let finalized = false;
    const complete = (): void => {
      if (finalized || finalization === null) return;
      finalized = true;
      this.#finalizer.finalize(finalization);
    };
    // The receipt is read after finalization, not while building the return value: a return
    // expression is evaluated before the surrounding `finally` runs, so reading it there would
    // report the state from before the outcome was recorded.
    const finish = (): TaskReceipt => {
      complete();
      return this.#ledger.receipt(task.taskId);
    };
    // A termination signal is the only warning this process gets before it stops writing. Without
    // this the task would stay `running` and its worktree would be left to a later reconciler.
    const unregister = registerActiveRun(() => {
      finalization ??= planFor({
        writeCompleted: false,
        writeReviewRan: false,
        writeVerdict: null,
        failureKind: "interrupted",
        result: Object.freeze({ kind: "none" as const, text: null, evidence: "lost-to-crash" as const }),
      });
      complete();
    });

    const worktrees = new WorktreeGuard(this.#project);
    let handle: { readonly repositoryPath: string; readonly worktreePath: string; readonly branch: string | null; readonly baseRef: string; readonly worktree?: import("@braingate/execution").WorktreeHandle };
    try {
      handle = direct
        // The workspace itself. `worktreePath` is the same directory, because in this policy there
        // is no second place for the work to happen — and every reader below that says "the
        // worktree" is reading the operator's own files, which is the point of the policy.
        ? { repositoryPath: input.repositoryPath, worktreePath: input.repositoryPath, branch: null, baseRef: plan.baseRef }
        : (() => { const prepared = worktrees.prepare({ taskId: task.taskId, repositoryPath: input.repositoryPath, baseRef: plan.baseRef }); return { repositoryPath: prepared.repositoryPath, worktreePath: prepared.worktreePath, branch: prepared.branch, baseRef: prepared.baseRef, worktree: prepared }; })();
      // The state of the source checkout before anything ran, as a hash of everything a provider
      // could touch: HEAD, the index, tracked changes, and the *content* of untracked and
      // ignored files — which is where a `.env` lives, and where `git status` alone sees nothing.
      // Every check below compares against this rather than merely asking whether the tree is
      // clean, because a run that rewrote an ignored file would leave it clean and changed.
      // The state the workspace was in before the worker touched it. In DIRECT that is what the
      // change report is computed from; in the worktree mode it is what proves the source checkout
      // was never the thing being edited.
      const workspaceBefore: WorkspaceSnapshot = snapshotWorkspace(direct ? handle.worktreePath : handle.repositoryPath);
      const sourceBefore = direct ? null : sourceCheckoutFingerprint(handle.repositoryPath);
      this.#ledger.transition(task.taskId, "running", { write: true, branch: handle.branch, workspace: direct ? "workspace" : "task-worktree", executionPolicy: plan.policy });
      const primary = plan.roles[0]!;
      const primarySnapshot = snapshotFor(this.#providers, primary.model.providerId);
      // Turns and wall clock come from the task's own budget rather than a fixed ceiling, for
      // the same reason maxContextTokens scales: a large repository costs turns to navigate
      // before the edit is even reached.
      // A schema path outside the worktree, for a CLI that reads its schema from a file: inside
      // it, the schema would arrive in the diff as part of the change.
      const schemaPath = join(this.#project.storageDir, "write-schemas", `${task.taskId}.json`);
      const invocation = planWriteInvocation({
        snapshot: primarySnapshot, model: primary.model, cwd: handle.worktreePath,
        ...(direct ? { nativeHarness: true } : {}),
        task: input.task, context: input.context, maxTurns: input.budget.maxInspectionTurns, schemaPath,
        ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }),
        // The write profile's proof, not the reviewer's: they are different policies.
        ...(this.#grokWriteIsolation === undefined ? {} : { grokIsolation: this.#grokWriteIsolation }),
      });
      // The write path recorded no provider events at all: a task that spent a subscription and
      // came back empty left nothing saying a call had happened. These are the same event kinds
      // the read path emits, so one reader understands both.
      this.#ledger.appendEvent(task.taskId, "shadow.provider.started", { role: "primary", phase: "write", provider: primary.model.providerId, model: primary.model.modelId, quotaPool: primary.model.quotaPool });
      const result = await this.#writer.run({ plan: invocation, timeoutMs: input.budget.maxInspectionMs, ...(input.env === undefined ? {} : { env: input.env }) });
      if (!result.spawned || result.timedOut || result.exitCode !== 0) {
        // Recognised and recorded even though this path will not act on it: a write that was refused
        // is a fact the operator needs, whether or not a failover is safe here (it is not — the
        // worktree may already carry the first agent's partial work).
        const writeRefusal = providerQuotaRefusal(primary.model.providerId, primary.model.quotaPool, `${result.stdout}\n${result.stderr}`);
        this.#ledger.appendEvent(task.taskId, "shadow.provider.failed", {
          ...(writeRefusal === null ? {} : { quotaRefusal: writeRefusal }),
          role: "primary",
          phase: "write",
          provider: primary.model.providerId,
          model: primary.model.modelId,
          quotaPool: primary.model.quotaPool,
          failureKind: result.timedOut ? "timeout" : "provider-failed",
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          error: result.stderr.slice(0, 500),
          // Bounded evidence of what the CLI said. The write executor already redacts.
          stderrTail: result.stderr.slice(-2_000),
          stdoutTail: result.stdout.slice(-2_000),
        });
        throw new BrainGateInvariantError("WRITE_PROVIDER_FAILED", `${primary.model.providerId} write provider failed with exit ${result.exitCode ?? "none"}${result.timedOut ? " (timeout/output cap)" : ""}.`);
      }
      this.#ledger.appendEvent(task.taskId, "shadow.provider.completed", { role: "primary", phase: "write", provider: primary.model.providerId, model: primary.model.modelId, quotaPool: primary.model.quotaPool, durationMs: result.durationMs });
      this.#ledger.recordUsage({ taskId: task.taskId, provider: primary.model.providerId, model: primary.model.modelId, evidence: "measured", metric: "provider_call", value: 1, unit: "call" });
      this.#ledger.recordUsage({ taskId: task.taskId, provider: primary.model.providerId, model: primary.model.modelId, evidence: "measured", metric: "duration_ms", value: result.durationMs, unit: "ms" });
      this.#ledger.recordUsage({ taskId: task.taskId, provider: primary.model.providerId, model: primary.model.modelId, evidence: "unknown", metric: "provider_tokens", value: null, unit: "tokens" });

      // A visual task runs a second, artifact-producing invocation in the same worktree. It is
      // the same task, guarded the same way: the artifacts join the diff rather than bypassing
      // it, and everything below — verification, review, approval — is unchanged.
      let artifacts: readonly CollectedArtifact[] = [];
      if (input.visual !== undefined) {
        artifacts = await this.#runVisual({ input, task, handle, visual: input.visual });
      }

      // What changed, observed rather than taken on the worker's word. In DIRECT this is the whole
      // report: there is no diff against a base to take, because the workspace may already have
      // carried the operator's own uncommitted work before the run started.
      const observed = workspaceChangesSince(workspaceBefore, snapshotWorkspace(handle.worktreePath));
      const observedFiles = observed === null ? Object.freeze([]) : changedPaths(observed);
      const guarded = direct
        ? Object.freeze({ changedFiles: observedFiles, diff: "" })
        : collectGuardedDiff(handle.worktreePath, artifacts);
      if (sourceBefore !== null) assertSourceCheckoutUnchanged(handle.repositoryPath, sourceBefore);
      this.#ledger.appendEvent(task.taskId, "write.changes_collected", {
        changedFiles: guarded.changedFiles,
        changedFileCount: guarded.changedFiles.length,
        diffBytes: Buffer.byteLength(guarded.diff, "utf8"),
        executionPolicy: plan.policy,
        ...(direct ? { observedInPlace: true } : {}),
        ...(direct && observed !== null && observed.changedTotal > observedFiles.length ? { changedFilesTruncatedFrom: observed.changedTotal } : {}),
      });
      if (artifacts.length > 0) {
        // Path, media type, size and hash: what a reviewer needs to judge a file they cannot read.
        this.#ledger.appendEvent(task.taskId, "write.artifacts_collected", { artifacts: artifacts.map((artifact) => ({ path: artifact.path, mediaType: artifact.mediaType, bytes: artifact.bytes, sha256: artifact.sha256 })) });
      }

      // In DIRECT the workspace is not a diff against a base, so `git diff --check` would be
      // checking the operator's own uncommitted work as much as this run's. Nothing is claimed:
      // an empty verification list is the honest answer, and the changed-file list is the evidence.
      // `git diff --check` over the task's own worktree, once. The real handle is passed rather
      // than a rebuilt one: the runner validates it against the project, and a hand-made object
      // would be refused by that check rather than by anything being wrong.
      const verifier = new SafeCommandRunner([{ executable: "git", args: ["diff", "--check"] }]);
      const verifyResult = direct ? null : await verifier.run({
        project: this.#project, profile: "verify",
        ...(handle.worktree === undefined ? {} : { worktree: handle.worktree }),
        command: { executable: "git", args: ["diff", "--check"], cwd: handle.worktreePath },
        ...(input.env === undefined ? {} : { env: input.env }),
        timeoutMs: 30_000, maxOutputBytes: 256 * 1024,
      });
      const whitespace = verifyResult === null ? null : { exitCode: verifyResult.exitCode, timedOut: verifyResult.timedOut };
      const verification: readonly WriteVerificationResult[] = whitespace === null
        ? Object.freeze([])
        : Object.freeze([Object.freeze({ command: "git diff --check", passed: !whitespace.timedOut && whitespace.exitCode === 0, exitCode: whitespace.exitCode, timedOut: whitespace.timedOut })]);
      if (verification.length > 0 && !verification[0]!.passed) {
        this.#ledger.appendEvent(task.taskId, "write.verification_failed", { command: "git diff --check", exitCode: verification[0]!.exitCode, timedOut: verification[0]!.timedOut });
        finalization = planFor({ writeCompleted: false, writeReviewRan: false, writeVerdict: null, failureKind: "verification-failed", result: Object.freeze({ kind: "none" as const, text: null, evidence: "unavailable" as const }) });
        return Object.freeze({ dryRun: false, taskId: task.taskId, worktree: Object.freeze({ path: handle.worktreePath, branch: handle.branch, baseRef: handle.baseRef }), changedFiles: guarded.changedFiles, diff: guarded.diff, verification: Object.freeze(verification), review: null, readyForApproval: false, approvalRequired: true, mergePerformed: false, taskReceipt: finish() });
      }

      this.#ledger.transition(task.taskId, "verifying", { write: true, changedFileCount: guarded.changedFiles.length });
      let review: WriteRunResult["review"] = null;
      const reviewerRole = plan.roles.find((role) => role.role === "reviewer");
      if (reviewerRole !== undefined) {
        const invoker = new SubscriptionShadowAgentInvoker({
          project: this.#project,
          cwd: handle.repositoryPath,
          snapshots: this.#providers,
          attestations: this.#attestations,
          acceptances: this.#acceptances,
          ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }),
          ...(this.#grokIsolation === undefined ? {} : { grokIsolation: this.#grokIsolation }),
          context: {
            changedFiles: guarded.changedFiles,
            mode: direct ? "workspace-change-review" : "worktree-diff-review",
            ...(direct ? { note: "The worker edited the workspace in place; read the files listed here for the current content." } : {}),
          },
          ...(this.#reviewExecutor === undefined ? {} : { executor: this.#reviewExecutor }),
          ledger: this.#ledger,
          taskId: task.taskId,
        });
        const response = await invoker.invoke({ role: "reviewer", model: reviewerRole.model, phase: "write-review", task: input.task, findings: Object.freeze([]), candidateOutput: direct ? null : guarded.diff });
        if (response.kind !== "review") throw new BrainGateInvariantError("WRITE_REVIEW_INVALID", "Write reviewer did not return a review verdict.");
        review = Object.freeze({ providerId: reviewerRole.model.providerId, modelId: reviewerRole.model.modelId, verdict: response.verdict, findings: response.findings });
        this.#ledger.appendEvent(task.taskId, `write.review.${response.verdict}`, { provider: reviewerRole.model.providerId, model: reviewerRole.model.modelId, findingCount: response.findings.length });
      }

      // Only the worktree mode asserts the source checkout is untouched. In DIRECT the source
      // *is* what changed, which is why the observation above is the record rather than a failure.
      if (sourceBefore !== null) assertSourceCheckoutUnchanged(handle.repositoryPath, sourceBefore);
      const readyForApproval = review === null || review.verdict === "approve";
      finalization = planFor({
        writeCompleted: true,
        writeReviewRan: review !== null,
        writeVerdict: review !== null && isWriteVerdict(review.verdict) ? review.verdict : null,
        failureKind: null,
        // The guarded diff is the result: it is what the operator approves and what a later reader
        // needs in order to judge the change without re-running a provider to see it again.
        result: guarded.changedFiles.length > 0
          ? Object.freeze({ kind: "diff" as const, text: guarded.diff, evidence: "redacted" as const })
          : Object.freeze({ kind: "none" as const, text: null, evidence: "unavailable" as const }),
      });
      return Object.freeze({
        dryRun: false,
        taskId: task.taskId,
        // The plan and the receipt both name the boundary: `worktree` is null for a DIRECT run,
        // because there is no second directory and pretending there is one would be the lie.
        worktree: direct ? null : Object.freeze({ path: handle.worktreePath, branch: handle.branch, baseRef: handle.baseRef }),
        executionPolicy: plan.policy,
        providerCwd: handle.worktreePath,
        changedFiles: guarded.changedFiles,
        diff: guarded.diff,
        verification: Object.freeze(verification),
        review,
        // Nothing to approve and nothing to merge: the operator reviews their own working tree, and
        // no commit was made — a DIRECT run leaves the workspace exactly as the worker left it.
        readyForApproval: direct ? false : readyForApproval,
        approvalRequired: !direct,
        mergePerformed: false,
        taskReceipt: finish(),
      });
    } catch (error) {
      // No transition here: the finalizer owns the terminal state, and it derives it from the same
      // evidence a reconciler would find — so a run that dies right now is repaired to the state
      // this code would have written, rather than to a different one.
      finalization = planFor({
        writeCompleted: false,
        writeReviewRan: false,
        writeVerdict: null,
        failureKind: error instanceof BrainGateInvariantError ? failureKindFromCode(error.code) : "unknown",
        result: Object.freeze({ kind: "none" as const, text: null, evidence: "lost-to-crash" as const }),
      });
      throw error;
    } finally {
      unregister();
      // The worktree is released before the record is attempted, and the record is attempted even
      // if the release throws: an unremovable worktree must not also lose the task's outcome.
      try { worktrees.close(); }
      finally {
        // The attribution is durable before the observation that reads it.
        try { this.#ledger.appendEvent(task.taskId, "task.execution", executionRecord(executionAttribution({ events: this.#ledger.receipt(task.taskId).events, planned: observationRolesFor(plan.roles) }))); }
        catch { /* evidence, not the run's own error: never replace it */ }
        try { complete(); } catch { /* an incomplete record is reconciled later, not hidden */ }
      }
    }
  }

  /**
   * Runs the artifact-producing pass and collects what it declared.
   *
   * The provider runs read-only against the worktree: it writes its image into its own home,
   * declares the path, and BrainGate copies it in (ADR 0007). Nothing here relaxes the write
   * boundary — the collector proves each file, and the diff guard exempts only those exact
   * paths.
   */
  async #runVisual(input: {
    readonly input: { readonly budget: ExecutionBudget; readonly env?: NodeJS.ProcessEnv };
    readonly task: { readonly taskId: string };
    readonly handle: { readonly worktreePath: string };
    readonly visual: VisualRequest;
  }): Promise<readonly CollectedArtifact[]> {
    const snapshot = snapshotFor(this.#providers, input.visual.model.providerId);
    const plan = planCodexVisualInvocation({
      snapshot,
      model: input.visual.model,
      cwd: input.handle.worktreePath,
      payload: { schemaVersion: 1, role: "visual", task: input.visual.task, context: input.visual.context ?? {} },
      ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }),
    });

    const imagesDir = join(resolveCodexHome(input.input.env ?? process.env), CODEX_GENERATED_IMAGES);
    const before = new Set(generatedImages(imagesDir));

    const executor = this.#visualExecutor ?? new NodeShadowProcessExecutor();
    const result = await executor.run({ project: this.#project, plan, timeoutMs: input.input.budget.maxInspectionMs });
    const generatedAfter = generatedImages(imagesDir);
    if (!result.spawned || result.timedOut || result.exitCode !== 0) {
      throw new BrainGateInvariantError("VISUAL_PROVIDER_FAILED", `Codex visual provider failed with exit ${result.exitCode ?? "none"}${result.timedOut ? " (timeout/output cap)" : ""}.`);
    }
    this.#ledger.recordUsage({ taskId: input.task.taskId, provider: plan.providerId, model: plan.modelId, evidence: "measured", metric: "provider_call", value: 1, unit: "call" });

    // Where the image actually is, rather than where the provider says it is.
    //
    // ADR 0007 asked the provider to declare the absolute path it wrote. Running it showed that
    // it cannot: Codex names generated files itself, under `generated_images/<session>/` in its
    // own home, and the model is never told the path. It answered in prose and the task failed
    // with "declared no artifacts" while three perfectly good PNGs sat on disk.
    //
    // So BrainGate finds them. The set of files under that directory is recorded before the run
    // and compared after, which needs no cooperation from the model and cannot be talked into
    // naming a file that was never made. A declaration is still honoured when one is offered,
    // because a provider that does know its own paths should be believed about them.
    const declared = parseArtifactDeclarations(extractCodexAgentMessage(result.stdout));
    const produced = declared.length > 0
      ? declared
      : [...before].length === 0 && generatedAfter.length === 0
        ? []
        : generatedAfter.filter((path) => !before.has(path)).map((sourcePath, index) => Object.freeze({
          sourcePath,
          destination: input.visual.destination.replace(/(\.[^./]+)?$/, (extension) => `${index === 0 ? "" : `-${String(index + 1)}`}${extension}`),
        }));
    if (produced.length === 0) {
      throw new BrainGateInvariantError("VISUAL_NO_ARTIFACTS", "The visual provider produced no image, so the task produced nothing to review.");
    }
    return collectArtifacts({ worktreePath: input.handle.worktreePath, declarations: produced });
  }

}
