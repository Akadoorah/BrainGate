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
  readonly context: unknown;
  readonly responseContract: Readonly<Record<string, unknown>>;
}

export type ShadowInputMode = "stdin" | "temp-attachment";

export interface ShadowInvocationPlan {
  readonly providerId: ProviderId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
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
