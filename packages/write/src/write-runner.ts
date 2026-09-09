import { BrainGateInvariantError, type ExecutionBudget, type RegisteredProject, type TaskClassification, type TaskLedger } from "@braingate/core";
import { SafeCommandRunner, WorktreeGuard } from "@braingate/execution";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type IndependenceConstraint, type ModelRef, type RouteResult } from "@braingate/router";
import { taskTitleFor } from "@braingate/security";
import { NodeShadowProcessExecutor, extractCodexAgentMessage, planCodexVisualInvocation, SubscriptionShadowAgentInvoker, shadowProviderRoleStatus, type CodexIsolationAttestation, type GrokIsolationAttestation, type OperatorProviderAcceptance, type ShadowProcessExecutor, type SubscriptionAttestation } from "@braingate/shadow";
import { assertClaudeWriteEligible, NodeClaudeWriteExecutor, planClaudeWriteInvocation } from "./claude-write-profile.js";
import { assertSourceCheckoutClean, collectGuardedDiff } from "./diff-guard.js";
import { collectArtifacts, parseArtifactDeclarations, type CollectedArtifact } from "./artifact-collector.js";
import type { PlannedWriteRole, VisualRequest, WriteProviderExecutor, WriteRunResult, WriteTaskPlan, WriteVerificationResult } from "./types.js";

function modelRef(route: RouteResult): ModelRef {
  const definition = route.selected.model.definition;
  return Object.freeze({ providerId: definition.providerId, modelId: definition.modelId, quotaPool: definition.quotaPool });
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

export function buildWriteTaskPlan(input: {
  readonly router: CapabilityRouter;
  readonly providers: readonly ProviderSnapshot[];
  readonly attestations?: readonly SubscriptionAttestation[];
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly grokIsolation?: GrokIsolationAttestation;
  readonly acceptances?: readonly OperatorProviderAcceptance[];
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly repositoryPath: string;
  readonly baseRef: string;
  readonly review?: boolean;
}): WriteTaskPlan {
  assertM11Scope(input.classification);
  if (input.requiredContextTokens > input.budget.maxContextTokens) throw new BrainGateInvariantError("WRITE_CONTEXT_BUDGET", "Required context exceeds the task Budget Governor limit.");
  const primaryExcluded = input.providers.filter((snapshot) => snapshot.providerId !== "anthropic").map((snapshot) => snapshot.providerId);
  const primaryRoute = input.router.route({ role: "coder", classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, writeRequired: true, excludeProviders: primaryExcluded });
  const primaryModel = modelRef(primaryRoute);
  assertClaudeWriteEligible(snapshotFor(input.providers, primaryModel.providerId), primaryModel);
  const roles: PlannedWriteRole[] = [Object.freeze({ role: "primary", model: primaryModel, route: primaryRoute, workspace: "task-worktree" })];

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
    roles: Object.freeze(roles),
    providerCallsOnPlan: 0,
    createsWorktree: false,
    mergeAvailable: false,
  });
}

export class WriteDogfoodRunner {
  readonly #project: RegisteredProject;
  readonly #ledger: TaskLedger;
  readonly #router: CapabilityRouter;
  readonly #providers: readonly ProviderSnapshot[];
  readonly #attestations: readonly SubscriptionAttestation[];
  readonly #codexIsolation: CodexIsolationAttestation | undefined;
  readonly #grokIsolation: GrokIsolationAttestation | undefined;
  readonly #acceptances: readonly OperatorProviderAcceptance[];
  readonly #writer: WriteProviderExecutor;
  readonly #reviewExecutor: ShadowProcessExecutor | undefined;
  readonly #visualExecutor: ShadowProcessExecutor | undefined;

