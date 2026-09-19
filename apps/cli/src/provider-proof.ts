import { resolve } from "node:path";
import { ProviderAcceptanceStore, type OperatorStatePaths } from "@braingate/operator";
import { isProviderId, type ProviderSnapshot } from "@braingate/providers";
import {
  CodexIsolationVerifier,
  GrokIsolationVerifier,
  IsolationAttestationCache,
  codexIsolationFingerprint,
  grokIsolationFingerprint,
  GROK_STAGED_SANDBOX,
  GROK_SNAPSHOT_READ_SANDBOX,
  validCodexIsolationAttestation,
  validGrokIsolationAttestation,
  validGrokSnapshotReadAttestation,
  shadowProviderRoleStatus,
  type CodexIsolationAttestation,
  type GrokIsolationAttestation,
  type GrokSandboxPolicy,
  type OperatorProviderAcceptance,
  type SubscriptionAttestation,
} from "@braingate/shadow";
import type { RegisteredProject } from "@braingate/core";
import { BrainGateInvariantError } from "@braingate/core";

/**
 * The per-run proofs a provider needs before BrainGate will route to it, gathered in one place
 * because both CLIs need the same answers and had started to disagree about them.
 *
 * Two different kinds of thing live here and are deliberately not merged. An *attestation* is
 * something BrainGate measured on this machine, moments ago, and re-measures rather than
 * remembers. An *acceptance* is something BrainGate cannot measure at all, decided by the
 * operator and written down. Only the first can be earned by a self-test; only the second can
 * cover a residual no test would clear.
 */

export interface IsolationStatus<T> {
  readonly attempted: boolean;
  readonly eligible: boolean;
  readonly attestation: T | null;
  readonly reason: string | null;
}

function failed(reason: string): IsolationStatus<never> {
  return Object.freeze({ attempted: false, eligible: false, attestation: null, reason });
}

function describe(error: unknown): string {
  if (error instanceof BrainGateInvariantError) return `${error.code}: ${error.message}`;
  return "ISOLATION_SELF_TEST_UNEXPECTED: a provider isolation self-test failed for an unrecognised reason.";
}

/** Where the proofs are remembered, beside the rest of BrainGate's own state. */
export function isolationCacheFor(state: OperatorStatePaths): IsolationAttestationCache {
  return new IsolationAttestationCache({ path: resolve(state.globalDir, "isolation-attestations.json") });
}

/**
 * Re-proves Grok's sandbox for this run, or explains why it is unavailable.
 *
 * The self-test spends nothing: Grok applies the profile and records it before it validates the
 * requested model, so a probe naming an impossible model returns the kernel policy in force
 * without reaching a completion. That is cheap enough to do per command rather than caching a
 * claim about a CLI the operator may have updated since.
 */
