import test from "node:test";
import assert from "node:assert/strict";
import { budgetFor, classifyTask } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, ModelRegistry } from "@braingate/router";
import { buildWriteTaskPlan } from "./write-runner.js";

function observation<T>(value: T) { return { value, evidence: "native" as const, sourceCommand: null, observedAt: "2026-09-07T00:00:00.000Z" }; }

function anthropicSnapshot(): ProviderSnapshot {
  return {
    providerId: "anthropic",
    displayName: "Claude Code",
    binary: "claude",
    available: observation(true),
    version: observation("2.1.248"),
    authState: observation("authenticated"),
    authMode: observation("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt: "2026-09-07T00:00:00.000Z" },
    capabilities: observation({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt: "2026-09-07T00:00:00.000Z" },
    removedBillingOverrides: [],
    warnings: [],
  };
}

function router(): CapabilityRouter {
  const registry = new ModelRegistry();
  const runtime = { available: true, quotaState: "healthy" as const, quotaPressure: 0.1, observedAt: "2026-09-07T00:00:00.000Z" };
  registry.register({
    providerId: "anthropic", modelId: "strong", quotaPool: "anthropic-subscription",
    capabilities: { coder: 96, reviewer: 96, judge: 94 }, speed: "deep", contextCapacity: 200_000,
    writeCapable: true, reasoning: 96, underlyingFamily: null,
  }, runtime);
  registry.register({
    providerId: "anthropic", modelId: "reviewer", quotaPool: "anthropic-subscription",
    capabilities: { coder: 72, reviewer: 80, judge: 72 }, speed: "balanced", contextCapacity: 200_000,
    writeCapable: true, reasoning: 80, underlyingFamily: null,
  }, runtime);
  return new CapabilityRouter(registry);
}

test("real write plan uses another Anthropic model for review when cross-provider review is unavailable", () => {
  const classification = classifyTask({ text: "change the button label", mode: "write" });
  const budget = budgetFor(classification, { writeRequested: true });
  const plan = buildWriteTaskPlan({
    router: router(),
    providers: [anthropicSnapshot()],
    classification,
    budget,
    requiredContextTokens: 500,
    repositoryPath: "/repo",
    baseRef: "HEAD",
    review: true,
  });
  const primary = plan.roles.find((role) => role.role === "primary")!;
  const reviewer = plan.roles.find((role) => role.role === "reviewer")!;
  assert.equal(primary.model.providerId, "anthropic");
  assert.equal(reviewer.model.providerId, "anthropic");
  assert.notEqual(primary.model.modelId, reviewer.model.modelId);
  assert.equal(primary.model.quotaPool, reviewer.model.quotaPool);
  assert.equal(reviewer.workspace, "project-read-only");
});

test("real write plan can fall back to the same model in a fresh invocation when it is the only reviewer", () => {
  const registry = new ModelRegistry();
  registry.register({
    providerId: "anthropic", modelId: "only", quotaPool: "anthropic-subscription",
    capabilities: { coder: 96, reviewer: 96, judge: 90 }, speed: "deep", contextCapacity: 200_000,
    writeCapable: true, reasoning: 96, underlyingFamily: null,
  }, { available: true, quotaState: "healthy", quotaPressure: 0.1, observedAt: "2026-09-07T00:00:00.000Z" });
  const classification = classifyTask({ text: "change the button label", mode: "write" });
  const plan = buildWriteTaskPlan({
    router: new CapabilityRouter(registry), providers: [anthropicSnapshot()], classification,
    budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 500,
    repositoryPath: "/repo", baseRef: "HEAD", review: true,
  });
  assert.equal(plan.roles[0]?.model.modelId, "only");
  assert.equal(plan.roles[1]?.model.modelId, "only");
});
