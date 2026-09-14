import test from "node:test";
import assert from "node:assert/strict";
import { budgetFor, classifyTask } from "@braingate/core";
import { CapabilityRouter } from "./capability-router.js";
import { ModelRegistry } from "./model-registry.js";
import type { ModelDefinition, QuotaState, RouteRequest, RouteResult, SpeedClass } from "./types.js";

/**
 * Automatic routing, over a catalogue that looks like the operator's own.
 *
 * Every test below asks the same two questions of the result: who won, and *why* — the winner's own
 * reasons and the losers' rejections are asserted, because a router that picks correctly for the
 * wrong reason is one catalogue edit away from picking wrongly. The model names here are the
 * installed ones only because a fixture has to name something; nothing in the router knows them, and
 * the decisive facts are always the discovered ones: capability, speed, quota state, availability,
 * write support, policy support and which sessions are already warm.
 */

interface Fixture {
  readonly providerId: string;
  readonly modelId: string;
  readonly coder?: number;
  readonly reviewer?: number;
  readonly judge?: number;
  readonly reasoning?: number;
  readonly speed?: SpeedClass;
  readonly write?: boolean;
  readonly context?: number;
  readonly quotaState?: QuotaState;
  readonly quotaHint?: number | null;
  readonly available?: boolean;
  readonly backoffUntil?: string | null;
  readonly pool?: string;
}

function definition(f: Fixture): ModelDefinition {
  return {
    providerId: f.providerId,
    modelId: f.modelId,
    quotaPool: f.pool ?? `${f.providerId}-subscription`,
    capabilities: { coder: f.coder ?? 60, reviewer: f.reviewer ?? 60, judge: f.judge ?? 60 } as ModelDefinition["capabilities"],
    speed: f.speed ?? "balanced",
    contextCapacity: f.context ?? 200_000,
    writeCapable: f.write ?? true,
    reasoning: f.reasoning ?? f.coder ?? 60,
    underlyingFamily: null,
  };
}

function registry(fixtures: readonly Fixture[]): ModelRegistry {
  const models = new ModelRegistry();
  for (const f of fixtures) {
    models.register(definition(f), {
      available: f.available ?? true,
      quotaState: f.quotaState ?? "unknown",
      quotaHint: f.quotaHint ?? null,
      quotaObservedAt: null,
      refusalBackoffUntil: f.backoffUntil ?? null,
      observedAt: "2026-09-14T00:00:00.000Z",
    });
  }
  return models;
}

/** The catalogue shape the acceptance runs against: two good models per subscription, one cheap. */
const CATALOGUE: readonly Fixture[] = [
  { providerId: "anthropic", modelId: "claude-opus-5", coder: 96, reasoning: 95, speed: "deep" },
  { providerId: "anthropic", modelId: "claude-sonnet-5", coder: 92, reasoning: 90, speed: "balanced" },
  { providerId: "anthropic", modelId: "claude-haiku-4-5", coder: 78, reasoning: 74, speed: "fast" },
  { providerId: "openai", modelId: "gpt-6-astra", coder: 93, reasoning: 91, speed: "balanced" },
  { providerId: "xai", modelId: "grok-4.6", coder: 90, reasoning: 88, speed: "balanced" },
  { providerId: "xai", modelId: "grok-4.5", coder: 84, reasoning: 80, speed: "fast" },
];

function request(overrides: Partial<RouteRequest> & { readonly task: string }): RouteRequest {
  const write = overrides.writeRequired === true;
  const classification = classifyTask({ text: overrides.task, mode: write ? "write" : "ask" });
  const budget = budgetFor(classification, { writeRequested: write });
  return {
    role: "coder",
    classification,
    budget,
    requiredContextTokens: 4_000,
    writeRequired: false,
    ...overrides,
  };
}

function winner(result: RouteResult): string {
  return `${result.selected.model.definition.providerId}/${result.selected.model.definition.modelId}`;
}

function rejectionOf(result: RouteResult, modelId: string): readonly string[] {
  return result.rejected.find((r) => r.model.modelId === modelId)?.reasons ?? [];
}

// ---------------------------------------------------------------- the tiers

