import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectRegistry,
  type RegisteredProject,
  executionScopeFor,
} from "@braingate/core";
import { GoalStore, computeGoalDelta, renderGoalDelta, resolveSessionDecision } from "@braingate/goals";
import { createNativeSessionResolver, recordSessionUse, parseUseTarget, pinFor, AUTO_WORKER, describeWorker } from "./worker-commands.js";



/**
 * The returning-worker delta, as a unit.
 *
 * The scenarios in `repl-worker.test.ts` drive the whole interactive surface, which means a failure
 * there could be in the session registry, the resolver, the payload, the router or the fake. This
 * file tests the resolver's own contract: given a goal that a session already participated in, does
 * it hand back a delta rather than the handoff?
 */

function project(label: string) {
  const root = mkdtempSync(join(tmpdir(), `braingate-worker-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const registered = new ProjectRegistry(join(root, "home")).register({ projectId: label as never, name: label, repositories: [repo] });
  // Goals and sessions are this workspace's execution state, so the fixture hands out the handle a
  // command would resolve rather than the project-level one.
  return { project: executionScopeFor(registered, repo).project, repo };
}

function resolverFor(store: GoalStore, goalId: string, conversationId: string) {
  return createNativeSessionResolver({
    goals: store,
    goal: () => store.getGoal(goalId) ?? null,
    conversationId: () => conversationId,
    freshRequested: () => false,
    consumeFresh: () => { /* nothing armed in this test */ },
    probedContinuity: () => true,
    runtimeVersion: () => "2.1.269",
    workspace: () => "/a/stable/workspace",
    // The envelope this run executes under. A test that is about a write says so by overriding it.
    intent: () => "read",
    policy: () => "direct",
    onResolved: () => { /* the summary is asserted in the scenario tests */ },
  });
}

const request = (task: string, context: unknown) => ({ role: "primary", phase: "initial", model: { providerId: "anthropic", modelId: "claude-sonnet", quotaPool: "claude-subscription" }, task, context });

test("a resumed session is handed a delta in the context, and the handoff is not repeated", async () => {
  const { project: target } = project("delta-unit");
  const store = new GoalStore(target);
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "fix the idle logout" });

    // Turn 1: a session is created and used.
    const resolve = resolverFor(store, goal.goalId, conversation.conversationId);
    const baseContext = { goal: { handoff: { goalId: goal.goalId, workUnit: "Investigate the idle logout" }, handoffText: "You are continuing BrainGate goal" } };
    const first = await resolve(request("Investigate the idle logout", baseContext));
    assert.ok(first !== null);
    assert.equal(first.decision.kind, "fresh", "a goal with no session starts one, pinned to an id BrainGate chose");
    assert.ok(first.decision.sessionId !== null);

    // The turn completes: the goal moves on and the session records where it got to.
    store.updateGoalState(goal.goalId, { status: "diagnosed", acceptedFindings: ["the splash routing race"], assertedBy: "anthropic/claude-sonnet" });
    store.recordTurn({ conversationId: conversation.conversationId, goalId: goal.goalId, request: "Investigate the idle logout", answer: "a splash routing race" });
    const goalAfterTurnOne = store.getGoal(goal.goalId)!;
    recordSessionUse({ goals: store, summary: { label: "anthropic/claude-sonnet", session: first.decision, delta: null }, goal: goalAfterTurnOne, taskId: "t1", turnSequence: 1 });

    // Something happens while this session is away — another worker, or the operator. This is the
    // entire point of a delta: a resumed session remembers its own turns, so what it cannot know is
    // what the *others* did.
    store.updateGoalState(goal.goalId, {
      secondaryFindings: ["a latent dio refresh stub"],
      filesChanged: ["lib/features/splash/presentation/splash_page.dart"],
      testsRun: ["flutter test test/splash_test.dart"],
      assertedBy: "xai/grok-4",
    });
    store.recordTurn({ conversationId: conversation.conversationId, goalId: goal.goalId, request: "Review that diagnosis", answer: "the stub is latent, not causal" });

    // Turn 2 on the same model: the session exists and the goal has moved.
    const second = await resolve(request("What else could cause it?", baseContext));
    assert.ok(second !== null);
    assert.equal(second.decision.kind, "resumed", "the same model must continue its own session");
    assert.equal(second.decision.sessionId, first.decision.sessionId);

    // The delta is what a resumed worker gets, in place of the handoff it already lived through, and
    // it sits in the goal layer — the layer every reader of a worker's context actually looks at.
    const context = (second.context as { readonly goal?: { readonly goalDelta?: { readonly empty: boolean; readonly secondaryAdded: readonly unknown[]; readonly filesChanged: readonly string[]; readonly testsRun: readonly string[]; readonly turns: readonly unknown[] }; readonly handoff?: unknown; readonly handoffText?: string } } | undefined)?.goal;
    assert.ok(context !== undefined, "a resumed turn must carry the goal layer");
    assert.ok(context.goalDelta !== undefined, "a resumed turn must carry a delta");
    assert.equal(context.handoff, undefined, "a resumed turn must not repeat the whole handoff");
    assert.equal(context.goalDelta.empty, false, "the delta must report what happened while the session was away");
    assert.equal(context.goalDelta.secondaryAdded.length, 1);
    assert.deepEqual([...context.goalDelta.filesChanged], ["lib/features/splash/presentation/splash_page.dart"]);
    assert.deepEqual([...context.goalDelta.testsRun], ["flutter test test/splash_test.dart"]);
    assert.equal(context.goalDelta.turns.length, 1, "the other worker's turn is what a resumed session cannot know");
    assert.match(String(context.handoffText ?? ""), /Your native session is continuing/);
    assert.match(String(context.handoffText ?? ""), /Review that diagnosis/);
  } finally { store.close(); }
});

test("a session whose workspace is not the one this run would use is not resumed", async () => {
  const { project: target } = project("workspace-check");
  const store = new GoalStore(target);
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "g" });
    store.recordProviderSession({
      providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-other",
      resumeMode: "available", status: "active", workspace: "/a/different/workspace", goalId: goal.goalId,
    });
    const resolve = resolverFor(store, goal.goalId, conversation.conversationId);
    const resolved = await resolve(request("continue", {}));
    assert.ok(resolved !== null);
    // A session written for another workspace is a fact about where it lives, not a policy about
    // where the runtime may keep it — and resuming it would be a guess.
    assert.equal(resolved.decision.kind, "fresh");
    assert.equal(resolved.decision.reason, "workspace-changed");
    assert.notEqual(resolved.decision.sessionId, "s-other");
  } finally { store.close(); }
});

test("a session made against another build, or another workspace, is not resumed on a guess", () => {
  const { project: target } = project("mismatch");
  const store = new GoalStore(target);
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "g" });
    const base = {
      providerId: "anthropic" as const,
      modelId: "claude-sonnet",
      role: "primary",
      freshRequested: false,
      probedContinuity: true as const,
      goalId: goal.goalId,
    };

    // A build change is a mismatch BrainGate reports rather than resumes through: the session may
    // well be readable by the new build, and BrainGate does not know, so it declines to promise.
    const otherBuild = store.recordProviderSession({
      providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-build",
      resumeMode: "available", status: "active", runtimeVersion: "0.0.1-old", workspace: "/w", goalId: goal.goalId,
    });
    const buildMismatch = resolveSessionDecision({ ...base, runtimeVersion: "2.1.269", workspace: "/w", stored: otherBuild });
    assert.equal(buildMismatch.kind, "fresh");
    assert.equal(buildMismatch.reason, "runtime-version-changed");
    assert.notEqual(buildMismatch.sessionId, "s-build");

    // A session written for a different workspace is a fact about where it lives, not a policy about
    // where the runtime may keep it — and resuming it would be a guess.
    const otherWorkspace = store.recordProviderSession({
      providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-ws",
      resumeMode: "available", status: "active", runtimeVersion: "2.1.269", workspace: "/elsewhere", goalId: goal.goalId,
    });
    const workspaceMismatch = resolveSessionDecision({ ...base, runtimeVersion: "2.1.269", workspace: "/w", stored: otherWorkspace });
    assert.equal(workspaceMismatch.kind, "fresh");
    assert.equal(workspaceMismatch.reason, "workspace-changed");

    // Everything matching: resumed, and nothing is reported as wrong.
    const same = store.recordProviderSession({
      providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-ok",
      resumeMode: "available", status: "active", runtimeVersion: "2.1.269", workspace: "/w", goalId: goal.goalId,
    });
    const resumed = resolveSessionDecision({ ...base, runtimeVersion: "2.1.269", workspace: "/w", stored: same });
    assert.equal(resumed.kind, "resumed");
    assert.equal(resumed.sessionId, "s-ok");
    assert.equal(resumed.reason, null);
    assert.equal(resumed.persistent, true, "a native runtime keeps its own session state unless told otherwise");

    // And an unreadable probe takes the capability away rather than leaving it standing.
    const unprobed = resolveSessionDecision({ ...base, probedContinuity: "unknown", runtimeVersion: "2.1.269", workspace: "/w", stored: same });
    assert.equal(unprobed.kind, "resumed", "unknown is not false: a probe that could not read the help does not remove a capability the runtime has");
    const refused = resolveSessionDecision({ ...base, probedContinuity: false, runtimeVersion: "2.1.269", workspace: "/w", stored: same });
    assert.equal(refused.kind, "handoff");
    assert.equal(refused.reason, "provider-does-not-expose-session-ids");
  } finally { store.close(); }
});

test("a goal delta reports changes, and reports nothing when there is no baseline", () => {
  const { project: target } = project("delta-compute");
  const store = new GoalStore(target);
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "g" });
    const after = store.updateGoalState(goal.goalId, { status: "diagnosed", acceptedFindings: ["the splash race"], assertedBy: "op" });

    // No baseline: nothing can be claimed as new, so nothing is.
    const noBaseline = computeGoalDelta({ goal: store.requireGoal(goal.goalId), previous: null, turns: [], sinceSequence: null, sinceWorker: "anthropic/claude-sonnet" });
    assert.equal(noBaseline.empty, true);
    assert.equal(noBaseline.acceptedAdded.length, 0);

    // With a baseline: what moved is reported, by content rather than by timestamp.
    const before = store.requireGoal(goal.goalId).state;
    store.updateGoalState(goal.goalId, { secondaryFindings: ["a latent dio stub"], assertedBy: "op" });
    const delta = computeGoalDelta({ goal: store.requireGoal(goal.goalId), previous: before, turns: [], sinceSequence: 0, sinceWorker: "anthropic/claude-sonnet" });
    assert.equal(delta.empty, false);
    assert.equal(delta.secondaryAdded.length, 1);
    assert.equal(delta.acceptedAdded.length, 0, "an unchanged accepted finding is not news");
    void after;
    assert.match(renderGoalDelta(delta, "Apply it."), /new secondary finding/);
  } finally { store.close(); }
});

test("the use target parser keeps a model id containing slashes intact", () => {
  assert.deepEqual({ ...parseUseTarget("anthropic/claude-sonnet-4-5")! }, { providerId: "anthropic", modelId: "claude-sonnet-4-5", fresh: false });
  assert.deepEqual({ ...parseUseTarget("openai/gpt-5/codex")! }, { providerId: "openai", modelId: "gpt-5/codex", fresh: false });
  assert.equal(parseUseTarget("anthropic/claude-sonnet --fresh")!.fresh, true);
  assert.equal(parseUseTarget("sonnet"), null, "a bare model name names no provider");
  assert.equal(parseUseTarget("/sonnet"), null);
  assert.equal(parseUseTarget("anthropic/"), null);
});

test("auto selection implies no pin, and /worker describes both modes", () => {
  assert.equal(pinFor(AUTO_WORKER), undefined);
  assert.deepEqual({ ...pinFor({ mode: "manual", providerId: "xai", modelId: "grok-4", fresh: false })! }, { providerId: "xai", modelId: "grok-4" });
  const lines = describeWorker({ selection: AUTO_WORKER, goal: null, lastRun: null, knownSessions: [] });
  assert.match(lines.join("\n"), /Worker: auto/);
  assert.match(lines.join("\n"), /Goal: none yet/);
});