  constructor(input: {
    readonly project: RegisteredProject;
    readonly ledger: TaskLedger;
    readonly router: CapabilityRouter;
    readonly providers: readonly ProviderSnapshot[];
    readonly attestations?: readonly SubscriptionAttestation[];
    readonly acceptances?: readonly OperatorProviderAcceptance[];
    readonly codexIsolation?: CodexIsolationAttestation;
    readonly grokIsolation?: GrokIsolationAttestation;
    readonly writer?: WriteProviderExecutor;
    readonly reviewExecutor?: ShadowProcessExecutor;
    /** Executor for the artifact-producing pass; defaults to the real one. */
    readonly visualExecutor?: ShadowProcessExecutor;
  }) {
    this.#project = input.project;
    this.#ledger = input.ledger;
    this.#router = input.router;
    this.#providers = input.providers;
    this.#attestations = input.attestations ?? [];
    this.#codexIsolation = input.codexIsolation;
    this.#grokIsolation = input.grokIsolation;
    this.#acceptances = input.acceptances ?? [];
    this.#writer = input.writer ?? new NodeClaudeWriteExecutor();
    this.#reviewExecutor = input.reviewExecutor;
    this.#visualExecutor = input.visualExecutor;
  }

  async run(input: {
    readonly task: string;
    readonly repositoryPath: string;
    readonly baseRef?: string;
    readonly classification: TaskClassification;
    readonly budget: ExecutionBudget;
    readonly requiredContextTokens: number;
    /** When present, an artifact-producing pass runs in the same worktree (ADR 0007). */
    readonly visual?: VisualRequest;
    readonly context: unknown;
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
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      repositoryPath: input.repositoryPath,
      baseRef: input.baseRef ?? "HEAD",
      review: input.review ?? true,
    });
    if (input.dryRun ?? false) return Object.freeze({ dryRun: true, taskId: null, worktree: null, changedFiles: Object.freeze([]), diff: "", verification: Object.freeze([]), review: null, readyForApproval: false, approvalRequired: true, mergePerformed: false, taskReceipt: null });

