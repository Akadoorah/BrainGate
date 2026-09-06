import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import type { ShadowInvocationPlan, ShadowInvocationPreview, ShadowRolePayload, SubscriptionAttestation } from "./types.js";

const CLAUDE_MINIMUM = "2.1.248";
const ATTACHMENT_TOKEN = "__BRAINGATE_SHADOW_INPUT__";
const GENERIC_PROMPT = "Read the BrainGate shadow input supplied out-of-band. Analyze only; do not modify files, run commands, access the network, or use external tools. Return only valid JSON matching responseContract.";

interface ProfileDefinition {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
  readonly minimumVersion: string | null;
  readonly blockedReason: string | null;
}

const PROFILES: Readonly<Record<ProviderId, ProfileDefinition>> = Object.freeze({
  anthropic: { providerId: "anthropic", enabled: true, minimumVersion: CLAUDE_MINIMUM, blockedReason: null },
  "github-copilot": { providerId: "github-copilot", enabled: true, minimumVersion: null, blockedReason: null },
  openai: { providerId: "openai", enabled: false, minimumVersion: null, blockedReason: "Codex CLI read-only mode does not yet enforce project-only readable roots in BrainGate; restricted-root app-server isolation is required." },
  xai: { providerId: "xai", enabled: false, minimumVersion: null, blockedReason: "Grok read-only permits broad filesystem reads while strict mode permits CWD writes; hardened clean-config isolation is not yet verified." },
  google: { providerId: "google", enabled: false, minimumVersion: null, blockedReason: "Antigravity strict mode has not yet been verified as a stable per-invocation headless enforcement mechanism." },
});

function versionTuple(value: string | null): readonly [number, number, number] | null {
  if (value === null) return null;
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function versionAtLeast(actual: string | null, minimum: string): boolean {
  const a = versionTuple(actual);
  const m = versionTuple(minimum);
  if (a === null || m === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! > m[index]!) return true;
    if (a[index]! < m[index]!) return false;
  }
  return true;
}

