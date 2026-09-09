import type { ProviderSnapshot } from "@braingate/providers";
import { loadShareFrom, POOL_LOAD_METRIC, POOL_SPEND_METRIC, type QuotaSnapshot, type QuotaStatus } from "@braingate/observability";
import { ModelRegistry, type ModelDefinition, type ModelRuntime, type QuotaState } from "@braingate/router";
import type { ModelCatalogEntry } from "./model-catalog.js";

const STATUS_RANK: Readonly<Record<QuotaStatus, number>> = Object.freeze({ healthy: 0, unknown: 1, limited: 2, exhausted: 3 });

export interface HydratedModelRuntime {
  readonly providerId: string;
  readonly modelId: string;
  readonly available: boolean;
  readonly quotaState: QuotaState;
  readonly quotaPressure: number | null;
  readonly observedAt: string;
  readonly providerAvailableEvidence: string;
  readonly quotaEvidence: readonly string[];
}

function latestObserved(provider: ProviderSnapshot | undefined, quota: readonly QuotaSnapshot[], fallback: string): string {
  const timestamps = [provider?.available.observedAt, provider?.version.observedAt, ...quota.map((item) => item.observedAt)].filter((value): value is string => value !== undefined);
  return timestamps.sort().at(-1) ?? fallback;
}

function quotaFor(definition: ModelDefinition, snapshots: readonly QuotaSnapshot[]): { state: QuotaState; pressure: number | null; evidence: readonly string[]; rows: readonly QuotaSnapshot[] } {
  const rows = snapshots.filter((item) => item.provider === definition.providerId && item.quotaPool === definition.quotaPool);
  if (rows.length === 0) return { state: "unknown", pressure: null, evidence: Object.freeze(["unknown"]), rows: Object.freeze([]) };
  // Status is about the pool being usable. A locally-measured load share says nothing about
  // that, so it must not be able to turn a healthy pool into a limited one.
  let status: QuotaStatus = "healthy";
  for (const row of rows) {
    if (row.metric === POOL_LOAD_METRIC || row.metric === POOL_SPEND_METRIC) continue;
    if (STATUS_RANK[row.status] > STATUS_RANK[status]) status = row.status;
  }
  // A provider that reports a real remaining balance outranks BrainGate's account of its own
  // traffic. The local signal is a fallback, never an override: it says which pool has been
  // carrying the work, not how close any of them is to a limit nobody publishes.
  const pressureRow = [...rows].reverse().find((row) => row.metric === "pressure" && row.unit === "ratio" && row.value !== null && row.value >= 0 && row.value <= 1 && row.evidence !== "unknown");
  const localLoad = pressureRow === undefined ? loadShareFrom(snapshots, definition.providerId, definition.quotaPool) : null;
  return {
    state: status,
    pressure: pressureRow?.value ?? localLoad,
    evidence: Object.freeze([...new Set(rows.map((row) => row.evidence))].sort()),
    rows: Object.freeze(rows),
  };
}

export function hydrateModelRegistry(input: {
  readonly entries: readonly ModelCatalogEntry[];
  readonly providers: readonly ProviderSnapshot[];
  readonly quota: readonly QuotaSnapshot[];
  readonly observedAt?: string;
}): { readonly registry: ModelRegistry; readonly runtimes: readonly HydratedModelRuntime[] } {
  const registry = new ModelRegistry();
  const runtimes: HydratedModelRuntime[] = [];
  const fallback = input.observedAt ?? new Date().toISOString();
  for (const entry of input.entries) {
    if (!entry.configured) continue;
    const provider = input.providers.find((candidate) => candidate.providerId === entry.providerId);
    const quota = quotaFor(entry.definition, input.quota);
    const runtime: ModelRuntime = {
      available: provider?.available.value === true,
      quotaState: quota.state,
      quotaPressure: quota.pressure,
      observedAt: latestObserved(provider, quota.rows, fallback),
    };
    registry.register(entry.definition, runtime);
    runtimes.push(Object.freeze({
      providerId: entry.providerId,
      modelId: entry.modelId,
      available: runtime.available,
      quotaState: runtime.quotaState,
      quotaPressure: runtime.quotaPressure,
      observedAt: runtime.observedAt,
      providerAvailableEvidence: provider?.available.evidence ?? "unknown",
      quotaEvidence: quota.evidence,
    }));
  }
  runtimes.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
  return Object.freeze({ registry, runtimes: Object.freeze(runtimes) });
}