    const task = this.#ledger.createTask({ title: taskTitleFor(input.task), complexity: input.classification.complexity, risk: input.classification.risk });
    this.#ledger.transition(task.taskId, "planned", { write: true, worktreeOnly: true, mergeAvailable: false });
    const worktrees = new WorktreeGuard(this.#project);
    let handle;
    try {
      handle = worktrees.prepare({ taskId: task.taskId, repositoryPath: input.repositoryPath, baseRef: plan.baseRef });
      this.#ledger.transition(task.taskId, "running", { write: true, branch: handle.branch, workspace: "task-worktree" });
      const primary = plan.roles[0]!;
      const primarySnapshot = snapshotFor(this.#providers, primary.model.providerId);
      // Turns and wall clock come from the task's own budget rather than a fixed ceiling, for
      // the same reason maxContextTokens scales: a large repository costs turns to navigate
      // before the edit is even reached.
      const invocation = planClaudeWriteInvocation({ snapshot: primarySnapshot, model: primary.model, cwd: handle.worktreePath, task: input.task, context: input.context, maxTurns: input.budget.maxInspectionTurns });
      const result = await this.#writer.run({ plan: invocation, timeoutMs: input.budget.maxInspectionMs, ...(input.env === undefined ? {} : { env: input.env }) });
      if (!result.spawned || result.timedOut || result.exitCode !== 0) throw new BrainGateInvariantError("WRITE_PROVIDER_FAILED", `Claude write provider failed with exit ${result.exitCode ?? "none"}${result.timedOut ? " (timeout/output cap)" : ""}.`);
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

      const guarded = collectGuardedDiff(handle.worktreePath, artifacts);
      assertSourceCheckoutClean(handle.repositoryPath);
      this.#ledger.appendEvent(task.taskId, "write.changes_collected", { changedFiles: guarded.changedFiles, changedFileCount: guarded.changedFiles.length, diffBytes: Buffer.byteLength(guarded.diff, "utf8") });
      if (artifacts.length > 0) {
        // Path, media type, size and hash: what a reviewer needs to judge a file they cannot read.
        this.#ledger.appendEvent(task.taskId, "write.artifacts_collected", { artifacts: artifacts.map((artifact) => ({ path: artifact.path, mediaType: artifact.mediaType, bytes: artifact.bytes, sha256: artifact.sha256 })) });
      }

      const verifier = new SafeCommandRunner([{ executable: "git", args: ["diff", "--check"] }]);
      const verifyResult = await verifier.run({ project: this.#project, profile: "verify", worktree: handle, command: { executable: "git", args: ["diff", "--check"], cwd: handle.worktreePath }, ...(input.env === undefined ? {} : { env: input.env }), timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
      const verification: WriteVerificationResult[] = [Object.freeze({ command: "git diff --check", passed: !verifyResult.timedOut && verifyResult.exitCode === 0, exitCode: verifyResult.exitCode, timedOut: verifyResult.timedOut })];
      if (!verification[0]!.passed) {
        this.#ledger.appendEvent(task.taskId, "write.verification_failed", { command: "git diff --check", exitCode: verifyResult.exitCode, timedOut: verifyResult.timedOut });
        this.#ledger.transition(task.taskId, "failed", { write: true, reason: "verification", readyForApproval: false });
        return Object.freeze({ dryRun: false, taskId: task.taskId, worktree: Object.freeze({ path: handle.worktreePath, branch: handle.branch, baseRef: handle.baseRef }), changedFiles: guarded.changedFiles, diff: guarded.diff, verification: Object.freeze(verification), review: null, readyForApproval: false, approvalRequired: true, mergePerformed: false, taskReceipt: this.#ledger.receipt(task.taskId) });
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
          context: { changedFiles: guarded.changedFiles, mode: "worktree-diff-review" },
          ...(this.#reviewExecutor === undefined ? {} : { executor: this.#reviewExecutor }),
          ledger: this.#ledger,
          taskId: task.taskId,
        });
        const response = await invoker.invoke({ role: "reviewer", model: reviewerRole.model, phase: "write-review", task: input.task, findings: Object.freeze([]), candidateOutput: guarded.diff });
        if (response.kind !== "review") throw new BrainGateInvariantError("WRITE_REVIEW_INVALID", "Write reviewer did not return a review verdict.");
        review = Object.freeze({ providerId: reviewerRole.model.providerId, modelId: reviewerRole.model.modelId, verdict: response.verdict, findings: response.findings });
        this.#ledger.appendEvent(task.taskId, `write.review.${response.verdict}`, { provider: reviewerRole.model.providerId, model: reviewerRole.model.modelId, findingCount: response.findings.length });
      }

      assertSourceCheckoutClean(handle.repositoryPath);
      const readyForApproval = review === null || review.verdict === "approve";
      if (readyForApproval) this.#ledger.transition(task.taskId, "completed", { write: true, readyForApproval: true, approvalRequired: true, mergePerformed: false, branch: handle.branch });
      else this.#ledger.transition(task.taskId, "failed", { write: true, reason: "review", reviewVerdict: review?.verdict ?? "unknown", readyForApproval: false, approvalRequired: true, mergePerformed: false, branch: handle.branch });
      return Object.freeze({ dryRun: false, taskId: task.taskId, worktree: Object.freeze({ path: handle.worktreePath, branch: handle.branch, baseRef: handle.baseRef }), changedFiles: guarded.changedFiles, diff: guarded.diff, verification: Object.freeze(verification), review, readyForApproval, approvalRequired: true, mergePerformed: false, taskReceipt: this.#ledger.receipt(task.taskId) });
    } catch (error) {
      const current = this.#ledger.requireTask(task.taskId);
      if (current.state === "planned" || current.state === "running" || current.state === "verifying") this.#ledger.transition(task.taskId, "failed", { write: true, code: error instanceof BrainGateInvariantError ? error.code : "UNKNOWN" });
      throw error;
    } finally {
      worktrees.close();
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

    const executor = this.#visualExecutor ?? new NodeShadowProcessExecutor();
    const result = await executor.run({ project: this.#project, plan, timeoutMs: input.input.budget.maxInspectionMs });
    if (!result.spawned || result.timedOut || result.exitCode !== 0) {
      throw new BrainGateInvariantError("VISUAL_PROVIDER_FAILED", `Codex visual provider failed with exit ${result.exitCode ?? "none"}${result.timedOut ? " (timeout/output cap)" : ""}.`);
    }
    this.#ledger.recordUsage({ taskId: input.task.taskId, provider: plan.providerId, model: plan.modelId, evidence: "measured", metric: "provider_call", value: 1, unit: "call" });

    const declarations = parseArtifactDeclarations(extractCodexAgentMessage(result.stdout));
    if (declarations.length === 0) {
      throw new BrainGateInvariantError("VISUAL_NO_ARTIFACTS", "The visual provider declared no artifacts, so the task produced nothing to review.");
    }
    return collectArtifacts({ worktreePath: input.handle.worktreePath, declarations });
  }

}