function validAttestation(attestation: SubscriptionAttestation | undefined, providerId: ProviderId, now: Date): boolean {
  if (attestation === undefined || attestation.providerId !== providerId || attestation.mode !== "subscription") return false;
  const observed = new Date(attestation.observedAt);
  if (Number.isNaN(observed.getTime())) return false;
  if (observed.getTime() > now.getTime() + 60_000) return false;
  if (now.getTime() - observed.getTime() > 30 * 24 * 60 * 60 * 1000) return false;
  if (attestation.expiresAt !== undefined && attestation.expiresAt !== null) {
    const expires = new Date(attestation.expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return false;
  }
  return true;
}

function assertAuth(snapshot: ProviderSnapshot, attestation: SubscriptionAttestation | undefined, now: Date): void {
  if (snapshot.authMode.value === "api") {
    throw new BrainGateInvariantError("SHADOW_API_AUTH_DENIED", `${snapshot.displayName} is authenticated for API billing, not subscription shadow usage.`);
  }
  if (snapshot.authState.value === "unauthenticated") {
    throw new BrainGateInvariantError("SHADOW_AUTH_REQUIRED", `${snapshot.displayName} is not authenticated.`);
  }
  if (snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription") return;
  if (validAttestation(attestation, snapshot.providerId, now)) return;
  throw new BrainGateInvariantError("SHADOW_AUTH_REQUIRED", `${snapshot.displayName} subscription authentication is not proven. A valid local user attestation is required when safe discovery reports unknown.`);
}

function assertProfile(snapshot: ProviderSnapshot, model: ModelRef, attestation: SubscriptionAttestation | undefined, now: Date): ProfileDefinition {
  if (snapshot.providerId !== model.providerId) throw new BrainGateInvariantError("SHADOW_PROVIDER_MISMATCH", "Provider snapshot and routed model do not match.");
  const profile = PROFILES[snapshot.providerId];
  if (!profile.enabled) throw new BrainGateInvariantError("SHADOW_PROVIDER_BLOCKED", profile.blockedReason ?? "Provider shadow profile is blocked.");
  if (snapshot.available.value !== true) throw new BrainGateInvariantError("SHADOW_PROVIDER_UNAVAILABLE", `${snapshot.displayName} CLI is unavailable.`);
  if (snapshot.capabilities.value.headless !== true || snapshot.capabilities.value.modelPinning !== true) {
    throw new BrainGateInvariantError("SHADOW_CAPABILITY_UNPROVEN", `${snapshot.displayName} headless/model-pinning capability is not proven by discovery.`);
  }
  assertAuth(snapshot, attestation, now);
  if (profile.minimumVersion !== null && !versionAtLeast(snapshot.version.value, profile.minimumVersion)) {
    throw new BrainGateInvariantError("SHADOW_VERSION_TOO_OLD", `${snapshot.displayName} must be at least ${profile.minimumVersion}; discovered ${snapshot.version.value ?? "unknown"}.`);
  }
  if (snapshot.models.value !== null && snapshot.models.value.length > 0 && !snapshot.models.value.includes(model.modelId)) {
    throw new BrainGateInvariantError("SHADOW_MODEL_UNAVAILABLE", `Routed model ${model.modelId} is not in the provider's discovered model list.`);
  }
  return profile;
}

function serializedPayload(payload: ShadowRolePayload): string {
  const json = JSON.stringify(payload);
  if (json.length === 0 || json.length > 2_000_000) throw new BrainGateInvariantError("SHADOW_PAYLOAD_INVALID", "Shadow payload must be between 1 and 2,000,000 characters.");
  return json;
}

export function planShadowInvocation(input: {
  readonly snapshot: ProviderSnapshot;
  readonly model: ModelRef;
  readonly cwd: string;
  readonly payload: ShadowRolePayload;
  readonly attestation?: SubscriptionAttestation;
  readonly maxTurns?: number;
  readonly now?: Date;
}): ShadowInvocationPlan {
  const now = input.now ?? new Date();
  const profile = assertProfile(input.snapshot, input.model, input.attestation, now);
  const body = serializedPayload(input.payload);
  const maxTurns = Math.max(1, Math.min(12, Math.floor(input.maxTurns ?? 6)));

  if (input.snapshot.providerId === "anthropic") {
    const args = Object.freeze([
      "--restricted",
      "-p", GENERIC_PROMPT,
      "--output-format", "json",
      "--no-session-persistence",
      "--no-chrome",
      "--disable-slash-commands",
      "--tools", "Read,Glob,Grep",
      "--disallowedTools", "mcp__*",
      "--max-turns", String(maxTurns),
      "--model", input.model.modelId,
    ]);
    if (args.includes("--bare") || args.includes("--dangerously-skip-permissions") || args.includes("--allow-dangerously-skip-permissions")) {
      throw new BrainGateInvariantError("SHADOW_PROFILE_UNSAFE", "Unsafe Claude permission/profile flags are forbidden.");
    }
    return Object.freeze({
      providerId: "anthropic",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      inputMode: "stdin",
      stdin: body,
      attachmentContent: null,
      attachmentToken: null,
      allowedEnvKeys: Object.freeze([]),
      envOverrides: Object.freeze({}),
      guarantees: Object.freeze({ projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true }),
      minimumVersion: profile.minimumVersion,
    });
  }

  if (input.snapshot.providerId === "github-copilot") {
    const args = Object.freeze([
      "-p", GENERIC_PROMPT,
      "--attachment", ATTACHMENT_TOKEN,
      `--model=${input.model.modelId}`,
      "--available-tools=view,grep,glob",
      "--allow-tool=read",
      "--deny-tool=write",
      "--deny-tool=shell",
      "--deny-tool=url",
      "--deny-tool=memory",
      "--disable-builtin-mcps",
      "--no-custom-instructions",
      "--no-ask-user",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-experimental",
      "--silent",
      "--stream=off",
      "--no-color",
    ]);
    return Object.freeze({
      providerId: "github-copilot",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      inputMode: "temp-attachment",
      stdin: null,
      attachmentContent: body,
      attachmentToken: ATTACHMENT_TOKEN,
      allowedEnvKeys: Object.freeze(["COPILOT_HOME"]),
      envOverrides: Object.freeze({}),
      guarantees: Object.freeze({ projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true }),
      minimumVersion: profile.minimumVersion,
    });
  }

  throw new BrainGateInvariantError("SHADOW_PROVIDER_BLOCKED", "Provider has no enabled shadow invocation profile.");
}

export function previewShadowInvocation(plan: ShadowInvocationPlan): ShadowInvocationPreview {
  return Object.freeze({
    providerId: plan.providerId,
    executable: plan.executable,
    args: Object.freeze([...plan.args]),
    cwd: plan.cwd,
    modelId: plan.modelId,
    quotaPool: plan.quotaPool,
    inputMode: plan.inputMode,
    guarantees: plan.guarantees,
    minimumVersion: plan.minimumVersion,
  });
}

export function shadowProviderStatus(providerId: ProviderId): Readonly<{ enabled: boolean; minimumVersion: string | null; reason: string | null }> {
  const profile = PROFILES[providerId];
  return Object.freeze({ enabled: profile.enabled, minimumVersion: profile.minimumVersion, reason: profile.blockedReason });
}
