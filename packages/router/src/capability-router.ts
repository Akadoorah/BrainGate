import { BrainGateInvariantError, type TaskComplexity } from "@braingate/core";
import type { IndependenceLevel, ModelRef, RegisteredModel, RouteCandidate, RouteRejection, RouteRequest, RouteResult, SpeedClass } from "./types.js";
import { ModelRegistry } from "./model-registry.js";

const MIN_CAPABILITY: Readonly<Record<TaskComplexity, number>> = Object.freeze({ T0: 25, T1: 35, T2: 55, T3: 72, T4: 84 });
/**
 * At T0/T1 the capability floor has already answered "can this model do it". What remains is
 * which qualifying model to spend, and the answer is the cheapest one — that is the whole
 * premise of routing across subscriptions rather than always asking the strongest.
 *
 * The gap used to be ten points while marginal capability and reasoning were worth about
 * twelve, so a stronger model won a lookup by roughly two points: the preference existed but
 * decided nothing. It is now wide enough to be the deciding term, and still finite, so a model
 * that only barely clears the floor does not beat a far better one on speed alone.
 */
const SPEED_BONUS_LOW: Readonly<Record<SpeedClass, number>> = Object.freeze({ fast: 45, balanced: 18, deep: 0 });
const SPEED_BONUS_HIGH: Readonly<Record<SpeedClass, number>> = Object.freeze({ fast: 0, balanced: 6, deep: 12 });
const QUOTA_PENALTY = Object.freeze({ healthy: 0, limited: 30, unknown: 14, exhausted: Number.POSITIVE_INFINITY });

function ref(model: RegisteredModel): ModelRef {
  return Object.freeze({ providerId: model.definition.providerId, modelId: model.definition.modelId, quotaPool: model.definition.quotaPool });
}

function sameProvider(a: ModelRef, b: ModelRef): boolean { return a.providerId === b.providerId; }
function sameModel(a: ModelRef, b: ModelRef): boolean { return a.providerId === b.providerId && a.modelId === b.modelId; }
function sameQuotaPool(a: ModelRef, b: ModelRef): boolean { return a.quotaPool === b.quotaPool; }

function violatesIndependence(candidate: ModelRef, other: ModelRef, level: IndependenceLevel): boolean {
  if (level === "cross-provider") return sameProvider(candidate, other) || sameQuotaPool(candidate, other);
  if (level === "different-model") return sameModel(candidate, other);
  return false;
}

function independencePenalty(candidate: ModelRef, others: readonly ModelRef[]): { penalty: number; reason: string | null } {
  if (others.some((other) => sameModel(candidate, other))) return { penalty: 70, reason: "same-model-fresh-session-penalty" };
  if (others.some((other) => sameProvider(candidate, other))) return { penalty: 38, reason: "same-provider-different-model-penalty" };
  if (others.some((other) => sameQuotaPool(candidate, other))) return { penalty: 20, reason: "shared-quota-pool-penalty" };
  return { penalty: 0, reason: null };
}

function capabilityFloor(request: RouteRequest): number {
  let floor = MIN_CAPABILITY[request.classification.complexity];
  if (request.classification.risk === "high") floor = Math.max(floor, 72);
  if (request.classification.risk === "critical") floor = Math.max(floor, 84);
  if (request.role === "judge") floor = Math.max(floor, 80);
  return floor;
}

export function routeCapabilityFloor(complexity: TaskComplexity): number { return MIN_CAPABILITY[complexity]; }

export class CapabilityRouter {
  readonly #registry: ModelRegistry;

  constructor(registry: ModelRegistry) {
    this.#registry = registry;
  }

