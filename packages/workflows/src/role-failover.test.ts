/**
 * Same-task failover on a structured quota refusal — and only on one.
 *
 * Every case here is deterministic: the invoker is scripted, so "the provider refused" is a fact the
 * test states rather than one it hopes for. What the failover must never do is the other half of the
 * contract, and most of these tests are about that half.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError, ProviderQuotaRefusalError, budgetFor, classifyTask, type ProviderQuotaRefusal } from "@braingate/core";
import { CapabilityRouter, ModelRegistry, type ModelDefinition, type ModelRuntime, type RouteRequest } from "@braingate/router";
import { WorkflowEngine, type AgentInvoker, type AgentRequest, type AgentResponse } from "./index.js";

const runtime = (): ModelRuntime => ({ available: true, quotaState: "unknown", quotaHint: null, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-12T00:00:00Z" });
const def = (providerId: string, modelId: string, quotaPool: string, values: Partial<ModelDefinition> = {}): ModelDefinition => ({
  providerId, modelId, quotaPool, capabilities: { planner: 90, coder: 90, reviewer: 90, judge: 90 }, speed: "deep", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null, ...values,
});

/** Three providers on three pools: the real shape of "Anthropic won, and there is somewhere else to go". */
function registry(): ModelRegistry {
  const models = new ModelRegistry();
  models.register(def("anthropic", "claude-planner", "claude-subscription", { capabilities: { planner: 97, coder: 90, reviewer: 84, judge: 94 }, reasoning: 98 }), runtime());
  models.register(def("google", "gemini-planner", "antigravity-subscription", { capabilities: { planner: 88, coder: 60, reviewer: 82, judge: 80 }, reasoning: 90 }), runtime());
  models.register(def("xai", "grok-planner", "grok-subscription", { capabilities: { planner: 78, coder: 70, reviewer: 80, judge: 76 }, reasoning: 80 }), runtime());
  // A provider that can *execute*: without one, excluding the refused pool leaves the primary with
  // nowhere to go — which is its own test below, and the honest shape of the real read path today.
  models.register(def("openai", "gpt-executor", "openai-subscription", { capabilities: { planner: 85, coder: 95, reviewer: 93, judge: 89 }, reasoning: 94 }), runtime());
  return models;
}

function refusal(pool = "claude-subscription", providerId = "anthropic"): ProviderQuotaRefusal {
  return Object.freeze({
    providerId, quotaPool: pool, reason: "rate_limit" as const, observedAt: "2026-09-12T00:24:33.000Z",
    evidence: "native" as const, resetAt: null, detail: "You've hit your session limit · resets 4:10am (Europe/Istanbul)",
  });
}

