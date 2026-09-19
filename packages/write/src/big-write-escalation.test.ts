import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError, budgetFor, classifyTask, type TaskClassification } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, ModelRegistry } from "@braingate/router";
import { codexIsolationProfileHash, type CodexIsolationAttestation } from "@braingate/shadow";
import { bigWrite, buildWriteTaskPlan } from "./write-runner.js";

/**
 * What a big write does now that it is no longer refused (ADR 0021).
 *
 * A T3/T4 or high/critical-risk change used to end at `assertM11Scope` whatever was asked for. It
 * now has exactly one shape: an isolated worktree, a reviewer from another provider, and a merge
 * that stays the operator's. The three things worth pinning are the three ways that can go wrong —
 * it quietly runs DIRECT, it runs with a reviewer from the same subscription that wrote it, or it
 * is refused after something has already been spent. None of these tests reaches a provider: the
 * whole decision is made while building the plan, which is the point.
 */

function observation<T>(value: T) { return { value, evidence: "native" as const, sourceCommand: null, observedAt: "2026-09-19T00:00:00.000Z" }; }

function snapshot(providerId: "anthropic" | "openai"): ProviderSnapshot {
  return {
    providerId,
    displayName: providerId === "anthropic" ? "Claude Code" : "Codex CLI",
    binary: providerId === "anthropic" ? "claude" : "codex",
    available: observation(true),
    version: observation(providerId === "anthropic" ? "2.1.278" : "0.153.4"),
    authState: observation("authenticated"),
    authMode: observation("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt: "2026-09-19T00:00:00.000Z" },
    capabilities: observation({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt: "2026-09-19T00:00:00.000Z" },
    removedBillingOverrides: [],
    warnings: [],
  } as unknown as ProviderSnapshot;
}

function codexIsolation(): CodexIsolationAttestation {
  return {
    providerId: "openai", source: "sandbox-self-test", version: "0.153.4",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    profileHash: codexIsolationProfileHash(), droppedFeatureKeys: [],
    observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as CodexIsolationAttestation;
}

const runtime = { available: true, quotaState: "healthy" as const, quotaHint: 0.1, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-19T00:00:00.000Z" };

/** One write-capable Anthropic model, and — when asked — a Codex model that can only review. */
function router(withCodex: boolean): CapabilityRouter {
  const registry = new ModelRegistry();
  registry.register({ providerId: "anthropic", modelId: "claude-write", quotaPool: "claude-subscription", capabilities: { coder: 95, reviewer: 80, judge: 80 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null }, runtime);
  // A second Anthropic model, so "no cross-provider reviewer" is a real choice the router could
  // have made rather than an empty candidate set: the cascade would have picked this one.
  registry.register({ providerId: "anthropic", modelId: "claude-review", quotaPool: "claude-subscription", capabilities: { coder: 70, reviewer: 90, judge: 85 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 85, underlyingFamily: null }, runtime);
  if (withCodex) registry.register({ providerId: "openai", modelId: "codex-review", quotaPool: "chatgpt-subscription", capabilities: { coder: 60, reviewer: 88, judge: 88 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 88, underlyingFamily: null }, runtime);
  return new CapabilityRouter(registry);
}

function planFor(input: {
  readonly task: string;
  readonly policy?: "direct" | "worktree";
  readonly allowEscalation?: boolean;
  readonly withCodex?: boolean;
  readonly review?: boolean;
}) {
  const classification = classifyTask({ text: input.task, mode: "write" });
  const withCodex = input.withCodex ?? true;
  return buildWriteTaskPlan({
    router: router(withCodex),
    providers: withCodex ? [snapshot("anthropic"), snapshot("openai")] : [snapshot("anthropic")],
    ...(withCodex ? { codexIsolation: codexIsolation() } : {}),
    classification,
    budget: budgetFor(classification, { writeRequested: true }),
    requiredContextTokens: 500,
    repositoryPath: "/repo",
    baseRef: "HEAD",
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.allowEscalation === undefined ? {} : { allowEscalation: input.allowEscalation }),
    ...(input.review === undefined ? {} : { review: input.review }),
  });
}

const BIG_TASK = "Change the authentication acceptance logic in auth/login.ts.";
const CRITICAL_TASK = "Change the charge and refund behaviour in payments/processor.ts.";
const SMALL_TASK = "change the button label";

function codeOf(error: unknown): string | undefined {
  return (error as { readonly code?: string }).code;
}

// ---------------------------------------------------------------- what counts as big

test("the size of a write is read from its tier first and its risk second", () => {
  const t3 = classifyTask({ text: BIG_TASK, mode: "write" });
  assert.equal(t3.complexity, "T3");
  assert.equal(bigWrite(t3), "T3");
  assert.equal(bigWrite(classifyTask({ text: CRITICAL_TASK, mode: "write" })), "T4");
  assert.equal(bigWrite(classifyTask({ text: SMALL_TASK, mode: "write" })), null);
  // A T2 change whose subject makes it dangerous is still a big write, and says so in those words.
  const risky: TaskClassification = { ...t3, complexity: "T2", risk: "high" };
  assert.equal(bigWrite(risky), "risk high");
});

// ---------------------------------------------------------------- escalation, and its refusal

test("a T3 write asked for DIRECT escalates to a worktree with a cross-provider reviewer", () => {
  const plan = planFor({ task: BIG_TASK, policy: "direct", allowEscalation: true });
  assert.equal(plan.policy, "worktree", "the work moves out of the operator's checkout");
  assert.notEqual(plan.escalated, null);
  assert.equal(plan.escalated?.from, "direct", "the plan remembers what was asked for");
  assert.equal(plan.escalated?.reason, "T3");
  assert.equal(plan.reviewRequired, true);
  const primary = plan.roles.find((role) => role.role === "primary")!;
  const reviewer = plan.roles.find((role) => role.role === "reviewer")!;
  assert.equal(primary.workspace, "task-worktree", "and the worker works there, not in the workspace");
  assert.notEqual(reviewer, undefined, "a big write is never unreviewed");
  assert.notEqual(reviewer.model.providerId, primary.model.providerId, "and never reviewed by its own provider");
  assert.equal(reviewer.model.providerId, "openai");
});

test("the same write asked for DIRECT without escalation is refused, with both ways forward", () => {
  try {
    planFor({ task: BIG_TASK, policy: "direct" });
    assert.fail("a big write must never be planned as a DIRECT write");
  } catch (error) {
    assert.equal(codeOf(error), "WRITE_SCOPE_BLOCKED");
    const message = (error as Error).message;
    assert.match(message, /does not run DIRECT/);
    assert.match(message, /--policy worktree/, "the flag interface's remedy");
    assert.match(message, /let the session escalate it/, "and the session's");
    assert.match(message, /Nothing was spent/);
  }
});

test("a big write asked for a worktree simply runs there: escalation is only about DIRECT", () => {
  const plan = planFor({ task: BIG_TASK, policy: "worktree" });
  assert.equal(plan.policy, "worktree");
  assert.equal(plan.escalated, null, "nothing was moved, so nothing is reported as moved");
  assert.equal(plan.reviewRequired, true);
  assert.equal(plan.roles.length, 2);
});

// ---------------------------------------------------------------- the reviewer is not optional

test("a big write with one signed-in provider is refused by name rather than reviewed by itself", () => {
  try {
    planFor({ task: BIG_TASK, policy: "direct", allowEscalation: true, withCodex: false });
    assert.fail("a same-provider reviewer is not an independent reviewer");
  } catch (error) {
    assert.equal(codeOf(error), "WRITE_REVIEWER_UNAVAILABLE");
    const message = (error as Error).message;
    assert.match(message, /other than anthropic/);
    assert.match(message, /only signed-in provider/);
    assert.match(message, /Sign in to a second CLI/);
    assert.ok(error instanceof BrainGateInvariantError);
  }
});

test("`--no-review` cannot switch off a big write's reviewer", () => {
  const plan = planFor({ task: BIG_TASK, policy: "direct", allowEscalation: true, review: false });
  assert.equal(plan.reviewRequired, true);
  assert.equal(plan.roles.some((role) => role.role === "reviewer"), true, "the second reader is part of what makes this safe to run");
});

test("a critical write keeps its human approval and its independent reviewer", () => {
  const classification = classifyTask({ text: CRITICAL_TASK, mode: "write" });
  assert.equal(classification.risk, "critical");
  // Unchanged by escalation: the budget still demands a person before this may write.
  assert.equal(budgetFor(classification, { writeRequested: true }).humanApprovalBeforeWrite, true);
  const plan = planFor({ task: CRITICAL_TASK, policy: "direct", allowEscalation: true });
  assert.equal(plan.policy, "worktree");
  assert.equal(plan.escalated?.reason, "T4");
  assert.equal(plan.roles.find((role) => role.role === "reviewer")?.model.providerId, "openai");
});

// ---------------------------------------------------------------- ordinary writes are untouched

test("a T2 low-risk write is still a DIRECT write with one worker", () => {
  const plan = planFor({ task: SMALL_TASK, policy: "direct", allowEscalation: true, review: false });
  assert.equal(plan.policy, "direct");
  assert.equal(plan.escalated, null);
  assert.equal(plan.reviewRequired, false);
  assert.deepEqual(plan.roles.map((role) => role.role), ["primary"]);
  assert.equal(plan.roles[0]?.workspace, "workspace");
});
