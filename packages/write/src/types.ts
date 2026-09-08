import type { ExecutionBudget, TaskClassification, TaskReceipt } from "@braingate/core";
import type { ModelRef, RouteResult } from "@braingate/router";

export interface WriteProviderPlan {
  readonly providerId: "anthropic";
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly modelId: string;
  readonly quotaPool: string;
  readonly stdin: string;
  readonly allowedEnvKeys: readonly string[];
  readonly envOverrides: Readonly<Record<string, string>>;
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
  readonly workspace: "task-worktree" | "staged-review" | "project-read-only";
}

export interface WriteTaskPlan {
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly repositoryPath: string;
  readonly baseRef: string;
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
  readonly worktree: Readonly<{ path: string; branch: string; baseRef: string }> | null;
  readonly changedFiles: readonly string[];
  readonly diff: string;
  readonly verification: readonly WriteVerificationResult[];
  readonly review: Readonly<{ providerId: string; modelId: string; verdict: string; findings: readonly string[] }> | null;
  /** True only when verification passed and the configured reviewer approved (or review was explicitly disabled). */
  readonly readyForApproval: boolean;
  readonly approvalRequired: true;
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
  readonly context?: unknown;
}
