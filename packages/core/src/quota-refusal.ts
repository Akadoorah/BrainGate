/**
 * A provider's refusal of one call, and the difference between it and a known exhaustion window.
 *
 * The two are not the same fact and must not be collapsed:
 *
 * - **A refusal happened.** The provider declined *this* call and said why, in a machine-readable
 *   shape. That is evidence about the call, with a time on it.
 * - **A pool is exhausted until a known moment.** That is a claim about the future, and it can only
 *   be made from a machine-readable reset time. A refusal that carries no reset time says nothing
 *   about when the pool comes back, so treating it as sustained exhaustion — the shape routing reads
 *   as "current" when `resetAt` is null — would turn one refusal into an indefinite verdict.
 *
 * So a refusal is recorded as a refusal: who refused, which pool, why, when, and *what the provider
 * actually said*, with `resetAt` set only when the provider gave a machine-readable one. Routing
 * state is not moved by it. What a refusal legitimately proves is task-local: this pool should not
 * be called again *by this task*, which is exactly what the failover uses it for.
 */

import { BrainGateInvariantError } from "./errors.js";

export const QUOTA_REFUSAL_REASONS = Object.freeze(["rate_limit", "quota_exceeded", "unknown"] as const);
export type QuotaRefusalReason = (typeof QUOTA_REFUSAL_REASONS)[number];

export function isQuotaRefusalReason(value: unknown): value is QuotaRefusalReason {
  return typeof value === "string" && (QUOTA_REFUSAL_REASONS as readonly string[]).includes(value);
}

export interface ProviderQuotaRefusal {
  readonly providerId: string;
  readonly quotaPool: string;
  readonly reason: QuotaRefusalReason;
  /** When the provider refused, ISO-8601. */
  readonly observedAt: string;
  /** Always `native`: this is the provider's own statement about its own limit. */
  readonly evidence: "native";
  /**
   * The provider's machine-readable reset time, when it gave one — never a parsed phrase.
   *
   * `null` is the honest value for the refusal we actually measured, whose only reset information
   * was localized prose. There is no decay and no inferred timestamp anywhere in this record.
   */
  readonly resetAt: string | null;
  /** What the provider said, verbatim and bounded. Debug evidence, never interpreted. */
  readonly detail: string;
}

/**
 * A provider call that failed because the provider refused it on quota.
 *
 * Carried on the thrown error rather than inferred later from prose: the failover must only act on a
 * positively recognised, structured refusal, so the recognition happens where the output is still in
 * hand and travels with the failure.
 */
export class ProviderQuotaRefusalError extends BrainGateInvariantError {
  readonly quotaRefusal: ProviderQuotaRefusal;

  constructor(code: string, message: string, quotaRefusal: ProviderQuotaRefusal) {
    super(code, message);
    this.name = "ProviderQuotaRefusalError";
    this.quotaRefusal = quotaRefusal;
  }
}

/** The refusal carried by an error, if it carries one. Structural, so it survives bundling. */
export function quotaRefusalOf(error: unknown): ProviderQuotaRefusal | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = (error as { readonly quotaRefusal?: unknown }).quotaRefusal;
  if (typeof candidate !== "object" || candidate === null) return null;
  const refusal = candidate as Partial<ProviderQuotaRefusal>;
  if (refusal.evidence !== "native") return null;
  if (typeof refusal.providerId !== "string" || typeof refusal.quotaPool !== "string") return null;
  if (!isQuotaRefusalReason(refusal.reason)) return null;
  if (typeof refusal.observedAt !== "string") return null;
  return refusal as ProviderQuotaRefusal;
}
