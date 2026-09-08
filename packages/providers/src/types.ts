import type { UsageEvidence } from "@braingate/core";

/**
 * The provider ids, as one list the type is derived from.
 *
 * A bare string-literal union has no runtime form, so every place that needed to check or
 * enumerate ids grew its own copy — and a copy that fell behind is exactly how a valid role
 * became "invalid" at the boundary between two packages. Adding a provider here changes the
 * type and the runtime check together, or it fails to compile.
 */
export const PROVIDER_IDS = ["anthropic", "openai", "google", "xai", "github-copilot"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
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