/** Scripted responses, with failures expressed as the errors the invoker actually throws. */
class ScriptedInvoker implements AgentInvoker {
  readonly calls: AgentRequest[] = [];
  readonly #responses: (AgentResponse | Error)[];
  constructor(responses: (AgentResponse | Error)[]) { this.#responses = [...responses]; }
  async invoke(request: AgentRequest): Promise<AgentResponse> {
    this.calls.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("No scripted response");
    if (response instanceof Error) throw response;
    return response;
  }
}

const refused = (pool = "claude-subscription", providerId = "anthropic") => new ProviderQuotaRefusalError("SHADOW_PROVIDER_FAILED", "the provider refused", refusal(pool, providerId));
const genericFailure = () => new BrainGateInvariantError("SHADOW_PROVIDER_FAILED", "exit 1 with no quota statement");
const timeout = () => Object.assign(new Error("timed out"), { code: "SHADOW_PROVIDER_FAILED" });

function input(text: string, options: { readonly mode?: "ask" | "write"; readonly optionalReview?: boolean } = {}) {
  const mode = options.mode ?? "write";
  const classification = classifyTask({ text, mode });
  return { task: text, classification, budget: budgetFor(classification, { writeRequested: mode === "write" }), requiredContextTokens: 10_000, writeRequired: mode === "write", optionalReview: options.optionalReview ?? false };
}

const PLANNING_TASK = "Audit the authentication session storage across the whole application";

test("a refused planner is re-routed to another provider and the workflow continues", async () => {
  const invoker = new ScriptedInvoker([
    refused(),                                              // planner on anthropic/claude-subscription
    { kind: "work", output: "the approach" },               // planner failover
    { kind: "work", output: "the answer" },                 // primary, re-routed off the refused pool
    { kind: "review", verdict: "approve", findings: [] },   // reviewer
  ]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry()), invoker);
  const receipt = await engine.run(input(PLANNING_TASK));

  // The original planner was Anthropic, and the failover went to another provider's pool.
  assert.equal(invoker.calls[0]!.model.providerId, "anthropic");
  assert.equal(invoker.calls[1]!.model.quotaPool, "antigravity-subscription");
  assert.equal(invoker.calls.length, 4, "planning, the failed-over plan, the primary and the review");
  // The receipt names the models that actually ran, and the record shows the failover.
  assert.equal(receipt.planner?.model.definition.modelId, "gemini-planner");
  const kinds = receipt.events.map((event) => event.kind);
  assert.deepEqual(kinds.filter((kind) => kind.startsWith("role.failover.")), ["role.failover.started", "role.failover.selected", "role.failover.completed"]);
  assert.equal(receipt.outcome, "approved");
  // The primary was routed before the refusal was known, so it is routed again rather than dispatched
  // into a pool this task already knows refuses it.
  assert.notEqual(invoker.calls[2]!.model.quotaPool, "claude-subscription");
  assert.equal(invoker.calls[2]!.model.providerId, "openai");
  assert.equal(receipt.primary.model.definition.providerId, "openai");
});

test("models sharing the refused pool are never retried", async () => {
  // The engine's registry holds two Anthropic models on one pool; a refusal must exclude both.
  const models = registry();
  models.register(def("anthropic", "claude-other", "claude-subscription", { capabilities: { planner: 95, coder: 90, reviewer: 84, judge: 94 }, reasoning: 95 }), runtime());
  const invoker = new ScriptedInvoker([
    refused(),
    { kind: "work", output: "the approach" },
    { kind: "work", output: "the answer" },
    { kind: "review", verdict: "approve", findings: [] },
  ]);
  const engine = new WorkflowEngine(new CapabilityRouter(models), invoker);
  await engine.run(input(PLANNING_TASK));
  const attempted = invoker.calls.map((call) => `${call.model.providerId}/${call.model.modelId}:${call.model.quotaPool}`);
  assert.ok(attempted.every((entry) => !entry.startsWith("anthropic/claude-other")), "a same-pool sibling must not be tried");
  assert.equal(invoker.calls[1]!.model.quotaPool, "antigravity-subscription");
});

test("the primary is never dispatched to a pool this task has already been refused by", async () => {
  // Only Anthropic can execute here, so once its pool is refused the primary has nowhere to go. The
  // honest outcome is two calls — the refused plan and the plan that replaced it — and a failure that
  // says exactly why, rather than a third call into a pool that just said no.
  const models = new ModelRegistry();
  models.register(def("anthropic", "claude-planner", "claude-subscription", { capabilities: { planner: 97, coder: 95, reviewer: 84, judge: 94 }, reasoning: 98 }), runtime());
  models.register(def("google", "gemini-planner", "antigravity-subscription", { capabilities: { planner: 88, coder: 60, reviewer: 82, judge: 80 }, reasoning: 90 }), runtime());
  const invoker = new ScriptedInvoker([refused(), { kind: "work", output: "the approach" }]);
  const engine = new WorkflowEngine(new CapabilityRouter(models), invoker);
  const error = await engine.run(input(PLANNING_TASK)).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof BrainGateInvariantError);
  assert.equal(error.code, "ROLE_NO_ELIGIBLE_FALLBACK");
  assert.match(error.message, /claude-subscription/);
  assert.equal(invoker.calls.length, 2, "the refused plan and its replacement, and nothing sent to the refused pool");
  assert.ok(invoker.calls.every((call) => call.model.quotaPool !== "claude-subscription" || call === invoker.calls[0]), "no second call to the refused pool");
});