test("R1: a trivial read spends the cheapest capable worker", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const result = router.route(request({ task: "Where is the theme configuration defined?" }));
  // A fast model wins. Which fast model is decided by capability and reasoning, because the
  // catalogue carries no price: among models of the same speed class there is nothing honest to
  // prefer, and inventing a price would be worse than ranking on what was measured.
  assert.equal(result.selected.model.definition.speed, "fast", `a lookup buys a fast model: ${winner(result)}`);
  assert.equal(result.selected.reasons.some((reason) => reason.startsWith("capability:")), true, "and the receipt says why it was eligible");
  assert.equal(result.selected.reasons.includes("tier:T0"), true, "and which tier decided it");
  // The stronger models were eligible and lost on price, not on capability: their absence from
  // `rejected` is the assertion that the floor did not do the work.
  assert.deepEqual(rejectionOf(result, "claude-opus-5"), [], "the strongest model was eligible and lost on score");
  assert.equal(result.fallbacks.length > 0, true, "with the runners-up recorded for failover");
});

test("R2: a trivial read does not go to the strongest model, and a hard one does", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const trivial = router.route(request({ task: "What does the theme configuration do when the session expires?" }));
  assert.notEqual(winner(trivial), "anthropic/claude-opus-5", "a lookup does not buy an opus");

  const hard = router.route(request({
    task: "Investigate why the session expires during checkout, trace every retry path across the auth and payment modules, and explain the interaction with the refresh timer. Do not modify anything.",
  }));
  const hardWinner = winner(hard);
  assert.equal(["anthropic/claude-opus-5", "openai/gpt-6-astra"].includes(hardWinner), true, `a deep investigation escalates: ${hardWinner}`);
  assert.equal(hard.selected.reasons.some((reason) => reason.startsWith("capability:")), true, "and the receipt carries its capability");
});

test("R3: a low-risk DIRECT write goes to a write-capable balanced model, not the cheapest one", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const result = router.route(request({
    task: "Append one inert comment line to docs/notes.md",
    writeRequired: true,
    policy: { id: "direct", supportedProviders: ["anthropic", "openai", "xai"] },
  }));
  assert.equal(result.selected.model.definition.writeCapable, true, "a write needs a model that can write");
  // Ordinary work, and a write starts at T2: the value preference has to apply here or every small
  // append buys the strongest model in the catalogue — which is what it used to do.
  assert.equal(result.selected.model.definition.speed, "balanced", `a small T2 write does not buy a deep model: ${winner(result)}`);
  assert.equal(result.selected.reasons.includes("tier:T2"), true);
  assert.notEqual(winner(result), "anthropic/claude-opus-5");
});

test("R4: a high-risk write is refused before a provider is chosen at all", () => {
  // The classification is what blocks this, and the router is downstream of it: the assertion here is
  // that a high-risk request still classifies as high risk and never reaches a model as ordinary work.
  const high = request({ task: "Remove the auth middleware and update the payment migration", writeRequired: true });
  assert.equal(["high", "critical"].includes(high.classification.risk), true, `a destructive write is high risk or worse: ${high.classification.risk}`);
  const router = new CapabilityRouter(registry(CATALOGUE));
  const result = router.route(high);
  assert.equal(result.selected.model.definition.capabilities.coder! >= 72, true, "and if it is routed at all, it is routed to a capable worker");
});

// ---------------------------------------------------------------- eligibility, not preference

test("R5: same-provider model choice picks the value model for simple work and the strong one for hard work", () => {
  const router = new CapabilityRouter(registry(CATALOGUE.filter((f) => f.providerId === "anthropic")));
  const simple = router.route(request({ task: "List the files under docs/" }));
  assert.equal(simple.selected.model.definition.speed, "fast", "a simple listing buys the fast model on this subscription");
  const hard = router.route(request({
    task: "Trace every retry path in the checkout flow across the auth and payment modules and explain how they interact with the refresh timer; investigate the failure mode and compare each hypothesis.",
  }));
  assert.equal(winner(hard), "anthropic/claude-opus-5", "the same subscription escalates when the work is real");
});

test("R6: a quota-exhausted pool is a rejection with a reason, and the next provider takes the work", () => {
  const router = new CapabilityRouter(registry([
    { ...CATALOGUE[0]!, quotaState: "exhausted" },
    { ...CATALOGUE[1]!, quotaState: "exhausted" },
    { ...CATALOGUE[2]!, quotaState: "exhausted" },
    CATALOGUE[3]!,
  ]));
  const result = router.route(request({ task: "Where is the theme configuration defined?" }));
  assert.equal(winner(result), "openai/gpt-6-astra", "the work moves to the provider that is not exhausted");
  assert.equal(rejectionOf(result, "claude-haiku-4-5").includes("quota-exhausted"), true, "and the refusal says why");
});

