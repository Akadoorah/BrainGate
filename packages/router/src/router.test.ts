import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError, budgetFor, classifyTask } from "@braingate/core";
import { CapabilityRouter, ModelRegistry, type ModelDefinition, type ModelRuntime } from "./index.js";

const runtime = (quotaState: ModelRuntime["quotaState"], quotaPressure: number | null = null): ModelRuntime => ({ available: true, quotaState, quotaPressure, observedAt: "2026-09-07T00:00:00Z" });
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