test("the re-route asks the router to exclude the refused pool", async () => {
  const seen: RouteRequest[] = [];
  const models = registry();
  class RecordingRouter extends CapabilityRouter {
    override route(request: RouteRequest) {
      seen.push(request);
      return super.route(request);
    }
  }
  const invoker = new ScriptedInvoker([refused(), { kind: "work", output: "approach" }, { kind: "work", output: "answer" }, { kind: "review", verdict: "approve", findings: [] }]);
  await new WorkflowEngine(new RecordingRouter(models), invoker).run(input(PLANNING_TASK));
  const plannerRequests = seen.filter((request) => request.role === "planner");
  assert.equal(plannerRequests[0]!.excludeQuotaPools, undefined, "the first attempt routes normally");
  assert.deepEqual(plannerRequests[1]!.excludeQuotaPools, ["claude-subscription"], "the second excludes the pool the provider refused");
  // And the exclusion carries into the roles that are routed after it, including the primary, which
  // is routed again because its first routing predates what the task learned.
  const primaryRequests = seen.filter((request) => request.role === "coder");
  assert.deepEqual(primaryRequests[0]!.excludeQuotaPools, undefined);
  assert.deepEqual(primaryRequests.at(-1)!.excludeQuotaPools, ["claude-subscription"]);
  const reviewerRequest = seen.find((request) => request.role === "reviewer")!;
  assert.deepEqual(reviewerRequest.excludeQuotaPools, ["claude-subscription"]);
});

test("a generic provider failure does not fail over", async () => {
  const invoker = new ScriptedInvoker([genericFailure()]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry()), invoker);
  await assert.rejects(() => engine.run(input(PLANNING_TASK)), /exit 1 with no quota statement/);
  assert.equal(invoker.calls.length, 1, "one attempt, then the failure stands");
});

test("a timeout does not fail over", async () => {
  const invoker = new ScriptedInvoker([Object.assign(new BrainGateInvariantError("SHADOW_TIMEOUT", "the provider timed out"), { quotaRefusal: undefined })]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry()), invoker);
  await assert.rejects(() => engine.run(input(PLANNING_TASK)), /timed out/);
  assert.equal(invoker.calls.length, 1);
});

test("one failover per role: a second refusal ends the role", async () => {
  const invoker = new ScriptedInvoker([
    refused(),                                            // planner, anthropic
    refused("antigravity-subscription", "google"),        // planner failover, google refuses too
  ]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry()), invoker);
  await assert.rejects(() => engine.run(input(PLANNING_TASK)));
  assert.equal(invoker.calls.length, 2, "the failover ran once; the second refusal is terminal for that role");
});

test("a refused call gives its reservation back, and a failover that then answers is counted once", async () => {
  // The old rule counted a refusal as a call made, so one call in the budget meant no second
  // subscription — the real Arabic dogfood run failed a T1 read on a rate-limited Claude with three
  // other subscriptions idle. A refusal at the door spends nothing; the failover limit, not the
  // call budget, is what bounds re-routing.
  const classification = { ...classifyTask({ text: PLANNING_TASK, mode: "write" }), complexity: "T3" as const, risk: "high" as const };
  const invoker = new ScriptedInvoker([refused(), { kind: "work", output: "approach" }, { kind: "work", output: "answer" }, { kind: "review", verdict: "approve", findings: [] }]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry()), invoker);
  const receipt = await engine.run({ task: PLANNING_TASK, classification, budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 10_000, writeRequired: true, optionalReview: false });
  assert.equal(invoker.calls.length, 4, "the refused planner, its failover, the primary and the review");
  assert.equal(receipt.budget.providerCalls, 3, "three calls were made; the refusal was not one of them");
  assert.equal(receipt.outcome, "approved");
});

