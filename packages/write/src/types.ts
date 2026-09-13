import type { ExecutionBudget, ExecutionPolicyId, TaskClassification, TaskReceipt } from "@braingate/core";
import type { ProviderId } from "@braingate/providers";
import type { ModelRef, RouteResult } from "@braingate/router";
import type { ToolGrant } from "@braingate/shadow";

export interface WriteProviderPlan {
  readonly providerId: ProviderId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly modelId: string;
  readonly quotaPool: string;
  readonly stdin: string;
  readonly allowedEnvKeys: readonly string[];
  readonly envOverrides: Readonly<Record<string, string>>;
  /**
   * What this run was permitted to do (ADR 0010), recorded on the plan the operator reads.
   */
  readonly grant: ToolGrant;
  /**
   * Files BrainGate writes into the worktree for the run and removes when it ends.
   *
   * Grok reads its sandbox profile from `.grok/sandbox.toml` inside the working directory, which
   * for a write task is the worktree the change is collected from. The file is BrainGate's, not
   * the task's, so it is removed before the diff is taken — by exact path, so anything else the
   * run left under that directory still reaches the diff guard.
   */
  readonly runtimeFiles?: Readonly<Record<string, string>>;
  /** A file the CLI reads but the model never sees, kept outside the worktree so it cannot join the diff. */
  readonly externalFiles?: Readonly<Record<string, string>>;
}

export interface WriteProviderResult {
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly removedEnvironmentKeys: readonly string[];
}

export interface WriteProviderExecutor {
  run(input: { readonly plan: WriteProviderPlan; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly maxOutputBytes?: number }): Promise<WriteProviderResult>;
}

export interface PlannedWriteRole {
  readonly role: "primary" | "reviewer";
  readonly model: ModelRef;
  readonly route: RouteResult;
  readonly workspace: "task-worktree" | "staged-review" | "project-read-only" | "workspace";
}

export interface WriteTaskPlan {
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly repositoryPath: string;
  readonly baseRef: string;
  /** The boundary this plan runs inside: the workspace itself, or an isolated worktree (ADR 0017). */
  readonly policy: ExecutionPolicyId;
  readonly roles: readonly PlannedWriteRole[];
  readonly providerCallsOnPlan: 0;
  readonly createsWorktree: false;
  readonly mergeAvailable: false;
}

export interface WriteVerificationResult {
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface WriteRunResult {
  readonly dryRun: boolean;
  readonly taskId: string | null;
  /** `null` under the DIRECT policy: the run happened in the workspace, so there is no second directory. */
  readonly worktree: Readonly<{ path: string; branch: string | null; baseRef: string }> | null;
  readonly executionPolicy?: ExecutionPolicyId;
  /** The directory the worker ran in, recorded so the cwd a run actually used can be audited. */
  readonly providerCwd?: string;
  readonly changedFiles: readonly string[];
  readonly diff: string;
  readonly verification: readonly WriteVerificationResult[];
  readonly review: Readonly<{ providerId: string; modelId: string; verdict: string; findings: readonly string[] }> | null;
  /** True only when verification passed and the configured reviewer approved (or review was explicitly disabled). */
  readonly readyForApproval: boolean;
  /** False under DIRECT: the change is already in the workspace, so there is nothing to approve. */
  readonly approvalRequired: boolean;
  readonly mergePerformed: false;
  readonly taskReceipt: TaskReceipt | null;
}

/**
 * An artifact-producing pass attached to a write task (ADR 0007).
 *
 * Optional: a write task without one behaves exactly as before, which is why the visual role
 * reuses the write boundary rather than introducing a second path beside it.
 */
export interface VisualRequest {
  readonly model: ModelRef;
  readonly task: string;
  /**
   * Where the image belongs in the project, relative to the worktree.
   *
   * Named by the operator, because it is the half of the answer the provider genuinely does not
   * have: Codex chooses the file's own path and never learns the project's.
   */
  readonly destination: string;
  readonly context?: unknown;
}
