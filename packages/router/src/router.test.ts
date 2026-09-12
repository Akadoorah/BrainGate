import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError, budgetFor, classifyTask } from "@braingate/core";
import { CapabilityRouter, ModelRegistry, type ModelDefinition, type ModelRuntime } from "./index.js";

const runtime = (quotaState: ModelRuntime["quotaState"], quotaHint: number | null = null): ModelRuntime => ({ available: true, quotaState, quotaHint, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-07T00:00:00Z" });
const model = (providerId: string, modelId: string, values: Partial<ModelDefinition> = {}): ModelDefinition => ({
  providerId, modelId, quotaPool: `${providerId}:subscription`,
  capabilities: { scout: 70, planner: 70, coder: 70, reviewer: 70, judge: 70 },
  speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 70, underlyingFamily: null,
  ...values,
});

function routeFor(registry: ModelRegistry, text: string, mode: "ask" | "write", role: "scout" | "coder" | "reviewer" = "coder") {
  const classification = classifyTask({ text, mode });
  return new CapabilityRouter(registry).route({ role, classification, budget: budgetFor(classification, { writeRequested: mode === "write" }), requiredContextTokens: 10_000, writeRequired: mode === "write" });
}

test("tiny tasks prefer a fast sufficient healthy model", () => {
  const registry = new ModelRegistry();
  registry.register(model("a", "deep", { speed: "deep", capabilities: { coder: 90 }, reasoning: 95 }), runtime("healthy"));
  registry.register(model("b", "fast", { speed: "fast", capabilities: { coder: 82 }, reasoning: 70 }), runtime("healthy"));
  const result = routeFor(registry, "where is the logo component?", "ask");
  assert.equal(result.selected.model.definition.modelId, "fast");
});

test("complex work rejects underpowered models", () => {
  const registry = new ModelRegistry();
  registry.register(model("a", "weak", { capabilities: { coder: 60 }, reasoning: 60 }), runtime("healthy"));
  registry.register(model("b", "strong", { capabilities: { coder: 94 }, reasoning: 94, speed: "deep" }), runtime("healthy"));
  const result = routeFor(registry, "redesign architecture for multi-tenant billing", "write");
  assert.equal(result.selected.model.definition.modelId, "strong");
  assert.ok(result.rejected.some((entry) => entry.model.modelId === "weak" && entry.reasons.some((reason) => reason.includes("capability-below"))));
});

test("quota health beats equivalent unknown/limited candidates and exhausted is excluded", () => {
  const registry = new ModelRegistry();
  for (const [id, state] of [["healthy", "healthy"], ["unknown", "unknown"], ["limited", "limited"], ["exhausted", "exhausted"]] as const) {
    registry.register(model(id, "same", { capabilities: { coder: 80 }, reasoning: 80 }), runtime(state));
  }
  const result = routeFor(registry, "implement feature endpoint", "write");
  assert.equal(result.selected.model.definition.providerId, "healthy");
  assert.ok(result.rejected.some((entry) => entry.model.providerId === "exhausted" && entry.reasons.includes("quota-exhausted")));
});

test("required reviewer independence treats Copilot as its own provider and quota pool", () => {
  const registry = new ModelRegistry();
  registry.register(model("anthropic", "primary", { quotaPool: "anthropic:max", capabilities: { reviewer: 92 }, underlyingFamily: "claude" }), runtime("healthy"));
  registry.register(model("github-copilot", "copilot-claude", { quotaPool: "github:copilot-credits", capabilities: { reviewer: 90 }, underlyingFamily: "claude" }), runtime("healthy"));
  const classification = classifyTask({ text: "review auth security change", mode: "review" });
  const result = new CapabilityRouter(registry).route({
    role: "reviewer", classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 5_000, writeRequired: false,
    independence: { mode: "required", models: [{ providerId: "anthropic", modelId: "worker", quotaPool: "anthropic:max" }] },
  });
  assert.equal(result.selected.model.definition.providerId, "github-copilot");
});

test("preferred independence falls back to a different model on the same provider", () => {
  const registry = new ModelRegistry();
  registry.register(model("anthropic", "primary", { quotaPool: "anthropic:max", capabilities: { reviewer: 96 }, reasoning: 96 }), runtime("healthy"));
  registry.register(model("anthropic", "reviewer", { quotaPool: "anthropic:max", capabilities: { reviewer: 88 }, reasoning: 88 }), runtime("healthy"));
  const classification = classifyTask({ text: "review feature implementation", mode: "review" });
  const result = new CapabilityRouter(registry).route({
    role: "reviewer", classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 5_000, writeRequired: false,
    independence: { mode: "preferred", level: "cross-provider", models: [{ providerId: "anthropic", modelId: "primary", quotaPool: "anthropic:max" }] },
  });
  assert.equal(result.selected.model.definition.modelId, "reviewer");
  assert.ok(result.selected.reasons.includes("same-provider-different-model-penalty"));
});

test("different-model requirement allows same provider but rejects the exact primary model", () => {
  const registry = new ModelRegistry();
  registry.register(model("anthropic", "primary", { quotaPool: "anthropic:max", capabilities: { reviewer: 96 } }), runtime("healthy"));
  registry.register(model("anthropic", "alternate", { quotaPool: "anthropic:max", capabilities: { reviewer: 86 } }), runtime("healthy"));
  const classification = classifyTask({ text: "review feature", mode: "review" });
  const result = new CapabilityRouter(registry).route({
    role: "reviewer", classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 1_000, writeRequired: false,
    independence: { mode: "required", level: "different-model", models: [{ providerId: "anthropic", modelId: "primary", quotaPool: "anthropic:max" }] },
  });
  assert.equal(result.selected.model.definition.modelId, "alternate");
  assert.ok(result.rejected.some((entry) => entry.model.modelId === "primary" && entry.reasons.includes("independence-required:different-model")));
});

test("routing is deterministic for identical inputs", () => {
  const registry = new ModelRegistry();
  registry.register(model("b", "same-b", { capabilities: { coder: 80 }, reasoning: 80 }), runtime("healthy"));
  registry.register(model("a", "same-a", { capabilities: { coder: 80 }, reasoning: 80 }), runtime("healthy"));
  const first = routeFor(registry, "implement feature", "write");
  const second = routeFor(registry, "implement feature", "write");
  assert.equal(first.selected.model.definition.providerId, "a");
  assert.equal(second.selected.model.definition.providerId, "a");
});

test("no eligible independent model fails closed", () => {
  const registry = new ModelRegistry();
  registry.register(model("anthropic", "only", { quotaPool: "anthropic:max", capabilities: { reviewer: 95 } }), runtime("healthy"));
  const classification = classifyTask({ text: "review payment authentication change", mode: "review" });
  assert.throws(() => new CapabilityRouter(registry).route({ role: "reviewer", classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 1_000, writeRequired: false, independence: { mode: "required", models: [{ providerId: "anthropic", modelId: "primary", quotaPool: "anthropic:max" }] } }), (e: unknown) => e instanceof BrainGateInvariantError && e.code === "ROUTE_NO_ELIGIBLE_MODEL");
});

// "visual" has been in ModelRole since the router was written, unreachable because nothing
// routed it (ADR 0007). Nothing had to change to make it fail closed — an absent capability
// scores zero, below every floor — but that is a property worth pinning rather than assuming.
test("a model without a visual capability cannot take a visual task", () => {
  const registry = new ModelRegistry();
  registry.register(
    { providerId: "anthropic", modelId: "text-only", quotaPool: "pool", capabilities: { coder: 95, reviewer: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null },
    runtime("healthy"),
  );
  const router = new CapabilityRouter(registry);
  const classification = classifyTask({ text: "produce a hero image", mode: "write" });
  const budget = budgetFor(classification, { writeRequested: true });

  assert.throws(
    () => router.route({ role: "visual", classification, budget, requiredContextTokens: 500, writeRequired: true }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "ROUTE_NO_ELIGIBLE_MODEL",
    "a text-only model must not be silently accepted for visual work",
  );

  // Declaring the capability makes the same model eligible; nothing else changed.
  registry.register(
    { providerId: "openai", modelId: "visual-capable", quotaPool: "pool-2", capabilities: { coder: 80, visual: 88 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 85, underlyingFamily: null },
    runtime("healthy"),
  );
  const routed = router.route({ role: "visual", classification, budget, requiredContextTokens: 500, writeRequired: true });
  assert.equal(routed.selected.model.definition.modelId, "visual-capable");
});

// "Route each task to the cheapest worker that can do it" is the premise of the project, and at
// low complexity the capability floor has already settled the "can do it" half. The preference
// for a fast model existed but was worth about ten points while marginal capability was worth
// twelve, so a stronger, slower model won a one-line lookup by roughly two points.
test("a lookup goes to the fastest model that clears the floor, not the strongest", () => {
  const registry = new ModelRegistry();
  const runtime = { available: true, quotaState: "healthy" as const, quotaHint: null, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-09T00:00:00Z" };
  registry.register({ providerId: "anthropic", modelId: "fast-model", quotaPool: "pool", capabilities: { coder: 70 }, speed: "fast", contextCapacity: 200_000, writeCapable: false, reasoning: 78, underlyingFamily: null }, runtime);
  registry.register({ providerId: "anthropic", modelId: "balanced-model", quotaPool: "pool", capabilities: { coder: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 85, underlyingFamily: null }, runtime);
  registry.register({ providerId: "anthropic", modelId: "deep-model", quotaPool: "pool", capabilities: { coder: 95 }, speed: "deep", contextCapacity: 200_000, writeCapable: false, reasoning: 98, underlyingFamily: null }, runtime);

  const route = (complexity: "T0" | "T1" | "T2" | "T3") => new CapabilityRouter(registry).route({
    role: "coder",
    classification: { complexity, risk: "low", confidence: 0.9, requiresScout: false, reasons: [], sensitiveDomains: [], ruleVersion: "test" },
    budget: budgetFor({ complexity, risk: "low", confidence: 0.9, requiresScout: false, reasons: [], sensitiveDomains: [], ruleVersion: "test" }, { writeRequested: false }),
    requiredContextTokens: 500,
    writeRequired: false,
  }).selected.model.definition.modelId;

  assert.equal(route("T0"), "fast-model");
  assert.equal(route("T1"), "fast-model");
  // Above the cheap tiers the preference inverts, because there the work is what costs, not the
  // waiting: a T2 change and a T3 audit get the model that is actually better at them.
  assert.equal(route("T2"), "deep-model");
  assert.equal(route("T3"), "deep-model");
});

test("speed does not outrank a model that cannot do the job at all", () => {
  const registry = new ModelRegistry();
  const runtime = { available: true, quotaState: "healthy" as const, quotaHint: null, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-09T00:00:00Z" };
  // Below the floor is not a preference, it is a rejection: being quick about the wrong answer
  // is not what "cheapest worker that can do it" means.
  registry.register({ providerId: "anthropic", modelId: "too-weak", quotaPool: "pool", capabilities: { coder: 10 }, speed: "fast", contextCapacity: 200_000, writeCapable: false, reasoning: 20, underlyingFamily: null }, runtime);
  registry.register({ providerId: "anthropic", modelId: "capable", quotaPool: "pool", capabilities: { coder: 80 }, speed: "deep", contextCapacity: 200_000, writeCapable: false, reasoning: 90, underlyingFamily: null }, runtime);

  const classification = { complexity: "T0" as const, risk: "low" as const, confidence: 0.9, requiresScout: false, reasons: [], sensitiveDomains: [], ruleVersion: "test" };
  const result = new CapabilityRouter(registry).route({
    role: "coder", classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 500, writeRequired: false,
  });
  assert.equal(result.selected.model.definition.modelId, "capable");
  assert.ok(result.rejected.some((entry) => entry.model.modelId === "too-weak" && entry.reasons.some((reason) => reason.startsWith("capability-below-floor"))));
});