test("the failover call is counted against the budget like any other, and the refused one is not", async () => {
  const classification = classifyTask({ text: PLANNING_TASK, mode: "write" });
  const invoker = new ScriptedInvoker([refused(), { kind: "work", output: "approach" }, { kind: "work", output: "answer" }, { kind: "review", verdict: "approve", findings: [] }]);
  const receipt = await new WorkflowEngine(new CapabilityRouter(registry()), invoker).run({ task: PLANNING_TASK, classification, budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 10_000, writeRequired: true, optionalReview: false });
  assert.equal(receipt.budget.providerCalls, invoker.calls.length - 1, "the failover attempt is spend; the refusal that caused it is not");
  assert.ok(receipt.budget.providerCalls <= budgetFor(classification, { writeRequested: true }).maxProviderCalls);
});

test("no eligible fallback produces a truthful terminal failure naming the pool", async () => {
  // Only Anthropic can execute here, so excluding its pool leaves the primary with nowhere to go.
  const models = new ModelRegistry();
  models.register(def("anthropic", "claude-only", "claude-subscription", { capabilities: { planner: 97, coder: 95, reviewer: 90, judge: 94 } }), runtime());
  const invoker = new ScriptedInvoker([refused()]);
  const engine = new WorkflowEngine(new CapabilityRouter(models), invoker);
  const classification = { ...classifyTask({ text: "Where is the theme configuration read?", mode: "ask" }), complexity: "T2" as const, risk: "low" as const };
  const error = await engine.run({ task: "look something up", classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 1_000, writeRequired: false, optionalReview: false }).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof BrainGateInvariantError);
  assert.equal(error.code, "ROLE_NO_ELIGIBLE_FALLBACK");
  assert.match(error.message, /claude-subscription/, "the refusal names the pool it excluded");
  assert.match(error.message, /no other eligible model remains/);
  assert.equal(invoker.calls.length, 1, "nothing was dispatched to look for a fallback that does not exist");
});

test("a refused reviewer is re-routed across providers while keeping independence", async () => {
  // The refusal names the pool the *reviewer* was actually on, which is the only honest fixture: a
  // provider refuses its own pool, and the failover has to exclude that one.
  const invoker = new RefusingInvoker({ refuseRole: "reviewer", responses: [
    { kind: "work", output: "the approach" },               // planner
    { kind: "work", output: "the answer" },                 // primary
    { kind: "review", verdict: "approve", findings: [] },   // reviewer, after the failover
  ] });
  const engine = new WorkflowEngine(new CapabilityRouter(registry()), invoker);
  // The budget is an input, and a second reviewer is what a failover costs: a tier that grants one
  // reviewer cannot buy a second, which is asserted on its own below.
  const classification = { ...classifyTask({ text: PLANNING_TASK, mode: "write" }), complexity: "T3" as const, risk: "high" as const };
  const receipt = await engine.run({ task: PLANNING_TASK, classification, budget: { ...budgetFor(classification, { writeRequested: true }), maxReviewers: 2 }, requiredContextTokens: 10_000, writeRequired: true, optionalReview: false });

  const reviewerAttempts = invoker.calls.filter((call) => call.role === "reviewer");
  assert.equal(reviewerAttempts.length, 2, "the reviewer was refused and then re-routed");
  assert.equal(invoker.refusedPool, reviewerAttempts[0]!.model.quotaPool);
  assert.notEqual(reviewerAttempts[1]!.model.quotaPool, reviewerAttempts[0]!.model.quotaPool, "the second reviewer is not on the refused pool");
  assert.notEqual(reviewerAttempts[1]!.model.providerId, invoker.calls[0]!.model.providerId, "and it still comes from another provider than the executor");
  assert.equal(receipt.reviewer?.model.definition.providerId, reviewerAttempts[1]!.model.providerId);
  assert.equal(receipt.outcome, "approved");
});

/** Fails one role with the refusal that role's own provider would give, then serves the rest. */
class RefusingInvoker implements AgentInvoker {
  readonly calls: AgentRequest[] = [];
  readonly #responses: AgentResponse[];
  readonly #refuseRole: string;
  refusedPool: string | null = null;
  constructor(options: { readonly refuseRole: string; readonly responses: AgentResponse[] }) {
    this.#refuseRole = options.refuseRole;
    this.#responses = [...options.responses];
  }
  async invoke(request: AgentRequest): Promise<AgentResponse> {
    this.calls.push(request);
    if (request.role === this.#refuseRole && this.refusedPool === null) {
      this.refusedPool = request.model.quotaPool;
      throw new ProviderQuotaRefusalError("SHADOW_PROVIDER_FAILED", "the provider refused", refusal(request.model.quotaPool, request.model.providerId));
    }
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("No scripted response");
    return response;
  }
}