export async function grokIsolationStatus(input: {
  readonly snapshots: readonly ProviderSnapshot[];
  readonly env: NodeJS.ProcessEnv;
  readonly shouldAttempt: boolean;
  readonly project?: RegisteredProject;
  readonly cache?: IsolationAttestationCache;
  readonly verify?: (snapshot: ProviderSnapshot) => Promise<GrokIsolationAttestation>;
  /**
   * Which sandbox policy the proof is for. Defaults to the read-only staged profile.
   *
   * A write runs under a different profile, and its proof is a different proof: the hash covers
   * the policy, so one earned here is not accepted there.
   */
  readonly policy?: GrokSandboxPolicy;
  /**
   * Which posture the proof is for.
   *
   * `snapshot-read` is a different Grok home as well as a different profile: a read-primary run on a
   * project copy executes from a BrainGate-created home with no operator plugins, so it needs the
   * proof earned under that posture and is validated by the stricter check.
   */
  readonly mode?: "staged" | "snapshot-read";
}): Promise<IsolationStatus<GrokIsolationAttestation>> {
  const snapshot = input.snapshots.find((item) => item.providerId === "xai");
  if (snapshot === undefined || snapshot.available.value !== true) return failed("Grok CLI is unavailable.");
  if (snapshot.authState.value === "unauthenticated") return failed("Grok is not authenticated; run `grok login`.");
  if (!input.shouldAttempt) return failed("The Grok sandbox self-test was not needed for this command.");

  // The stored proof is a candidate, not a verdict: it is put through the same validation that
  // accepted it when it was earned, against the snapshot taken moments ago. A CLI that has been
  // updated, a policy whose hash has moved, or an entry past its own expiry falls through to a
  // fresh self-test rather than being believed.
  const snapshotRead = input.mode === "snapshot-read";
  const policy = input.policy ?? (snapshotRead ? GROK_SNAPSHOT_READ_SANDBOX : GROK_STAGED_SANDBOX);
  const accepts = (candidate: GrokIsolationAttestation): boolean =>
    snapshotRead
      ? validGrokSnapshotReadAttestation(candidate, snapshot, { projectPaths: input.project?.repositories ?? [] })
      : validGrokIsolationAttestation(candidate, snapshot, { policy });
  // The policy and the posture are part of the key: two profiles earn two proofs, and a cache that
  // conflated them would hand a write the answer a read-only run had earned.
  const fingerprint = input.cache === undefined ? null : safely(() => `${grokIsolationFingerprint(input.env, snapshot.binary)}:${policy.hash}`);
  if (input.cache !== undefined && fingerprint !== null) {
    const remembered = input.cache.read<GrokIsolationAttestation>("xai", fingerprint);
    if (remembered !== null && accepts(remembered)) {
      return Object.freeze({ attempted: false, eligible: true, attestation: remembered, reason: null });
    }
  }

  try {
    const attestation = input.verify === undefined
      ? await new GrokIsolationVerifier({ env: input.env }).verify(snapshot, { projectPaths: input.project?.repositories ?? [], policy, ...(snapshotRead ? { mode: "snapshot-read" as const } : {}) })
      : await input.verify(snapshot);
    if (input.cache !== undefined && fingerprint !== null) input.cache.write("xai", fingerprint, attestation);
    return Object.freeze({ attempted: true, eligible: true, attestation, reason: null });
  } catch (error) {
    return Object.freeze({ attempted: true, eligible: false, attestation: null, reason: describe(error) });
  }
}

/**
 * Codex's self-test, with the same treatment.
 *
 * Both CLIs grew their own copy of this and had started to differ; one place decides now.
 */
export async function codexIsolationStatusFor(input: {
  readonly snapshots: readonly ProviderSnapshot[];
  readonly env: NodeJS.ProcessEnv;
  readonly shouldAttempt: boolean;
  readonly cache?: IsolationAttestationCache;
  readonly verify?: (snapshot: ProviderSnapshot) => Promise<CodexIsolationAttestation>;
  /**
   * The self-test contract this proof must have been earned under.
   *
   * A caller that may route read-primary asks for the contract that proves the denied writes. A
   * remembered proof from an older contract is then not accepted — it is replaced by a fresh one, so
   * the operator gets the stronger proof instead of an error, and never a weaker guarantee.
   */
  readonly minProbeVersion?: string;
}): Promise<IsolationStatus<CodexIsolationAttestation>> {
  const snapshot = input.snapshots.find((item) => item.providerId === "openai");
  if (snapshot === undefined || snapshot.available.value !== true) return failed("Codex CLI is unavailable.");
  if (snapshot.authState.value !== "authenticated" || snapshot.authMode.value !== "subscription") {
    return failed("ChatGPT subscription authentication is not proven by `codex login status`.");
  }
  if (!input.shouldAttempt) return failed("Codex isolation self-test was not needed for this command.");

  const fingerprint = input.cache === undefined ? null : safely(() => codexIsolationFingerprint(input.env, snapshot.binary));
  if (input.cache !== undefined && fingerprint !== null) {
    const remembered = input.cache.read<CodexIsolationAttestation>("openai", fingerprint);
    const contract = input.minProbeVersion === undefined ? {} : { minProbeVersion: input.minProbeVersion };
    if (remembered !== null && validCodexIsolationAttestation(remembered, snapshot, contract)) {
      return Object.freeze({ attempted: false, eligible: true, attestation: remembered, reason: null });
    }
  }

  try {
    const attestation = input.verify === undefined
      ? await new CodexIsolationVerifier({ env: input.env }).verify(snapshot)
      : await input.verify(snapshot);
    if (input.cache !== undefined && fingerprint !== null) input.cache.write("openai", fingerprint, attestation);
    return Object.freeze({ attempted: true, eligible: true, attestation, reason: null });
  } catch (error) {
    return Object.freeze({ attempted: true, eligible: false, attestation: null, reason: describe(error) });
  }
}

