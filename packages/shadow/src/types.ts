import type { RegisteredProject } from "@braingate/core";
import type { ProviderId } from "@braingate/providers";
import type { WorkflowRole } from "@braingate/workflows";

export interface SubscriptionAttestation {
  readonly providerId: ProviderId;
  readonly mode: "subscription";
  readonly source: "user-confirmed-oauth";
  readonly observedAt: string;
  readonly expiresAt?: string | null;
}

/**
 * The operator accepting, for one provider, a residual risk BrainGate cannot remove (ADR 0008).
 *
 * A provider whose permissions BrainGate cannot scope may read or write outside the project,
 * elsewhere on the machine. No guard here sees that. It is the same exposure as running the CLI
 * by hand, which the operator already does, but it is not zero — so it is accepted explicitly,
 * per provider, with a timestamp, and never inferred from the provider being installed,
 * authenticated, or previously used.
 */
export interface OperatorProviderAcceptance {
  readonly providerId: ProviderId;
  readonly source: "operator-accepted-unscoped-provider";
  readonly acceptedAt: string;
  readonly expiresAt?: string | null;
}

export interface ShadowGuarantees {
  readonly projectOnlyRead: boolean;
  readonly noProjectWrites: boolean;
  readonly noShell: boolean;
  readonly noNetworkTools: boolean;
  readonly noMcp: boolean;
  readonly noSessionPersistence: boolean;
  readonly isolatedUserConfig: boolean;
}

export interface ShadowRolePayload {
  readonly schemaVersion: 1;
  readonly role: WorkflowRole;
  readonly phase: string;
  readonly task: string;
  readonly findings: readonly string[];
  /** Current candidate output for review/judge/repair phases; omitted only by legacy/preflight callers. */
  readonly candidateOutput?: string | null;
  readonly context: unknown;
  readonly responseContract: Readonly<Record<string, unknown>>;
}

export type ShadowInputMode = "stdin" | "temp-attachment";
export type ShadowWorkspaceMode = "project" | "staged-clean";

export interface ShadowInvocationPlan {
  readonly providerId: ProviderId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspaceMode: ShadowWorkspaceMode;
  readonly modelId: string;
  readonly quotaPool: string;
  readonly inputMode: ShadowInputMode;
  readonly stdin: string | null;
  readonly attachmentContent: string | null;
  readonly attachmentToken: string | null;
  readonly allowedEnvKeys: readonly string[];
  readonly envOverrides: Readonly<Record<string, string>>;
  readonly guarantees: ShadowGuarantees;
  readonly minimumVersion: string | null;
}

export interface ShadowInvocationPreview {
  readonly providerId: ProviderId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspaceMode: ShadowWorkspaceMode;
  readonly modelId: string;
  readonly quotaPool: string;
  readonly inputMode: ShadowInputMode;
  readonly guarantees: ShadowGuarantees;
  readonly minimumVersion: string | null;
}

export interface ShadowProcessResult {
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly removedEnvironmentKeys: readonly string[];
}

export interface ShadowProcessExecutor {
  run(input: {
    readonly project: RegisteredProject;
    readonly plan: ShadowInvocationPlan;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }): Promise<ShadowProcessResult>;
}