test("a refused reviewer is re-routed, because its refusal returned the reviewer reservation", async () => {
  // T3/medium grants a single reviewer. The refused reviewer reviewed nothing, so the one reviewer
  // the budget grants is still available to the pool the failover picks — and the task's review is
  // a real one rather than a refusal reported as the task's failure.
  const invoker = new RefusingInvoker({ refuseRole: "reviewer", responses: [{ kind: "work", output: "the approach" }, { kind: "work", output: "the answer" }, { kind: "review", verdict: "approve", findings: [] }] });
  const engine = new WorkflowEngine(new CapabilityRouter(registry()), invoker);
  const receipt = await engine.run(input(PLANNING_TASK));
  const reviews = invoker.calls.filter((call) => call.role === "reviewer");
  assert.equal(reviews.length, 2, "the refused review and the one that ran");
  assert.notEqual(reviews[1]!.model.quotaPool, invoker.refusedPool, "on a different pool");
  assert.equal(receipt.outcome, "approved");
  assert.equal(receipt.budget.reviewers, 1, "one reviewer reservation was spent, as the budget grants");
});

test("a run with no refusal is byte-for-byte the routing it always was", async () => {
  const invoker = new ScriptedInvoker([{ kind: "work", output: "answer" }, { kind: "review", verdict: "approve", findings: [] }]);
  const engine = new WorkflowEngine(new CapabilityRouter(registry()), invoker);
  const classification = { ...classifyTask({ text: "Fix the off-by-one in the retry counter and keep the existing tests passing", mode: "write" }), complexity: "T2" as const, risk: "medium" as const };
  const receipt = await engine.run({ task: "fix a small bug", classification, budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 5_000, writeRequired: true, optionalReview: true });
  assert.equal(receipt.outcome, "approved");
  assert.equal(invoker.calls.length, 2, "no extra calls");
  assert.deepEqual(receipt.events.filter((event) => event.kind.startsWith("role.failover.")), [], "no failover events");
  // The selection is the same one the router makes with no exclusions at all.
  const expected = new CapabilityRouter(registry()).route({ role: "coder", classification, budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 5_000, writeRequired: true }).selected;
  assert.equal(receipt.primary.model.definition.modelId, expected.model.definition.modelId);
});

test("a small task with one call in its budget still reaches a second subscription when the first refuses on quota", async () => {
  // Found by the real Arabic dogfood run: Claude was rate-limited, the T1 budget allowed one provider
  // call, the refusal was counted as that call, and the task failed with three other subscriptions
  // idle. A refusal at the door spends nothing, so it must not spend the budget either.
  const request = input("What is the build identifier recorded in SERVICE.md?", { mode: "ask" });
  assert.equal(request.budget.maxProviderCalls, 1, "the premise: one call in the budget");
  // Whichever pool the router picks first refuses; the answer comes from the next one.
  const invoker = new RefusingInvoker({ refuseRole: "primary", responses: [{ kind: "work", output: "the answer" }] });
  const engine = new WorkflowEngine(new CapabilityRouter(registry()), invoker);
  const receipt = await engine.run(request);
  assert.equal(invoker.calls.length, 2, "the refused call and the one that answered");
  assert.equal(invoker.calls[0]!.model.quotaPool, invoker.refusedPool);
  assert.notEqual(invoker.calls[1]!.model.quotaPool, invoker.refusedPool, "the second subscription was tried");
  assert.equal(receipt.finalOutput, "the answer");
  const kinds = receipt.events.map((event) => event.kind);
  assert.deepEqual(kinds.filter((kind) => kind.startsWith("role.failover.")), ["role.failover.started", "role.failover.selected", "role.failover.completed"]);
  assert.equal(receipt.budget.providerCalls, 1, "and the record counts the call that was made, not the one that was refused");
});