  route(request: RouteRequest): RouteResult {
    if (!Number.isInteger(request.requiredContextTokens) || request.requiredContextTokens < 0) {
      throw new BrainGateInvariantError("ROUTE_CONTEXT_INVALID", "requiredContextTokens must be a non-negative integer.");
    }
    const maxFallbacks = Math.max(0, Math.min(3, Math.floor(request.maxFallbacks ?? 2)));
    const floor = capabilityFloor(request);
    const excluded = new Set(request.excludeProviders ?? []);
    const accepted: RouteCandidate[] = [];
    const rejected: RouteRejection[] = [];
    const independenceLevel = request.independence?.level ?? "cross-provider";

    for (const model of this.#registry.list()) {
      const reasons: string[] = [];
      const definition = model.definition;
      const runtime = model.runtime;
      const modelRef = ref(model);
      const capability = definition.capabilities[request.role] ?? 0;

      if (excluded.has(definition.providerId)) reasons.push("provider-excluded");
      if (!runtime.available) reasons.push("runtime-unavailable");
      if (runtime.quotaState === "exhausted") reasons.push("quota-exhausted");
      if (capability < floor) reasons.push(`capability-below-floor:${capability}<${floor}`);
      if (definition.contextCapacity < request.requiredContextTokens) reasons.push("context-capacity-too-small");
      if (request.writeRequired && !definition.writeCapable) reasons.push("write-not-supported");
      if (request.independence?.mode === "required" && request.independence.models.some((other) => violatesIndependence(modelRef, other, independenceLevel))) {
        reasons.push(`independence-required:${independenceLevel}`);
      }

      if (reasons.length > 0) {
        rejected.push(Object.freeze({ model: modelRef, reasons: Object.freeze(reasons) }));
        continue;
      }

      const scoreReasons: string[] = [`capability:${capability}`, `reasoning:${definition.reasoning}`, `quota:${runtime.quotaState}`];
      const lowComplexity = request.classification.complexity === "T0" || request.classification.complexity === "T1";
      const effectiveCapability = lowComplexity ? floor + (capability - floor) * 0.25 : capability;
      let score = effectiveCapability * 2 + definition.reasoning * (lowComplexity ? 0.30 : 0.45);
      score += lowComplexity ? SPEED_BONUS_LOW[definition.speed] : SPEED_BONUS_HIGH[definition.speed];
      score -= QUOTA_PENALTY[runtime.quotaState];
      if (runtime.quotaPressure !== null) {
        score -= runtime.quotaPressure * 28;
        scoreReasons.push(`quota-pressure:${runtime.quotaPressure.toFixed(2)}`);
      }
      if (request.independence?.mode === "preferred") {
        const penalty = independencePenalty(modelRef, request.independence.models);
        score -= penalty.penalty;
        if (penalty.reason !== null) scoreReasons.push(penalty.reason);
      }
      if (request.classification.risk === "critical" && definition.speed === "deep") score += 8;
      accepted.push(Object.freeze({ model, score: Math.round(score * 100) / 100, reasons: Object.freeze(scoreReasons) }));
    }

    accepted.sort((a, b) =>
      b.score - a.score ||
      a.model.definition.providerId.localeCompare(b.model.definition.providerId) ||
      a.model.definition.modelId.localeCompare(b.model.definition.modelId),
    );
    rejected.sort((a, b) => a.model.providerId.localeCompare(b.model.providerId) || a.model.modelId.localeCompare(b.model.modelId));

    const selected = accepted[0];
    if (selected === undefined) {
      throw new BrainGateInvariantError("ROUTE_NO_ELIGIBLE_MODEL", `No eligible model for role ${request.role} at ${request.classification.complexity}/${request.classification.risk}.`);
    }

    return Object.freeze({
      role: request.role,
      selected,
      fallbacks: Object.freeze(accepted.slice(1, 1 + maxFallbacks)),
      rejected: Object.freeze(rejected),
      rationale: Object.freeze([
        `role:${request.role}`,
        `complexity:${request.classification.complexity}`,
        `risk:${request.classification.risk}`,
        `capability-floor:${floor}`,
        `selected:${selected.model.definition.providerId}/${selected.model.definition.modelId}`,
      ]),
    });
  }
}