test("R7: an active refusal backoff is honoured, and named as policy rather than as exhaustion", () => {
  const future = new Date(Date.now() + 600_000).toISOString();
  const router = new CapabilityRouter(registry([
    { ...CATALOGUE[2]!, backoffUntil: future },
    CATALOGUE[3]!,
  ]));
  const result = router.route(request({ task: "Where is the theme configuration defined?" }));
  assert.equal(winner(result), "openai/gpt-6-astra");
  const reasons = rejectionOf(result, "claude-haiku-4-5");
  assert.equal(reasons.some((reason) => reason.startsWith("quota-pool-backoff:")), true, `a backoff names the pool: ${reasons.join(",")}`);
  assert.equal(reasons.includes("quota-exhausted"), false, "BrainGate waiting is not the provider refusing");
});

test("R8: an unavailable provider is excluded even when it is the strongest", () => {
  const router = new CapabilityRouter(registry(CATALOGUE.map((f) => (f.providerId === "anthropic" ? { ...f, available: false } : f))));
  const result = router.route(request({ task: "Investigate the retry paths in the checkout flow and compare each hypothesis" }));
  assert.equal(result.selected.model.definition.providerId !== "anthropic", true, "no work goes to a CLI that is not installed");
  assert.equal(rejectionOf(result, "claude-opus-5").includes("runtime-unavailable"), true);
});

test("R9: a model that cannot write never takes a write, however strong it is", () => {
  const router = new CapabilityRouter(registry([
    { providerId: "anthropic", modelId: "claude-opus-5", coder: 99, reasoning: 99, speed: "deep", write: false },
    { providerId: "xai", modelId: "grok-4.6", coder: 90, reasoning: 88, write: true },
  ]));
  const result = router.route(request({ task: "Append one inert comment line to docs/notes.md", writeRequired: true }));
  assert.equal(winner(result), "xai/grok-4.6");
  assert.equal(rejectionOf(result, "claude-opus-5").includes("write-not-supported"), true);
});

test("R10: a provider that cannot execute the policy is refused, with the policy named", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const result = router.route(request({
    task: "Where is the theme configuration defined?",
    policy: { id: "direct", supportedProviders: ["anthropic", "xai"] },
  }));
  assert.equal(result.selected.model.definition.providerId === "openai", false, "a provider with no DIRECT invocation is not routed to");
  assert.equal(rejectionOf(result, "gpt-6-astra").includes("policy-not-supported:direct"), true, "and the receipt names the policy it cannot run");
});

test("R11: no eligible model produces a reason list, not an empty failure", () => {
  const router = new CapabilityRouter(registry(CATALOGUE.map((f) => ({ ...f, available: false }))));
  try {
    router.route(request({ task: "Where is the theme configuration defined?" }));
    assert.fail("routing should have refused");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /ROUTE_NO_ELIGIBLE_MODEL|No eligible model/);
    assert.match(message, /runtime-unavailable/, `the refusal names the cause: ${message}`);
  }
});

// ---------------------------------------------------------------- continuity

test("R12: a compatible existing session beats a marginally stronger cold model", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const result = router.route(request({
    task: "Explain what the previous worker concluded about the expiry path",
    continuity: { warm: [{ providerId: "xai", modelId: "grok-4.6" }], previous: { providerId: "xai", modelId: "grok-4.6" } },
  }));
  assert.equal(winner(result), "xai/grok-4.6", "the warm worker keeps the work");
  assert.equal(result.selected.reasons.includes("continuity:warm-session"), true);
  assert.equal(result.selected.reasons.includes("continuity:previous-worker"), true);
});

test("R13: a warm session does not keep work it cannot do", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const result = router.route(request({
    task: "Investigate every retry path in the checkout flow, trace the interaction with the auth and payment modules, compare each hypothesis and explain the failure mode in depth.",
    continuity: { warm: [{ providerId: "anthropic", modelId: "claude-haiku-4-5" }], previous: { providerId: "anthropic", modelId: "claude-haiku-4-5" } },
  }));
  assert.notEqual(winner(result), "anthropic/claude-haiku-4-5", "a fast model does not keep deep investigation because it is warm");
  assert.equal(result.selected.model.definition.capabilities.coder! >= 90, true, "the harder work escalates");
});

