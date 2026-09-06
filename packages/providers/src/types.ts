import type { UsageEvidence } from "@braingate/core";

export type ProviderId = "anthropic" | "openai" | "google" | "xai" | "github-copilot";
export type ProviderAuthState = "authenticated" | "unauthenticated" | "unknown";
export type ProviderAuthMode = "subscription" | "api" | "unknown";
export type CapabilityValue = boolean | "unknown";

export interface Observation<T> {
  readonly value: T;
  readonly evidence: UsageEvidence;
  readonly sourceCommand: string | null;
  readonly observedAt: string;
}

export interface ProviderCapabilities {
  readonly headless: CapabilityValue;
  readonly structuredOutput: CapabilityValue;
  readonly modelPinning: CapabilityValue;
  readonly mcp: CapabilityValue;
}

export interface ProviderUsageSnapshot {
  readonly windows?: readonly Readonly<Record<string, unknown>>[];
  readonly credits?: Readonly<Record<string, unknown>>;
}

export interface ProviderSnapshot {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly binary: string;
  readonly available: Observation<boolean>;
  readonly version: Observation<string | null>;
  readonly authState: Observation<ProviderAuthState>;
  readonly authMode: Observation<ProviderAuthMode>;
  readonly models: Observation<readonly string[] | null>;
  readonly capabilities: Observation<ProviderCapabilities>;
  readonly usage: Observation<ProviderUsageSnapshot | null>;
  readonly removedBillingOverrides: readonly string[];
  readonly warnings: readonly string[];
}

export interface ProbeCommand {
  readonly binary: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface ProbeResult {
  readonly command: ProbeCommand;
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly errorCode: string | null;
  readonly observedAt: string;
  readonly removedBillingOverrides: readonly string[];
}

export interface ProbeRunner {
  run(command: ProbeCommand): Promise<ProbeResult>;
}
