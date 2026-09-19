import type { TaskComplexity } from "@braingate/core";
import { routeCapabilityFloor, type ModelDefinition, type ModelRole, type SpeedClass } from "@braingate/router";
import type { ModelCatalogEntry } from "./model-catalog.js";

export interface ProviderModelProfile {
  readonly providerId: string;
  readonly models: readonly string[];
  readonly quotaPools: readonly string[];
  readonly speeds: readonly SpeedClass[];
  readonly roles: Readonly<Record<ModelRole, number>>;
  readonly maxCoder: number;
  readonly maxReviewer: number;
  /**
   * The models still on BrainGate's starting scores, which the operator has not touched.
   *
   * Reported rather than inferred from the numbers, because a default and a deliberate choice can
   * be the same number. The operator is the one who decides what a model is good at (ADR 0021),
   * and this is the list of places where nobody has decided yet.
   */
  readonly defaultScored: readonly string[];
}

export interface ModelCoverageProfile {
  readonly configuredModels: number;
  readonly providers: readonly ProviderModelProfile[];
  readonly singleProviderMode: boolean;
  readonly coverage: Readonly<Record<TaskComplexity, boolean>>;
  readonly reviewerIndependence: "cross-provider" | "same-provider-different-model" | "same-model-fresh-session" | "unavailable";
  readonly warnings: readonly string[];
}

const COMPLEXITY: readonly TaskComplexity[] = ["T0", "T1", "T2", "T3", "T4"];
const ROLES: readonly ModelRole[] = ["scout", "planner", "coder", "reviewer", "judge", "visual"];
const SPEEDS: readonly SpeedClass[] = ["fast", "balanced", "deep"];

function configured(entries: readonly ModelCatalogEntry[]): readonly ModelDefinition[] {
  return entries.filter((entry): entry is Extract<ModelCatalogEntry, { configured: true }> => entry.configured).map((entry) => entry.definition);
}

export function analyzeModelCoverage(entries: readonly ModelCatalogEntry[]): ModelCoverageProfile {
  const definitions = configured(entries);
  const defaultScored = new Set(
    entries
      .filter((entry): entry is Extract<ModelCatalogEntry, { configured: true }> => entry.configured)
      .filter((entry) => entry.source !== undefined && entry.source !== "operator")
      .map((entry) => `${entry.providerId}\u0000${entry.modelId}`),
  );
  const byProvider = new Map<string, ModelDefinition[]>();
  for (const definition of definitions) {
    const current = byProvider.get(definition.providerId) ?? [];
    current.push(definition);
    byProvider.set(definition.providerId, current);
  }

  const providers = [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([providerId, models]) => {
    const roles = Object.fromEntries(ROLES.map((role) => [role, models.filter((model) => (model.capabilities[role] ?? 0) > 0).length])) as Record<ModelRole, number>;
    return Object.freeze({
      providerId,
      models: Object.freeze(models.map((model) => model.modelId).sort()),
      quotaPools: Object.freeze([...new Set(models.map((model) => model.quotaPool))].sort()),
      speeds: Object.freeze(SPEEDS.filter((speed) => models.some((model) => model.speed === speed))),
      roles: Object.freeze(roles),
      maxCoder: Math.max(0, ...models.map((model) => model.capabilities.coder ?? 0)),
      maxReviewer: Math.max(0, ...models.map((model) => model.capabilities.reviewer ?? 0)),
      defaultScored: Object.freeze(models.map((model) => model.modelId).filter((modelId) => defaultScored.has(`${providerId}\u0000${modelId}`)).sort()),
    } satisfies ProviderModelProfile);
  });

  const coverage = Object.fromEntries(COMPLEXITY.map((level) => [
    level,
    definitions.some((definition) => (definition.capabilities.coder ?? 0) >= routeCapabilityFloor(level)),
  ])) as Record<TaskComplexity, boolean>;

  const reviewerProviders = providers.filter((provider) => provider.maxReviewer > 0);
  let reviewerIndependence: ModelCoverageProfile["reviewerIndependence"] = "unavailable";
  if (reviewerProviders.length >= 2) reviewerIndependence = "cross-provider";
  else if (reviewerProviders.some((provider) => provider.roles.reviewer >= 2)) reviewerIndependence = "same-provider-different-model";
  else if (reviewerProviders.length === 1) reviewerIndependence = "same-model-fresh-session";

  const warnings: string[] = [];
  if (definitions.length === 0) warnings.push("No configured model definitions are available.");
  if (providers.length === 1) warnings.push("Single-provider mode: reviewer independence is weaker than cross-provider review.");
  for (const provider of providers) {
    if (provider.quotaPools.length > 1) warnings.push(`${provider.providerId} declares multiple quota pools; keep them separate only if provider telemetry proves they are independently limited.`);
  }
  if (!coverage.T4) warnings.push("No configured coding model reaches the T4 capability floor.");
  const stillDefault = providers.flatMap((provider) => provider.defaultScored.map((modelId) => `${provider.providerId}/${modelId}`));
  if (stillDefault.length > 0) {
    warnings.push(`${stillDefault.length} model(s) still carry BrainGate's starting scores rather than yours: ${stillDefault.join(", ")}. Change any of them with \`braingate models add --definition <file>\`.`);
  }
  if (reviewerIndependence === "unavailable") warnings.push("No reviewer-capable model is configured.");

  return Object.freeze({
    configuredModels: definitions.length,
    providers: Object.freeze(providers),
    singleProviderMode: providers.length === 1,
    coverage: Object.freeze(coverage),
    reviewerIndependence,
    warnings: Object.freeze(warnings),
  });
}
