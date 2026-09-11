import { BrainGateInvariantError } from "@braingate/core";
import type { ModelDefinition, ModelRole, ModelRuntime, RegisteredModel } from "./types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,191}$/;
const ROLES: readonly ModelRole[] = ["scout", "planner", "coder", "reviewer", "judge", "visual"];

function validateDefinition(input: ModelDefinition): ModelDefinition {
  if (!ID.test(input.providerId)) throw new BrainGateInvariantError("MODEL_PROVIDER_INVALID", "Invalid providerId.");
  if (!ID.test(input.modelId)) throw new BrainGateInvariantError("MODEL_ID_INVALID", "Invalid provider-owned modelId.");
  if (!ID.test(input.quotaPool)) throw new BrainGateInvariantError("MODEL_QUOTA_POOL_INVALID", "Invalid quotaPool.");
  if (!Number.isInteger(input.contextCapacity) || input.contextCapacity < 1_000 || input.contextCapacity > 10_000_000) {
    throw new BrainGateInvariantError("MODEL_CONTEXT_INVALID", "contextCapacity must be an integer between 1000 and 10000000.");
  }
  if (!Number.isFinite(input.reasoning) || input.reasoning < 0 || input.reasoning > 100) {
    throw new BrainGateInvariantError("MODEL_REASONING_INVALID", "reasoning must be between 0 and 100.");
  }
  for (const role of ROLES) {
    const score = input.capabilities[role];
    if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 100)) {
      throw new BrainGateInvariantError("MODEL_CAPABILITY_INVALID", `Capability ${role} must be between 0 and 100.`);
    }
  }
  return Object.freeze({ ...input, capabilities: Object.freeze({ ...input.capabilities }) });
}

function validateRuntime(input: ModelRuntime): ModelRuntime {
  if (input.quotaHint !== null && (!Number.isFinite(input.quotaHint) || input.quotaHint < 0 || input.quotaHint > 1)) {
    throw new BrainGateInvariantError("MODEL_QUOTA_HINT_INVALID", "quotaHint must be null or between 0 and 1.");
  }
  if (input.quotaObservedAt !== null && !Number.isFinite(Date.parse(input.quotaObservedAt))) {
    throw new BrainGateInvariantError("MODEL_RUNTIME_TIME_INVALID", "quotaObservedAt must be null or an ISO-compatible timestamp.");
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) throw new BrainGateInvariantError("MODEL_RUNTIME_TIME_INVALID", "observedAt must be an ISO-compatible timestamp.");
  return Object.freeze({ ...input });
}

function key(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

export class ModelRegistry {
  readonly #models = new Map<string, RegisteredModel>();

  register(definition: ModelDefinition, runtime: ModelRuntime): RegisteredModel {
    const safeDefinition = validateDefinition(definition);
    const safeRuntime = validateRuntime(runtime);
    const id = key(safeDefinition.providerId, safeDefinition.modelId);
    if (this.#models.has(id)) throw new BrainGateInvariantError("MODEL_DUPLICATE", `Model already registered: ${safeDefinition.providerId}/${safeDefinition.modelId}`);
    const registered = Object.freeze({ definition: safeDefinition, runtime: safeRuntime });
    this.#models.set(id, registered);
    return registered;
  }

  updateRuntime(providerId: string, modelId: string, runtime: ModelRuntime): RegisteredModel {
    const id = key(providerId, modelId);
    const current = this.#models.get(id);
    if (current === undefined) throw new BrainGateInvariantError("MODEL_NOT_FOUND", `Unknown model: ${providerId}/${modelId}`);
    const next = Object.freeze({ definition: current.definition, runtime: validateRuntime(runtime) });
    this.#models.set(id, next);
    return next;
  }

  get(providerId: string, modelId: string): RegisteredModel | undefined {
    return this.#models.get(key(providerId, modelId));
  }

  list(): readonly RegisteredModel[] {
    return Object.freeze([...this.#models.values()].sort((a, b) =>
      a.definition.providerId.localeCompare(b.definition.providerId) || a.definition.modelId.localeCompare(b.definition.modelId),
    ));
  }
}