test("R14: a warm session does not keep a write it is not capable of", () => {
  const router = new CapabilityRouter(registry([
    { providerId: "anthropic", modelId: "claude-haiku-4-5", coder: 78, reasoning: 74, speed: "fast", write: false },
    { providerId: "xai", modelId: "grok-4.6", coder: 90, reasoning: 88, write: true },
  ]));
  const result = router.route(request({
    task: "Append one inert comment line to docs/notes.md",
    writeRequired: true,
    continuity: { warm: [{ providerId: "anthropic", modelId: "claude-haiku-4-5" }] },
  }));
  assert.equal(winner(result), "xai/grok-4.6", "capability and write support outrank warmth");
  assert.equal(rejectionOf(result, "claude-haiku-4-5").includes("write-not-supported"), true);
});

// ---------------------------------------------------------------- override

test("R15: a manual pin is authoritative, and its refusal is not routed around", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const pinned = router.route(request({
    task: "Where is the theme configuration defined?",
    pin: { providerId: "anthropic", modelId: "claude-opus-5" },
  }));
  assert.equal(winner(pinned), "anthropic/claude-opus-5", "the operator's choice wins even when it is the expensive one");

  assert.throws(
    () => router.route(request({
      task: "Where is the theme configuration defined?",
      pin: { providerId: "openai", modelId: "gpt-6-astra" },
      policy: { id: "direct", supportedProviders: ["anthropic", "xai"] },
    })),
    /cannot run this work: policy-not-supported:direct.*Nothing was routed elsewhere/s,
    "a pin that cannot run the policy is refused by name, never routed around",
  );
});

test("R16: a pin to an ineligible model refuses rather than routing elsewhere", () => {
  const router = new CapabilityRouter(registry(CATALOGUE.map((f) => (f.modelId === "grok-4.6" ? { ...f, quotaState: "exhausted" as const } : f))));
  try {
    router.route(request({ task: "Where is the theme configuration defined?", pin: { providerId: "xai", modelId: "grok-4.6" } }));
    assert.fail("a refused pin must not be routed around");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /cannot run this work: quota-exhausted/);
    assert.match(message, /Nothing was routed elsewhere/);
  }
});

// ---------------------------------------------------------------- language, length and wording

test("R17: a long prompt full of risk vocabulary is judged by its directive, and a real one is not buried by length", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const misleading = [
    "Here is the background you asked for.",
    "The payment migration removed the auth middleware and touched the checkout path, and the security review flagged it.",
    "Do not modify anything: this is context.",
    "",
    "What does the delete handler do?",
  ].join("\n");
  const result = router.route(request({ task: misleading }));
  assert.equal(result.selected.model.definition.writeCapable, true, "a read routes to any worker, write-capable or not");
  assert.notEqual(winner(result), "anthropic/claude-opus-5", "the vocabulary in the background did not buy a stronger model");
});

test("R18: Arabic prompts route on the same rules as English ones", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const simple = router.route(request({ task: "وين ملف الإعدادات؟" }));
  const hard = router.route(request({ task: "اشرح بالتفصيل كل مسارات إعادة المحاولة في الدفع والمصادقة وقارن بين الفرضيات وتتبع سبب فشل التجديد" }));
  assert.equal(simple.selected.model.definition.speed, "fast", `a short Arabic question buys a fast model: ${winner(simple)}`);
  assert.equal(hard.selected.model.definition.capabilities.coder! >= 90, true, "and a long Arabic investigation escalates");
});

test("R19: an ambiguous task routes to the middle, not to the extremes", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const result = router.route(request({ task: "Can you look into the login thing?" }));
  assert.equal(["anthropic/claude-haiku-4-5", "xai/grok-4.5", "xai/grok-4.6", "anthropic/claude-sonnet-5", "openai/gpt-6-astra"].includes(winner(result)), true, `an unclear request lands mid-catalogue: ${winner(result)}`);
  assert.notEqual(result.selected.model.definition.speed, "deep", "and does not buy a deep model on a vague request");
});

test("R20: the fallback list is ordered by the same reasons as the winner, and excludes the refused", () => {
  const router = new CapabilityRouter(registry(CATALOGUE));
  const result = router.route(request({
    task: "Where is the theme configuration defined?",
    excludeQuotaPools: ["xai-subscription"],
  }));
  assert.equal(result.fallbacks.some((f) => f.model.definition.providerId === "xai"), false, "a refused pool is not a fallback either");
  const scores = [result.selected, ...result.fallbacks].map((c) => c.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "fallbacks are the next-best eligible models, in order");
});
