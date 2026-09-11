import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError, budgetFor, classifyTask } from "@braingate/core";
import { CapabilityRouter, ModelRegistry, type ModelDefinition, type ModelRuntime } from "@braingate/router";
import { WorkflowEngine, type AgentInvoker, type AgentRequest, type AgentResponse } from "./index.js";

const runtime = (): ModelRuntime => ({ available: true, quotaState: "healthy", quotaHint: 0.1, quotaObservedAt: null, observedAt: "2026-09-07T00:00:00Z" });
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

/** A registry shaped like the operator's goal: a strong planner, a cheaper executor. */
function plannerAndCoder(): ModelRegistry {
  const registry = new ModelRegistry();
  registry.register(
    { providerId: "anthropic", modelId: "strong-planner", quotaPool: "claude-subscription", capabilities: { planner: 97, coder: 60 }, speed: "deep", contextCapacity: 1_000_000, writeCapable: true, reasoning: 98, underlyingFamily: null },
    runtime(),
  );
  registry.register(
    { providerId: "anthropic", modelId: "cheap-coder", quotaPool: "claude-subscription", capabilities: { coder: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 85, underlyingFamily: null },
    runtime(),
  );
  return registry;
}

// The whole point of routing across a shared quota: deciding how to build something rewards the
// strongest model available, typing it out afterwards does not.
test("complex work is planned by one model and carried out by another", async () => {
  const seen: { role: string; modelId: string; candidate: string | null }[] = [];
  const invoker: AgentInvoker = {
    invoke: async (request) => {
      seen.push({ role: request.role, modelId: request.model.modelId, candidate: request.candidateOutput ?? null });
      return { kind: "work", output: request.role === "planner" ? "STEP 1: change the label" : "done" };
    },
  };
  const classification = classifyTask({ text: "Audit how payment webhooks are verified and whether replay attacks are prevented", mode: "ask" });
  const budget = { ...budgetFor(classification, { writeRequested: false }), reviewerPolicy: "none" as const };
  await new WorkflowEngine(new CapabilityRouter(plannerAndCoder()), invoker).run({
    task: "Audit how payment webhooks are verified", classification, budget, requiredContextTokens: 500, writeRequired: false, optionalReview: false,
  });

  assert.deepEqual(seen.map((entry) => entry.role), ["planner", "primary"]);
  assert.equal(seen[0]!.modelId, "strong-planner", "planning must go to the model that declares it");
  assert.equal(seen[1]!.modelId, "cheap-coder", "execution must not inherit the planner");
  // The plan reaches the executor as something to work from, not as a suggestion it may ignore.
  assert.equal(seen[1]!.candidate, "STEP 1: change the label");
});

test("a small task is not planned separately, because a plan for it decides nothing", async () => {
  const roles: string[] = [];
  const invoker: AgentInvoker = {
    invoke: async (request) => { roles.push(request.role); return { kind: "work", output: "ok" }; },
  };
  const classification = classifyTask({ text: "What Node version does this need?", mode: "ask" });
  await new WorkflowEngine(new CapabilityRouter(plannerAndCoder()), invoker).run({
    task: "What Node version does this need?", classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 200, writeRequired: false, optionalReview: false,
  });
  assert.deepEqual(roles, ["primary"], "a lookup must not spend a provider call on planning");
});

test("with no model declaring a planner capability the task still runs", async () => {
  const roles: string[] = [];
  const invoker: AgentInvoker = {
    invoke: async (request) => { roles.push(request.role); return { kind: "work", output: "ok" }; },
  };
  // Only a coder is configured, which is every existing installation before this change.
  const registry = new ModelRegistry();
  registry.register(
    { providerId: "anthropic", modelId: "coder-only", quotaPool: "pool", capabilities: { coder: 95 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null },
    runtime(),
  );
  const classification = classifyTask({ text: "Audit how payment webhooks are verified", mode: "ask" });
  const budget = { ...budgetFor(classification, { writeRequested: false }), reviewerPolicy: "none" as const };
  await new WorkflowEngine(new CapabilityRouter(registry), invoker).run({
    task: "Audit how payment webhooks are verified", classification, budget, requiredContextTokens: 500, writeRequired: false, optionalReview: false,
  });
  assert.deepEqual(roles, ["primary"], "planning is a routing preference, not a requirement");
});

// "who planned, who wrote, who reviewed" is the question the receipt exists to answer, and the
// planner was missing from it while every other role was there.
test("the receipt names the planner, so attribution is complete", async () => {
  const invoker: AgentInvoker = { invoke: async (request) => ({ kind: "work", output: `${request.role} output` }) };
  const classification = classifyTask({ text: "Audit how payment webhooks are verified and whether replay attacks are prevented", mode: "ask" });
  const budget = { ...budgetFor(classification, { writeRequested: false }), reviewerPolicy: "none" as const };
  const receipt = await new WorkflowEngine(new CapabilityRouter(plannerAndCoder()), invoker).run({
    task: "Audit the webhooks", classification, budget, requiredContextTokens: 500, writeRequired: false, optionalReview: false,
  });
  assert.equal(receipt.planner?.model.definition.modelId, "strong-planner");
  assert.equal(receipt.primary.model.definition.modelId, "cheap-coder");
});

test("a task with no planning pass records no planner rather than a wrong one", async () => {
  const invoker: AgentInvoker = { invoke: async () => ({ kind: "work", output: "ok" }) };
  const classification = classifyTask({ text: "What Node version does this need?", mode: "ask" });
  const receipt = await new WorkflowEngine(new CapabilityRouter(plannerAndCoder()), invoker).run({
    task: "What Node version does this need?", classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 200, writeRequired: false, optionalReview: false,
  });
  assert.equal(receipt.planner, null);
});

/** Two planner-capable providers that do not share a pool, so a second approach is reachable. */
function plannerRegistry(): ModelRegistry {
  const result = new ModelRegistry();
  result.register(def("anthropic", "opus", { capabilities: { planner: 96, coder: 92, reviewer: 90, judge: 90 } }), runtime());
  result.register(def("xai", "grok", { capabilities: { planner: 90, reviewer: 88, judge: 86 }, writeCapable: false }), runtime());
  result.register(def("openai", "codex", { capabilities: { planner: 88, reviewer: 94, judge: 92 }, writeCapable: false }), runtime());
  return result;
}

function critical(text: string) {
  const classification = classifyTask({ text, mode: "write" });
  const budget = budgetFor(classification, { writeRequested: true });
  return { task: text, classification, budget, requiredContextTokens: 10_000, writeRequired: true, optionalReview: false };
}

test("a budget that allows two planners spends two subscriptions on the approach, at once", async () => {
  const invoker = new ScriptedInvoker([
    { kind: "work", output: "approach from the first" },
    { kind: "work", output: "approach from the second" },
    { kind: "work", output: "patch" },
    { kind: "review", verdict: "approve", findings: [] },
  ]);
  const engine = new WorkflowEngine(new CapabilityRouter(plannerRegistry()), invoker);
  const task = critical("Redesign the authentication and payment migration for the production database");
  assert.ok(task.budget.maxPlanners > 1, "this tier must actually permit a second approach");

  const receipt = await engine.run(task);

  const planners = invoker.calls.filter((call) => call.role === "planner");
  assert.equal(planners.length, 2);
  assert.notEqual(planners[0]!.model.providerId, planners[1]!.model.providerId, "a second opinion from the same pool is not a second opinion");
  assert.ok(receipt.planner !== null && receipt.secondPlanner !== null, "the receipt must name both");

  // The executor is handed both, labelled, with reconciling them stated as part of the work.
  const executor = invoker.calls.find((call) => call.role === "primary");
  assert.match(executor!.candidateOutput!, /approach from the first/);
  assert.match(executor!.candidateOutput!, /approach from the second/);
  assert.match(executor!.candidateOutput!, /Where they differ/);
  assert.ok(receipt.events.some((event) => event.kind === "planner.parallel"));
  // Two agents at once is the whole point; one after the other would just cost twice.
  assert.equal(receipt.budget.peakConcurrentAgents, 2);
});

test("one planner-capable provider means one approach, not the same one twice", async () => {
  const registry = new ModelRegistry();
  registry.register(def("anthropic", "opus", { capabilities: { planner: 96, coder: 92, reviewer: 90, judge: 90 } }), runtime());
  registry.register(def("anthropic", "sonnet", { capabilities: { planner: 88, coder: 90, reviewer: 88, judge: 84 } }), runtime());
  // Reviews but does not plan, so critical work still gets its independent reviewer while the
  // approach has only one provider that could have decided it.
  registry.register(def("openai", "codex", { capabilities: { reviewer: 94, judge: 92 }, writeCapable: false }), runtime());
  const invoker = new ScriptedInvoker([
    { kind: "work", output: "the only approach" },
    { kind: "work", output: "patch" },
    { kind: "review", verdict: "approve", findings: [] },
  ]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry), invoker);
  const receipt = await engine.run(critical("Redesign the authentication and payment migration for the production database"));

  assert.equal(invoker.calls.filter((call) => call.role === "planner").length, 1);
  assert.equal(receipt.secondPlanner, null);
  assert.ok(receipt.events.some((event) => event.kind === "planner.single"));
  assert.equal(invoker.calls.find((call) => call.role === "primary")!.candidateOutput, "the only approach", "a single approach is passed through whole, not wrapped in a reconciliation brief");
});

test("a tier that did not ask for a second opinion never acquires one", async () => {
  const invoker = new ScriptedInvoker([{ kind: "work", output: "answer" }]);
  const engine = new WorkflowEngine(new CapabilityRouter(plannerRegistry()), invoker);
  const task = input("where is the logo?", "ask");
  assert.equal(task.budget.maxPlanners, 0);
  const receipt = await engine.run(task);
  assert.equal(invoker.calls.filter((call) => call.role === "planner").length, 0);
  assert.equal(receipt.planner, null);
  assert.equal(receipt.secondPlanner, null);
});
