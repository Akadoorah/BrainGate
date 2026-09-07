import { BrainGateInvariantError, type ExecutionBudget, type RegisteredProject, type TaskClassification, type TaskLedger } from "@braingate/core";
import { SafeCommandRunner, WorktreeGuard } from "@braingate/execution";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type ModelRef, type RouteResult } from "@braingate/router";
import { SubscriptionShadowAgentInvoker, shadowProviderRoleStatus, type CodexIsolationAttestation, type ShadowProcessExecutor, type SubscriptionAttestation } from "@braingate/shadow";
import { assertClaudeWriteEligible, NodeClaudeWriteExecutor, planClaudeWriteInvocation } from "./claude-write-profile.js";
import { assertSourceCheckoutClean, collectGuardedDiff } from "./diff-guard.js";
import type { PlannedWriteRole, WriteProviderExecutor, WriteRunResult, WriteTaskPlan, WriteVerificationResult } from "./types.js";

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

function reviewerExclusions(snapshots: readonly ProviderSnapshot[], codexIsolation: CodexIsolationAttestation | undefined, attestations: readonly SubscriptionAttestation[]): readonly string[] {
  return Object.freeze(snapshots.filter((snapshot) => {
    if (!shadowProviderRoleStatus(snapshot.providerId, "reviewer").enabled) return true;
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

export function buildWriteTaskPlan(input: {
  readonly router: CapabilityRouter;
  readonly providers: readonly ProviderSnapshot[];
  readonly attestations?: readonly SubscriptionAttestation[];
  readonly codexIsolation?: CodexIsolationAttestation;
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
    const reviewerRoute = input.router.route({
      role: "reviewer",
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      writeRequired: false,
      independence: { mode: "preferred", models: [primaryModel] },
      excludeProviders: reviewerExclusions(input.providers, input.codexIsolation, input.attestations ?? []),
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
  readonly #writer: WriteProviderExecutor;
  readonly #reviewExecutor: ShadowProcessExecutor | undefined;

  constructor(input: {
    readonly project: RegisteredProject;
    readonly ledger: TaskLedger;
    readonly router: CapabilityRouter;
    readonly providers: readonly ProviderSnapshot[];
    readonly attestations?: readonly SubscriptionAttestation[];
    readonly codexIsolation?: CodexIsolationAttestation;
    readonly writer?: WriteProviderExecutor;
    readonly reviewExecutor?: ShadowProcessExecutor;
  }) {
    this.#project = input.project;
    this.#ledger = input.ledger;
    this.#router = input.router;
    this.#providers = input.providers;
    this.#attestations = input.attestations ?? [];
    this.#codexIsolation = input.codexIsolation;
    this.#writer = input.writer ?? new NodeClaudeWriteExecutor();
    this.#reviewExecutor = input.reviewExecutor;
  }

  async run(input: {
    readonly task: string;
    readonly repositoryPath: string;
    readonly baseRef?: string;
    readonly classification: TaskClassification;
    readonly budget: ExecutionBudget;
    readonly requiredContextTokens: number;
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
      ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }),
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      repositoryPath: input.repositoryPath,
      baseRef: input.baseRef ?? "HEAD",
      review: input.review ?? true,
    });
    if (input.dryRun ?? false) return Object.freeze({ dryRun: true, taskId: null, worktree: null, changedFiles: Object.freeze([]), diff: "", verification: Object.freeze([]), review: null, readyForApproval: false, approvalRequired: true, mergePerformed: false, taskReceipt: null });

    const task = this.#ledger.createTask({ title: `Write ${input.classification.complexity} task`, complexity: input.classification.complexity, risk: input.classification.risk });
    this.#ledger.transition(task.taskId, "planned", { write: true, worktreeOnly: true, mergeAvailable: false });
    const worktrees = new WorktreeGuard(this.#project);
    let handle;
    try {
      handle = worktrees.prepare({ taskId: task.taskId, repositoryPath: input.repositoryPath, baseRef: plan.baseRef });
      this.#ledger.transition(task.taskId, "running", { write: true, branch: handle.branch, workspace: "task-worktree" });
      const primary = plan.roles[0]!;
      const primarySnapshot = snapshotFor(this.#providers, primary.model.providerId);
      const invocation = planClaudeWriteInvocation({ snapshot: primarySnapshot, model: primary.model, cwd: handle.worktreePath, task: input.task, context: input.context });
      const result = await this.#writer.run({ plan: invocation, ...(input.env === undefined ? {} : { env: input.env }) });
      if (!result.spawned || result.timedOut || result.exitCode !== 0) throw new BrainGateInvariantError("WRITE_PROVIDER_FAILED", `Claude write provider failed with exit ${result.exitCode ?? "none"}${result.timedOut ? " (timeout/output cap)" : ""}.`);
      this.#ledger.recordUsage({ taskId: task.taskId, provider: primary.model.providerId, model: primary.model.modelId, evidence: "measured", metric: "provider_call", value: 1, unit: "call" });
      this.#ledger.recordUsage({ taskId: task.taskId, provider: primary.model.providerId, model: primary.model.modelId, evidence: "measured", metric: "duration_ms", value: result.durationMs, unit: "ms" });
      this.#ledger.recordUsage({ taskId: task.taskId, provider: primary.model.providerId, model: primary.model.modelId, evidence: "unknown", metric: "provider_tokens", value: null, unit: "tokens" });

      const guarded = collectGuardedDiff(handle.worktreePath);
      assertSourceCheckoutClean(handle.repositoryPath);
      this.#ledger.appendEvent(task.taskId, "write.changes_collected", { changedFiles: guarded.changedFiles, changedFileCount: guarded.changedFiles.length, diffBytes: Buffer.byteLength(guarded.diff, "utf8") });

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
          ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }),
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
}
