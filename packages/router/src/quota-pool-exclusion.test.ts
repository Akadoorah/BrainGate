/**
 * Excluding a refused quota pool, not a provider.
 *
 * The distinction matters in both directions: a provider may expose models through more than one
 * pool (so excluding the provider is too wide), and every model that shares the refused pool is
 * refused with it (so excluding only the model that happened to fail is too narrow).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { budgetFor, classifyTask } from "@braingate/core";
import { CapabilityRouter, ModelRegistry, type ModelRuntime } from "./index.js";

const runtime = (): ModelRuntime => ({ available: true, quotaState: "unknown", quotaHint: null, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-12T00:00:00.000Z" });

function registry(): ModelRegistry {
  const models = new ModelRegistry();
  // Two Anthropic models on one pool, and two other providers on their own.
  models.register({ providerId: "anthropic", modelId: "claude-haiku", quotaPool: "claude-subscription", capabilities: { planner: 60, coder: 70 }, speed: "fast", contextCapacity: 200_000, writeCapable: true, reasoning: 78, underlyingFamily: null }, runtime());
  models.register({ providerId: "anthropic", modelId: "claude-sonnet", quotaPool: "claude-subscription", capabilities: { planner: 80, coder: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 85, underlyingFamily: null }, runtime());
  models.register({ providerId: "google", modelId: "gemini-pro", quotaPool: "antigravity-subscription", capabilities: { planner: 88, coder: 60 }, speed: "deep", contextCapacity: 1_000_000, writeCapable: false, reasoning: 90, underlyingFamily: null }, runtime());
  models.register({ providerId: "xai", modelId: "grok", quotaPool: "grok-subscription", capabilities: { planner: 78, coder: 70 }, speed: "balanced", contextCapacity: 256_000, writeCapable: true, reasoning: 80, underlyingFamily: null }, runtime());
  return models;
}

function route(excludeQuotaPools?: readonly string[]) {
  const classification = classifyTask({ text: "Audit the retry and queue modules across the whole repository for correctness", mode: "ask" });
  return new CapabilityRouter(registry()).route({
    role: "planner",
    classification: { ...classification, complexity: "T2", risk: "low" },
    budget: budgetFor({ ...classification, complexity: "T2", risk: "low" }, { writeRequested: false }),
    requiredContextTokens: 1_000,
    writeRequired: false,
    ...(excludeQuotaPools === undefined ? {} : { excludeQuotaPools }),
  });
}

test("without exclusions the router may pick either pool", () => {
  const selected = route();
  assert.ok(["claude-subscription", "antigravity-subscription", "grok-subscription"].includes(selected.selected.model.definition.quotaPool));
});

test("every model sharing a refused pool is rejected, with the pool named", () => {
  const result = route(["claude-subscription"]);
  const rejectedPools = result.rejected.map((r) => r.model.quotaPool);
  assert.ok(rejectedPools.includes("claude-subscription"));
  const reasonForAnthropic = result.rejected.filter((r) => r.model.providerId === "anthropic").flatMap((r) => r.reasons);
  assert.ok(reasonForAnthropic.every((reason) => reason === "quota-pool-excluded:claude-subscription"), `expected only the pool reason, got ${reasonForAnthropic.join(", ")}`);
  // Both Anthropic models are out, not just the one that was refused.
  assert.equal(result.rejected.filter((r) => r.model.providerId === "anthropic").length, 2);
});

test("the next candidate comes from another pool, chosen by the router", () => {
  const result = route(["claude-subscription"]);
  assert.notEqual(result.selected.model.definition.quotaPool, "claude-subscription");
  assert.equal(result.selected.model.definition.providerId, "google", "the strongest remaining planner, decided by score rather than by order");
  assert.ok(result.fallbacks.every((candidate) => candidate.model.definition.quotaPool !== "claude-subscription"));
});

test("excluding a pool the task has no model on changes nothing", () => {
  const baseline = route();
  const withUnrelated = route(["some-other-pool"]);
  assert.equal(withUnrelated.selected.model.definition.modelId, baseline.selected.model.definition.modelId);
  assert.equal(withUnrelated.rejected.length, baseline.rejected.length);
});

test("a pool can be excluded even when the provider has models on another one", () => {
  const classification = classifyTask({ text: "Where is the theme configuration read?", mode: "ask" });
  const models = new ModelRegistry();
  models.register({ providerId: "anthropic", modelId: "on-pool-a", quotaPool: "pool-a", capabilities: { coder: 90 }, speed: "fast", contextCapacity: 200_000, writeCapable: true, reasoning: 80, underlyingFamily: null }, runtime());
  models.register({ providerId: "anthropic", modelId: "on-pool-b", quotaPool: "pool-b", capabilities: { coder: 70 }, speed: "fast", contextCapacity: 200_000, writeCapable: true, reasoning: 70, underlyingFamily: null }, runtime());
  const result = new CapabilityRouter(models).route({
    role: "coder", classification, budget: budgetFor(classification, { writeRequested: false }),
    requiredContextTokens: 500, writeRequired: false, excludeQuotaPools: ["pool-a"],
  });
  assert.equal(result.selected.model.definition.modelId, "on-pool-b", "the provider stays usable through its other pool");
  assert.deepEqual(result.rejected.map((r) => r.reasons.join("+")), ["quota-pool-excluded:pool-a"]);
});
