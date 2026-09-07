import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError, budgetFor, classifyTask } from "@braingate/core";
import { CapabilityRouter, ModelRegistry, type ModelDefinition, type ModelRuntime } from "@braingate/router";
import { WorkflowEngine, type AgentInvoker, type AgentRequest, type AgentResponse } from "./index.js";

const runtime = (): ModelRuntime => ({ available: true, quotaState: "healthy", quotaPressure: 0.1, observedAt: "2026-09-07T00:00:00Z" });
const def = (providerId: string, modelId: string, values: Partial<ModelDefinition> = {}): ModelDefinition => ({ providerId, modelId, quotaPool: `${providerId}:pool`, capabilities: { coder: 95, reviewer: 95, judge: 95 }, speed: "deep", contextCapacity: 200_000, writeCapable: true, reasoning: 95, underlyingFamily: null, ...values });

class ScriptedInvoker implements AgentInvoker {
  readonly calls: AgentRequest[] = [];
  readonly #responses: AgentResponse[];
  constructor(responses: AgentResponse[]) { this.#responses = [...responses]; }
  async invoke(request: AgentRequest): Promise<AgentResponse> {
    this.calls.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("No scripted response");
    return response;
  }
}

function registry(providers: string[]): ModelRegistry {
  const result = new ModelRegistry();
  for (const provider of providers) result.register(def(provider, `${provider}-model`), runtime());
  return result;
}

function singleProviderRegistry(): ModelRegistry {
  const result = new ModelRegistry();
  result.register(def("anthropic", "fast", { speed: "fast", capabilities: { coder: 82, reviewer: 76, judge: 70 }, reasoning: 74 }), runtime());
  result.register(def("anthropic", "strong", { speed: "deep", capabilities: { coder: 96, reviewer: 94, judge: 92 }, reasoning: 96 }), runtime());
  return result;
}

function input(text: string, mode: "ask" | "write", optionalReview = false) {
  const classification = classifyTask({ text, mode });
  return { task: text, classification, budget: budgetFor(classification, { writeRequested: mode === "write" }), requiredContextTokens: 10_000, writeRequired: mode === "write", optionalReview };
}

test("T0/T1 workflow uses one primary and never creates review or council", async () => {
  const invoker = new ScriptedInvoker([{ kind: "work", output: "answer" }]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry(["a", "b", "c"])), invoker);
  const receipt = await engine.run(input("where is the logo?", "ask"));
  assert.equal(receipt.outcome, "completed_without_review");
  assert.equal(invoker.calls.length, 1);
  assert.equal(invoker.calls[0]?.candidateOutput, null);
  assert.equal(receipt.reviewIndependence.level, "none");
  assert.equal(receipt.budget.councilRounds, 0);
});

test("T3 high-risk prefers cross-provider reviewer and gives it the primary candidate", async () => {
  const invoker = new ScriptedInvoker([{ kind: "work", output: "patch" }, { kind: "review", verdict: "approve", findings: [] }]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry(["anthropic", "openai"])), invoker);
  const receipt = await engine.run(input("fix auth login bug", "write"));
  assert.equal(receipt.outcome, "approved");
  assert.notEqual(receipt.primary.model.definition.providerId, receipt.reviewer?.model.definition.providerId);
  assert.equal(receipt.reviewIndependence.level, "cross-provider");
  assert.equal(invoker.calls[0]?.candidateOutput, null);
  assert.equal(invoker.calls[1]?.candidateOutput, "patch");
});

test("T3 high-risk can use a different model from the same provider in a fresh review invocation", async () => {
  const invoker = new ScriptedInvoker([{ kind: "work", output: "patch" }, { kind: "review", verdict: "approve", findings: [] }]);
  const engine = new WorkflowEngine(new CapabilityRouter(singleProviderRegistry()), invoker);
  const receipt = await engine.run(input("fix auth login bug", "write"));
  assert.equal(receipt.outcome, "approved");
  assert.equal(receipt.primary.model.definition.providerId, "anthropic");
  assert.equal(receipt.reviewer?.model.definition.providerId, "anthropic");
  assert.notEqual(receipt.primary.model.definition.modelId, receipt.reviewer?.model.definition.modelId);
  assert.equal(receipt.reviewIndependence.level, "same-provider-different-model");
  assert.equal(receipt.reviewIndependence.sharedQuotaPool, true);
  assert.equal(invoker.calls.length, 2);
});

test("T3 repair is bounded and receives the prior candidate plus reviewer findings", async () => {
  const invoker = new ScriptedInvoker([
    { kind: "work", output: "v1" },
    { kind: "review", verdict: "request_changes", findings: ["Fix race condition", "x".repeat(5_000)] },
    { kind: "work", output: "v2" },
  ]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry(["anthropic", "openai"])), invoker);
  const receipt = await engine.run(input("fix auth race condition", "write"));
  assert.equal(receipt.outcome, "repaired_needs_review");
  assert.equal(receipt.budget.repairRounds, 1);
  assert.equal(invoker.calls[1]?.candidateOutput, "v1");
  assert.equal(invoker.calls[2]?.candidateOutput, "v1");
  assert.equal(invoker.calls[2]?.findings.length, 2);
  assert.ok((invoker.calls[2]?.findings[1]?.length ?? 0) <= 1_000);
});

test("T4 disagreement gives judge the current candidate and invokes at most one judge", async () => {
  const invoker = new ScriptedInvoker([
    { kind: "work", output: "architecture" },
    { kind: "review", verdict: "disagree", findings: ["schema tradeoff"] },
    { kind: "judge", verdict: "approve", rationale: "primary is safer", findings: [] },
  ]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry(["anthropic", "openai", "google"])), invoker);
  const receipt = await engine.run(input("redesign architecture for multi-tenant database migration", "write"));
  assert.equal(receipt.outcome, "approved_by_judge");
  assert.equal(receipt.budget.councilRounds, 1);
  assert.equal(invoker.calls.filter((call) => call.role === "judge").length, 1);
  assert.equal(invoker.calls.find((call) => call.role === "judge")?.candidateOutput, "architecture");
  const judgeProvider = receipt.judge?.model.definition.providerId;
  assert.ok(judgeProvider !== receipt.primary.model.definition.providerId && judgeProvider !== receipt.reviewer?.model.definition.providerId);
});

test("critical workflow still fails closed when cross-provider review is unavailable", async () => {
  const invoker = new ScriptedInvoker([{ kind: "work", output: "patch" }]);
  const engine = new WorkflowEngine(new CapabilityRouter(singleProviderRegistry()), invoker);
  const critical = input("delete production payment database migration credentials security", "write");
  assert.equal(critical.classification.risk, "critical");
  await assert.rejects(() => engine.run(critical), (e: unknown) => e instanceof BrainGateInvariantError && e.code === "ROUTE_NO_ELIGIBLE_MODEL");
});

test("T2 optional review remains off unless explicitly requested", async () => {
  const invoker = new ScriptedInvoker([{ kind: "work", output: "small patch" }]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry(["a", "b"])), invoker);
  const receipt = await engine.run(input("implement feature button", "write", false));
  assert.equal(receipt.outcome, "completed_without_review");
  assert.equal(invoker.calls.length, 1);
});