/** A fingerprint that cannot be taken is a cache miss, never a failed command. */
function safely(compute: () => string): string | null {
  try { return compute(); }
  catch { return null; }
}

/** Every acceptance currently on record; staleness is judged where it is used, not here. */
export function loadAcceptances(state: OperatorStatePaths): readonly OperatorProviderAcceptance[] {
  const accepted: OperatorProviderAcceptance[] = [];
  for (const record of new ProviderAcceptanceStore(state.providerAcceptancePath).load()) {
    // An id no provider uses cannot gate anything, so it is skipped rather than carried
    // forward as an acceptance that silently matches nothing.
    if (!isProviderId(record.providerId)) continue;
    accepted.push(Object.freeze({
      providerId: record.providerId,
      source: record.source,
      acceptedAt: record.acceptedAt,
      expiresAt: record.expiresAt,
    }));
  }
  return Object.freeze(accepted);
}

/**
 * The subscription claim that comes with an acceptance.
 *
 * A provider BrainGate cannot scope is usually also one whose CLI will not say how it is
 * billed, and BrainGate refuses direct billing rather than guessing. The operator's acceptance
 * carries that statement, and it expires with the acceptance — so a stale decision fails the
 * auth check rather than quietly outliving it.
 */
export function acceptedSubscriptions(state: OperatorStatePaths): readonly SubscriptionAttestation[] {
  const claims: SubscriptionAttestation[] = [];
  for (const acceptance of loadAcceptances(state)) {
    // Only the unscoped-provider decision carries the subscription self-attestation with it.
    // Allowing a role to search the web says nothing about how the account is billed.
    if (acceptance.source !== "operator-accepted-unscoped-provider") continue;
    claims.push(Object.freeze({
      providerId: acceptance.providerId,
      mode: "subscription",
      source: "user-confirmed-oauth",
      observedAt: acceptance.acceptedAt,
      expiresAt: acceptance.expiresAt ?? null,
    }));
  }
  return Object.freeze(claims);
}

/** Whether a provider has any scored model in the catalogue, so a self-test is worth running. */
export function configuredProvider(entries: readonly { readonly providerId: string; readonly configured: boolean }[], providerId: string): boolean {
  return entries.some((entry) => entry.configured && entry.providerId === providerId);
}

/**
 * Whether an acceptance for this provider would change anything.
 *
 * Accepting a provider BrainGate can already isolate per run records a decision that grants
 * nothing and implies a risk the operator is not taking. The test is the provider's own role
 * policy: if some role is closed *and says so by naming `braingate providers accept`*, then an
 * acceptance opens it and asking for one is honest. Otherwise there is nothing to accept.
 *
 * Factored out of `providers accept` so the wizard asks exactly the question the command would,
 * rather than a second version of it that could drift — and so the wizard never puts the unscoped
 * risk in front of an operator whose provider does not run on acceptance at all.
 *
 * Takes either the id or a snapshot, because the two callers hold different things.
 */
export function acceptanceNeededFor(provider: string | { readonly providerId: string }): boolean {
  const providerId = typeof provider === "string" ? provider : provider.providerId;
  if (!isProviderId(providerId)) return false;
  return (["planner", "primary", "reviewer", "judge"] as const)
    .some((role) => (shadowProviderRoleStatus(providerId, role).reason ?? "").includes("braingate providers accept"));
}
