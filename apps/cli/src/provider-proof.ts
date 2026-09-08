import { ProviderAcceptanceStore, type OperatorStatePaths } from "@braingate/operator";
import { isProviderId, type ProviderSnapshot } from "@braingate/providers";
import { GrokIsolationVerifier, type GrokIsolationAttestation, type OperatorProviderAcceptance, type SubscriptionAttestation } from "@braingate/shadow";
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
  return "GROK_ISOLATION_UNEXPECTED: the Grok sandbox self-test failed for an unrecognised reason.";
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
  readonly verify?: (snapshot: ProviderSnapshot) => Promise<GrokIsolationAttestation>;
}): Promise<IsolationStatus<GrokIsolationAttestation>> {
  const snapshot = input.snapshots.find((item) => item.providerId === "xai");
  if (snapshot === undefined || snapshot.available.value !== true) return failed("Grok CLI is unavailable.");
  if (snapshot.authState.value === "unauthenticated") return failed("Grok is not authenticated; run `grok login`.");
  if (!input.shouldAttempt) return failed("The Grok sandbox self-test was not needed for this command.");
  try {
    const attestation = input.verify === undefined
      ? await new GrokIsolationVerifier({ env: input.env }).verify(snapshot, { projectPaths: input.project?.repositories ?? [] })
      : await input.verify(snapshot);
    return Object.freeze({ attempted: true, eligible: true, attestation, reason: null });
  } catch (error) {
    return Object.freeze({ attempted: true, eligible: false, attestation: null, reason: describe(error) });
  }
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
      source: "operator-accepted-unscoped-provider",
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
