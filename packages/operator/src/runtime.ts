import type { ProviderSnapshot } from "@braingate/providers";
import { loadShareFrom, POOL_PRESSURE_METRIC, WINDOW_UTILIZATION_METRIC, type QuotaSnapshot } from "@braingate/observability";
import { ModelRegistry, type ModelDefinition, type ModelRuntime, type QuotaState } from "@braingate/router";
import type { ModelCatalogEntry } from "./model-catalog.js";

export interface HydratedModelRuntime {
  readonly providerId: string;
  readonly modelId: string;
  readonly available: boolean;
  readonly quotaState: QuotaState;
  /** The last full-window reading, 0–1, with the moment it was taken. A hint, not a level. */
  readonly quotaHint: number | null;
  readonly quotaObservedAt: string | null;
  readonly observedAt: string;
  readonly providerAvailableEvidence: string;
  readonly quotaEvidence: readonly string[];
}

function latestObserved(provider: ProviderSnapshot | undefined, quota: readonly QuotaSnapshot[], fallback: string): string {
  const timestamps = [provider?.available.observedAt, provider?.version.observedAt, ...quota.map((item) => item.observedAt)].filter((value): value is string => value !== undefined);
  return timestamps.sort().at(-1) ?? fallback;
}

/**
 * What the store knows about a pool, and what it only believes.
 *
 * Two questions are answered separately:
 *
 * - **Is this pool usable?** Only a provider's own statement answers that, so only a row with
 *   `native` evidence can set the state. BrainGate's own arithmetic used to be stored as a status
 *   and read back as one, which is how a locally observed 47% utilisation became a reason to skip a
 *   provider the operator had already paid for.
 * - **How full did its window look?** That is a number somebody saw, kept together with the moment
 *   they saw it, and it stops describing the pool when its own window resets. It is exposed as a
 *   hint and it never decays by arithmetic: a decay rate BrainGate invented would be a reading it
 *   never took, dressed up with a timestamp.
 */
function quotaFor(definition: ModelDefinition, snapshots: readonly QuotaSnapshot[], now: number): { state: QuotaState; hint: number | null; observedAt: string | null; evidence: readonly string[]; rows: readonly QuotaSnapshot[] } {
  const rows = snapshots.filter((item) => item.provider === definition.providerId && item.quotaPool === definition.quotaPool);
  if (rows.length === 0) return { state: "unknown", hint: null, observedAt: null, evidence: Object.freeze(["unknown"]), rows: Object.freeze([]) };
  // A reading is about a window, and a window that has reset is over. The row stays in the store
  // as history; it stops being a statement about now.
  const current = rows.filter((row) => row.resetAt === null || Date.parse(row.resetAt) > now);
  // One thing, and only one thing, may answer "is this pool usable?": a refusal the provider itself
  // stated, in a window that has not reset. `healthy` and `limited` are labels this code coined from
  // its own traffic — "it served this call" — and a real validation run showed a thirty-three-hour-old
  // one still being reported as current availability. Those rows stay in the append-only store as
  // history, and they still contribute the utilization hint below, but they no longer set a state.
  const state: QuotaState = current.some((row) => row.evidence === "native" && row.status === "exhausted") ? "exhausted" : "unknown";
  // The fullest window is the interesting one, because it is the one that will bind first — not the
  // most recent, which may be a five-minute window that has barely been touched. `pressure` is still
  // read so rows written before this metric had a name keep their meaning.
  const hintRows = current.filter((row) => (row.metric === WINDOW_UTILIZATION_METRIC || row.metric === POOL_PRESSURE_METRIC) && row.unit === "ratio" && row.value !== null && row.value >= 0 && row.value <= 1 && row.evidence !== "unknown");
  const hintRow = hintRows.reduce<QuotaSnapshot | null>((fullest, row) => (fullest === null || (row.value ?? 0) > (fullest.value ?? 0) ? row : fullest), null);
  const localLoad = hintRow === null ? loadShareFrom(snapshots, definition.providerId, definition.quotaPool) : null;
  return {
    state,
    hint: hintRow?.value ?? localLoad,
    observedAt: hintRow?.observedAt ?? null,
    evidence: Object.freeze([...new Set(rows.map((row) => row.evidence))].sort()),
    rows: Object.freeze(rows),
  };
}

export function hydrateModelRegistry(input: {
  readonly entries: readonly ModelCatalogEntry[];
  readonly providers: readonly ProviderSnapshot[];
  readonly quota: readonly QuotaSnapshot[];
  readonly observedAt?: string;
  /** Injectable so a caller can ask what was true at a given moment, and so tests are not clocks. */
  readonly now?: number;
}): { readonly registry: ModelRegistry; readonly runtimes: readonly HydratedModelRuntime[] } {
  const registry = new ModelRegistry();
  const runtimes: HydratedModelRuntime[] = [];
  const fallback = input.observedAt ?? new Date().toISOString();
  const now = input.now ?? Date.now();
  for (const entry of input.entries) {
    if (!entry.configured) continue;
    const provider = input.providers.find((candidate) => candidate.providerId === entry.providerId);
    const quota = quotaFor(entry.definition, input.quota, now);
    const runtime: ModelRuntime = {
      available: provider?.available.value === true,
      quotaState: quota.state,
      quotaHint: quota.hint,
      quotaObservedAt: quota.observedAt,
      observedAt: latestObserved(provider, quota.rows, fallback),
    };
    registry.register(entry.definition, runtime);
    runtimes.push(Object.freeze({
      providerId: entry.providerId,
      modelId: entry.modelId,
      available: runtime.available,
      quotaState: runtime.quotaState,
      quotaHint: runtime.quotaHint,
      quotaObservedAt: runtime.quotaObservedAt,
      observedAt: runtime.observedAt,
      providerAvailableEvidence: provider?.available.evidence ?? "unknown",
      quotaEvidence: quota.evidence,
    }));
  }
  runtimes.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
  return Object.freeze({ registry, runtimes: Object.freeze(runtimes) });
}
