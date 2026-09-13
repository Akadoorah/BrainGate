import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  BrainGateInvariantError,
  ProjectRegistry,
  type RegisteredProject,
  type TaskClassification,
  type TaskComplexity,
  type TaskRisk,
  type ExecutionProject,
  executionScopeFor,
} from "@braingate/core";
import { effectiveClassification, inheritedComplexityFloor, riskFloor } from "./inheritance.js";
import { buildGoalContext, buildHandoffPackage, renderHandoff, MAX_CONTEXT_TURNS } from "./handoff.js";
import { MAX_HANDOFF_CHARS, applyGoalStateUpdate, sameSubject } from "./goal-state.js";
import { GOALS_SCHEMA_VERSION, GoalStore } from "./store.js";
import type { GoalRecord, GoalState } from "./types.js";

/**
 * Execution state is workspace-scoped: the fixture's own directory is a workspace like any other.
 * A test that builds a project through this registry is asking for that directory's execution state,
 * which is exactly what `executionScopeFor` resolves for a real command.
 */
function workspace(project: RegisteredProject): ExecutionProject {
  return executionScopeFor(project, project.repositories[0]!).project;
}


/**
 * M20's foundation, tested without a provider.
 *
 * Every runtime here is a fake — a deterministic id generator and a fixed clock — which is the
 * point. The behaviours this milestone introduces are about *continuity*: which goal a follow-up
 * belongs to, what complexity it inherits, and what a second worker is told. None of that depends
 * on a model, and a suite that needed one could not be run on a machine with no subscriptions.
 */

function project(label: string): ExecutionProject {
  const root = mkdtempSync(join(tmpdir(), `braingate-goals-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const registry = new ProjectRegistry(join(root, "brain-home"));
  // The registry is what issues a project id; a test may not mint one itself.
  return workspace(registry.register({ projectId: label as never, name: label, repositories: [repo] }));
}

/** Monotonic ids, so a failure names the same finding twice. */
function ids(): () => string {
  let counter = 0;
  return () => `id-${String(++counter).padStart(4, "0")}`;
}

function openStore(label: string, now?: () => string): { store: GoalStore; project: ExecutionProject } {
  const target = project(label);
  return { store: new GoalStore(target, { newId: ids(), ...(now === undefined ? {} : { now }) }), project: target };
}

function classification(complexity: TaskComplexity, risk: TaskRisk, reasons: readonly string[] = ["test"]): TaskClassification {
  return Object.freeze({
    complexity,
    risk,
    confidence: 0.8,
    requiresScout: complexity !== "T0",
    reasons: Object.freeze([...reasons]),
    sensitiveDomains: Object.freeze([]),
    ruleVersion: "test-rule",
  });
}

// ---------------------------------------------------------------------------- persistence

test("a conversation is resumed rather than restarted, so a follow-up has something to continue", () => {
  const { store, project: target } = openStore("conversation-resume");
  try {
    const first = store.openConversation({ title: "first" });
    const second = store.openConversation();
    assert.equal(second.conversationId, first.conversationId);
    assert.equal(store.activeConversation()?.conversationId, first.conversationId);
    // The identity boundary is the project, not the process: the row is readable by id.
    assert.equal(store.getConversation(first.conversationId)?.projectId, target.projectId);
    assert.equal(store.getConversation("does-not-exist"), undefined);
  } finally { store.close(); }
});

test("a second project cannot read the first project's conversation", () => {
  const { store: a } = openStore("isolation-a");
  const { store: b } = openStore("isolation-b");
  try {
    const conversation = a.openConversation();
    const goal = a.createGoal({ conversationId: conversation.conversationId, objective: "fix idle logout" });
    a.recordTurn({ conversationId: conversation.conversationId, goalId: goal.goalId, request: "why?", answer: "because" });
    assert.equal(b.getConversation(conversation.conversationId), undefined);
    assert.equal(b.getGoal(goal.goalId), undefined);
    assert.equal(b.activeGoal(), null);
    assert.equal(b.recentTurns(conversation.conversationId, 5).length, 0);
    assert.throws(() => b.recordTurn({ conversationId: conversation.conversationId, request: "x", answer: "y" }), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GOAL_CONVERSATION_NOT_FOUND");
  } finally { a.close(); b.close(); }
});

test("the store refuses a file written by a newer BrainGate rather than reading it wrongly", () => {
  const target = project("version-guard");
  const store = new GoalStore(target, { newId: ids() });
  store.close();
  const db = new Database(join(target.storageDir, "goals.sqlite"));
  db.pragma(`user_version = ${String(GOALS_SCHEMA_VERSION + 1)}`);
  db.close();
  assert.throws(() => new GoalStore(target), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GOAL_STORE_VERSION_UNSUPPORTED");
});

test("the store starts at the schema version it writes, and reopens on it", () => {
  const target = project("version-write");
  const first = new GoalStore(target, { newId: ids() });
  const conversation = first.openConversation();
  first.close();
  const db = new Database(join(target.storageDir, "goals.sqlite"), { readonly: true });
  assert.equal(db.pragma("user_version", { simple: true }), GOALS_SCHEMA_VERSION);
  db.close();
  const second = new GoalStore(target, { newId: ids() });
  assert.equal(second.activeConversation()?.conversationId, conversation.conversationId);
  second.close();
});

test("a turn is redacted before it is written, and the timeline stays project-local", () => {
  const { store } = openStore("redaction");
  try {
    const conversation = store.openConversation();
    store.recordTurn({
      conversationId: conversation.conversationId,
      request: "use sk-abcdefghijklmnopqrstuvwxyz012345 to call the API",
      answer: "I will use sk-abcdefghijklmnopqrstuvwxyz012345 as instructed",
      attributedTo: ["anthropic/claude-sonnet"],
    });
    const [turn] = store.recentTurns(conversation.conversationId, 1);
    assert.ok(turn !== undefined);
    assert.doesNotMatch(turn.request, /sk-abcdefghijklmnopqrstuvwxyz012345/);
    assert.doesNotMatch(turn.answer, /sk-abcdefghijklmnopqrstuvwxyz012345/);
    assert.match(turn.answer, /\[REDACTED_API_TOKEN\]/);
    assert.deepEqual([...turn.attributedTo], ["anthropic/claude-sonnet"]);
  } finally { store.close(); }
});

test("the durable timeline outlives the eight-hour session thread, so yesterday's goal still has its exchange", () => {
  let clock = "2026-09-12T08:00:00.000Z";
  const { store } = openStore("timeline-durable", () => clock);
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "fix idle logout" });
    store.recordTurn({ conversationId: conversation.conversationId, goalId: goal.goalId, request: "diagnose it", answer: "splash race" });
    // Two days later, which is well past the thread's lifetime.
    clock = "2026-09-14T08:00:00.000Z";
    const turns = store.recentTurns(conversation.conversationId, 5);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.answer, "splash race");
    assert.equal(store.activeGoal()?.goalId, goal.goalId);
  } finally { store.close(); }
});

test("a turn needs a request and an answer, because half a turn is not a premise", () => {
  const { store } = openStore("turn-invalid");
  try {
    const conversation = store.openConversation();
    assert.throws(() => store.recordTurn({ conversationId: conversation.conversationId, request: "why?", answer: "   " }), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GOAL_TURN_INVALID");
    assert.throws(() => store.createGoal({ conversationId: conversation.conversationId, objective: "  " }), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GOAL_OBJECTIVE_INVALID");
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------- goal continuation

test("a follow-up continues the same goal by default, and only a closed goal starts a new one", () => {
  const { store } = openStore("continue-or-create");
  try {
    const conversation = store.openConversation();
    const first = store.continueOrCreateGoal({ conversationId: conversation.conversationId, request: "investigate the idle logout bug" });
    const second = store.continueOrCreateGoal({ conversationId: conversation.conversationId, request: "how would you implement the fix?" });
    assert.equal(second.goalId, first.goalId, "an ordinary follow-up must not start a second goal");
    assert.equal(store.listGoals(conversation.conversationId).length, 1);

    store.setGoalStatus(first.goalId, "done");
    const third = store.continueOrCreateGoal({ conversationId: conversation.conversationId, request: "now do something else entirely" });
    assert.notEqual(third.goalId, first.goalId, "finished work is not continued");
    assert.equal(store.listGoals(conversation.conversationId).length, 2);
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------- claims vs accepted state

test("an accepted finding keeps its evidence when a contradicting claim arrives", () => {
  const { store } = openStore("claims");
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "fix idle logout" });
    const diagnosed = store.updateGoalState(goal.goalId, {
      status: "diagnosed",
      acceptedFindings: [{ claim: "A cold-start splash routing race causes the apparent logout", evidence: ["apps/mobile/lib/features/splash/presentation/splash_page.dart:1"] }],
      approvedScope: ["apps/mobile/lib/features/splash/presentation/splash_page.dart"],
      nextAction: "implementation planning",
      assertedBy: "anthropic/claude-sonnet",
    });
    assert.equal(diagnosed.state.acceptedFindings.length, 1);
    assert.equal(diagnosed.state.acceptedFindings[0]?.status, "accepted");
    assert.deepEqual([...diagnosed.state.acceptedFindings[0]!.evidence], ["apps/mobile/lib/features/splash/presentation/splash_page.dart:1"]);

    // The second worker's contrary claim. It must not displace the established one.
    const contradicted = store.updateGoalState(goal.goalId, {
      acceptedFindings: [{ claim: "Token refresh fragmentation in the splash routing causes the logout", evidence: ["lib/core/network/dio_client.dart:1"] }],
      assertedBy: "anthropic/claude-haiku",
    });
    assert.equal(contradicted.state.acceptedFindings.length, 1);
    assert.match(contradicted.state.acceptedFindings[0]!.claim, /splash routing race/);
    assert.deepEqual([...contradicted.state.acceptedFindings[0]!.evidence], ["apps/mobile/lib/features/splash/presentation/splash_page.dart:1"], "the established finding keeps its own evidence");
    assert.equal(contradicted.state.disputedFindings.length, 1);
    assert.equal(contradicted.state.disputedFindings[0]?.status, "conflicting");
    assert.equal(contradicted.state.disputedFindings[0]?.conflictsWith, diagnosed.state.acceptedFindings[0]?.findingId);
    assert.match(contradicted.state.disputedFindings[0]!.claim, /Token refresh fragmentation/);
    assert.deepEqual([...contradicted.state.disputedFindings[0]!.evidence], ["lib/core/network/dio_client.dart:1"], "the dispute carries the evidence for its own claim");
    assert.equal(contradicted.state.disputedFindings[0]?.assertedBy, "anthropic/claude-haiku");
  } finally { store.close(); }
});

test("an accepted finding never loses the evidence a later update happened to carry", () => {
  const { store } = openStore("evidence-retained");
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "g" });
    const first = store.updateGoalState(goal.goalId, { acceptedFindings: [{ claim: "the splash route flips to login before session restore resolves", evidence: ["a.dart:1"] }], assertedBy: "operator" });
    const second = store.updateGoalState(goal.goalId, { acceptedFindings: [{ claim: "a completely different subject entirely unrelated here", evidence: ["b.dart:9"] }], assertedBy: "operator" });
    assert.equal(second.state.acceptedFindings.length, 2, "an unrelated finding is a second finding, not a conflict");
    assert.deepEqual([...second.state.acceptedFindings[0]!.evidence], ["a.dart:1"]);
    assert.deepEqual([...second.state.acceptedFindings[1]!.evidence], ["b.dart:9"]);
    assert.equal(first.state.acceptedFindings[0]?.findingId, second.state.acceptedFindings[0]?.findingId);
  } finally { store.close(); }
});

test("state updates are bounded, so a handoff cannot grow into a transcript", () => {
  const { store } = openStore("bounded-state");
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "g" });
    const many = Array.from({ length: 40 }, (_, index) => `finding number ${String(index)} about a distinct subsystem area ${String(index)}`);
    const updated = store.updateGoalState(goal.goalId, { acceptedFindings: many, assertedBy: "operator" });
    assert.ok(updated.state.acceptedFindings.length <= 8);
  } finally { store.close(); }
});

test("sameSubject separates a real contradiction from two findings that merely share a sentence", () => {
  assert.equal(sameSubject("splash routing race causes the logout", "the splash routing race is the root cause"), true);
  assert.equal(sameSubject("splash routing race causes the logout", "token refresh fragmentation causes logout"), false);
  assert.equal(sameSubject("the router scores models by capability", "the classifier rates the request"), false);
});

test("a claim that repeats an established finding verbatim is not recorded as a dispute with itself", () => {
  const { store } = openStore("no-self-conflict");
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "g" });
    store.updateGoalState(goal.goalId, { acceptedFindings: ["the splash screen waits a fixed timeout before reading auth state"], assertedBy: "operator" });
    const again = store.updateGoalState(goal.goalId, { acceptedFindings: ["the splash screen waits a fixed timeout before reading auth state"], assertedBy: "operator" });
    assert.equal(again.state.acceptedFindings.length, 1);
    assert.equal(again.state.disputedFindings.length, 0);
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------- follow-up complexity

test("a short follow-up inherits the complexity of the goal it continues", () => {
  const state: GoalState = {
    status: "diagnosed",
    acceptedFindings: Object.freeze([{ findingId: "f1", status: "accepted" as const, claim: "splash routing race", evidence: Object.freeze(["splash_page.dart"]), assertedBy: "anthropic/claude-sonnet", conflictsWith: null, supersededBy: null, recordedAt: "2026-09-12T00:00:00.000Z" }]),
    secondaryFindings: Object.freeze([]),
    disputedFindings: Object.freeze([]),
    openQuestions: Object.freeze([]),
    approvedScope: Object.freeze(["apps/mobile/lib/features/splash/presentation/splash_page.dart"]),
    filesChanged: Object.freeze([]),
    testsRun: Object.freeze([]),
    nextAction: "implementation planning",
    providerSessions: Object.freeze([]),
  };

  // What the classifier says about the literal words of turn 2, which is all it ever saw.
  const prompt = classification("T1", "low", ["small-question-cue"]);
  const effective = effectiveClassification({ prompt, state });
  assert.equal(effective.prompt.complexity, "T1");
  assert.equal(effective.effective.complexity, "T2");
  assert.equal(effective.applied, true);
  assert.ok(effective.effective.reasons.includes("goal-inherited-complexity:T2"));
  // The prompt's own reasons survive: the receipt can show both numbers and why they differ.
  assert.ok(effective.effective.reasons.includes("small-question-cue"));
});

test("a follow-up can raise the floor but never lower it", () => {
  const diagnosed = { ...diagnosedState(), status: "diagnosed" as const };
  const harder = effectiveClassification({ prompt: classification("T4", "critical"), state: diagnosed });
  assert.equal(harder.effective.complexity, "T4");
  assert.equal(harder.effective.risk, "critical");
  assert.equal(harder.applied, false);
  assert.ok(harder.effective.reasons.includes("goal-floor-met"));

  // A goal with nothing established inherits nothing: a follow-up to an unanswered question is
  // not magically complex.
  assert.equal(inheritedComplexityFloor({ ...diagnosedState(), status: "open", acceptedFindings: Object.freeze([]), approvedScope: Object.freeze([]), nextAction: null }), "T0");
  const open = effectiveClassification({ prompt: classification("T1", "low"), state: { ...diagnosedState(), status: "open", acceptedFindings: Object.freeze([]), approvedScope: Object.freeze([]), nextAction: null } });
  assert.equal(open.effective.complexity, "T1");
});

test("the goal's floor is a floor, and not a history of the highest tier it ever reached", () => {
  // A goal with findings is T2 whether it is diagnosed or being implemented. Holding it at T3
  // because it was once a fresh diagnosis is the inflation this rule exists to prevent: ten turns
  // into an implementation would still be buying a planner for running the tests.
  assert.equal(inheritedComplexityFloor({ ...diagnosedState(), status: "diagnosed" }), "T2");
  // A diagnosis with no formally accepted finding is still a diagnosis: the stage alone is enough,
  // because it means a turn concluded something the next worker must not re-derive from nothing.
  assert.equal(inheritedComplexityFloor({ ...diagnosedState(), status: "diagnosed", acceptedFindings: Object.freeze([]) }), "T2");
  assert.equal(inheritedComplexityFloor({ ...diagnosedState(), status: "implementing" }), "T3");
  assert.equal(inheritedComplexityFloor({ ...diagnosedState(), status: "blocked" }), "T3");
  // Nothing established and nothing in progress is no floor at all.
  assert.equal(inheritedComplexityFloor({ ...diagnosedState(), status: "open", acceptedFindings: Object.freeze([]), approvedScope: Object.freeze([]), nextAction: null }), "T0");
  // A goal with nothing but a dispute still cannot be routed as a lookup.
  assert.equal(inheritedComplexityFloor({ ...diagnosedState(), status: "open", acceptedFindings: Object.freeze([]), disputedFindings: diagnosedState().acceptedFindings }), "T2");

  // It never exceeds T3 on its own account, so the tiers above it stay reserved for a message that
  // actually earns them.
  for (const status of ["open", "diagnosed", "implementing", "blocked", "done", "abandoned"] as const) {
    const floor = inheritedComplexityFloor({ ...diagnosedState(), status });
    assert.ok(["T0", "T2", "T3"].includes(floor), `${status} produced ${floor}`);
  }
});

test("a goal's own state raises risk only when it is actually stuck", () => {
  assert.equal(riskFloor({ ...diagnosedState(), status: "diagnosed" }), "low");
  assert.equal(riskFloor({ ...diagnosedState(), status: "blocked" }), "medium");
  const lowRisk = effectiveClassification({ prompt: classification("T1", "low"), state: diagnosedState() });
  assert.equal(lowRisk.effective.risk, "low", "risk is raised by the goal being blocked, not by its tier");
  const blocked = effectiveClassification({ prompt: classification("T1", "low"), state: { ...diagnosedState(), status: "blocked" } });
  assert.equal(blocked.effective.risk, "medium");
  assert.equal(blocked.effective.complexity, "T3");
});

// ---------------------------------------------------------------------------- handoff

test("a handoff gives the next worker the diagnosis, the secondary finding and the state of the checkout", () => {
  const goal = goalRecord(diagnosedState());
  const handoff = buildHandoffPackage({ goal, workUnit: "How would you implement the proposed fix?", addressedTo: "anthropic/claude-haiku" });
  assert.equal(handoff.objective, "fix idle logout in SaudiGPT");
  assert.equal(handoff.acceptedFindings.length, 1);
  assert.equal(handoff.secondaryFindings.length, 1);
  assert.deepEqual([...handoff.filesChanged], []);
  assert.deepEqual([...handoff.testsRun], []);
  assert.equal(handoff.nextAction, "implementation planning");

  const text = renderHandoff(handoff);
  assert.match(text, /You are continuing BrainGate goal goal-1/);
  assert.match(text, /cold-start splash routing race/);
  assert.match(text, /Do not silently replace one/);
  assert.match(text, /\*not\*[\s\S]*the active cause/);
  assert.match(text, /Dio 401 refresh stub/);
  assert.match(text, /no files have been changed/);
  assert.match(text, /no tests have been run/);
  assert.match(text, /Your current task:\nHow would you implement the proposed fix\?/);
  assert.match(text, /free to inspect the repository yourself/);
});

test("a handoff reports a dispute as a dispute instead of dropping it", () => {
  const state: GoalState = {
    ...diagnosedState(),
    disputedFindings: Object.freeze([{ findingId: "d1", status: "conflicting" as const, claim: "token refresh fragmentation is the root cause", evidence: Object.freeze(["dio_client.dart"]), assertedBy: "anthropic/claude-haiku", conflictsWith: "f1", supersededBy: null, recordedAt: "2026-09-12T01:00:00.000Z" }]),
  };
  const text = renderHandoff(buildHandoffPackage({ goal: goalRecord(state), workUnit: "continue" }));
  assert.match(text, /Disputed — claimed, but not established/);
  assert.match(text, /token refresh fragmentation/);
  assert.match(text, /the evidence is what has to change, not the claim/);
});

test("the handoff is bounded, because a worker reads none of a two-hundred-finding prompt", () => {
  const many = Object.freeze(Array.from({ length: 8 }, (_, index) => ({
    findingId: `f${String(index)}`,
    status: "accepted" as const,
    claim: `finding ${String(index)} ${"detail ".repeat(200)}`,
    evidence: Object.freeze(["a/very/long/evidence/path/that/keeps/going/for/a/while/file.dart:1234"]),
    assertedBy: "operator",
    conflictsWith: null,
    supersededBy: null,
    recordedAt: "2026-09-12T00:00:00.000Z",
  })));
  const text = renderHandoff(buildHandoffPackage({ goal: goalRecord({ ...diagnosedState(), acceptedFindings: many }), workUnit: "continue" }));
  assert.ok(text.length <= MAX_HANDOFF_CHARS + 80, `handoff was ${String(text.length)} characters`);
  assert.match(text, /handoff truncated by BrainGate/);
});

test("the provider-facing goal context carries the layers, and says which session may be resumed", () => {
  const goal = goalRecord({
    ...diagnosedState(),
    providerSessions: Object.freeze([
      { providerId: "anthropic" as const, modelId: "claude-sonnet", sessionId: "sess-sonnet", resumeMode: "unsupported" as const, recordedAt: "2026-09-12T00:00:00.000Z" },
      { providerId: "xai" as const, modelId: "grok-4", sessionId: "sess-grok", resumeMode: "available" as const, recordedAt: "2026-09-12T00:00:00.000Z" },
    ]),
  });
  const turns = Array.from({ length: 9 }, (_, index) => ({ request: `q${String(index)}`, answer: `a${String(index)}` }));
  const context = buildGoalContext({ goal, workUnit: "implement it", recentTurns: turns, evidenceRefs: ["task 1234: results/1234/answer.txt"] });
  assert.equal(context.recentTurns.length, MAX_CONTEXT_TURNS);
  assert.equal(context.recentTurns.at(-1)?.request, "q8", "the newest turn is the one a follow-up refers to");
  assert.equal(context.handoff.workUnit, "implement it");
  assert.deepEqual([...context.evidenceRefs], ["task 1234: results/1234/answer.txt"]);

  const text = renderHandoff(context.handoff);
  assert.match(text, /xai\/grok-4: sess-grok/);
  assert.doesNotMatch(text, /sess-sonnet/, "a session that cannot be resumed must not be advertised as one that can");
});

test("goal context survives a JSON round trip, because that is how it reaches a provider", () => {
  const context = buildGoalContext({ goal: goalRecord(diagnosedState()), workUnit: "continue", recentTurns: [{ request: "q", answer: "a" }] });
  const restored = JSON.parse(JSON.stringify(context)) as typeof context;
  assert.equal(restored.handoff.acceptedFindings[0]?.claim, context.handoff.acceptedFindings[0]?.claim);
  assert.deepEqual([...restored.handoff.secondaryFindings[0]!.evidence], [...context.handoff.secondaryFindings[0]!.evidence]);
});

// ---------------------------------------------------------------------------- native session registry

test("a native session is recorded with an explicit resume mode, never an assumed one", () => {
  const { store } = openStore("sessions");
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "g" });
    store.recordProviderSession({ providerId: "anthropic", modelId: "claude-sonnet", sessionId: "sess-sonnet", resumeMode: "unsupported", goalId: goal.goalId, quotaPool: "claude-subscription" });
    const latest = store.latestSessionFor("anthropic", "claude-sonnet");
    assert.equal(latest?.sessionId, "sess-sonnet");
    // `unsupported` is what makes the next slice honest: nothing may resume this yet.
    assert.equal(latest?.resumeMode, "unsupported");
    assert.equal(store.latestSessionFor("xai", null), null);
    // The reference rides on the goal, so a handoff carries it without a second lookup.
    assert.equal(store.requireGoal(goal.goalId).state.providerSessions.length, 1);
  } finally { store.close(); }
});

test("re-recording the same provider session updates it rather than duplicating it", () => {
  const { store } = openStore("sessions-idempotent");
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "g" });
    store.recordProviderSession({ providerId: "openai", modelId: "gpt-5", sessionId: "s1", resumeMode: "unsupported", goalId: goal.goalId });
    store.recordProviderSession({ providerId: "openai", modelId: "gpt-5", sessionId: "s1", resumeMode: "available", goalId: goal.goalId });
    assert.equal(store.requireGoal(goal.goalId).state.providerSessions.length, 1);
    assert.equal(store.latestSessionFor("openai", "gpt-5")?.resumeMode, "available");
  } finally { store.close(); }
});

test("a session id is never invented and a resume mode is never guessed", () => {
  const { store } = openStore("sessions-invalid");
  try {
    assert.throws(() => store.recordProviderSession({ providerId: "anthropic", sessionId: "  ", resumeMode: "unsupported" }), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GOAL_SESSION_ID_INVALID");
    assert.throws(
      () => store.recordProviderSession({ providerId: "anthropic", sessionId: "s", resumeMode: "probably" as never }),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GOAL_SESSION_RESUME_MODE_INVALID",
    );
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------- the regression scenario

test("turn 2 to a second provider knows the accepted root cause, and turn 3 back on the first is told what changed", () => {
  const { store } = openStore("saudi-scenario");
  try {
    const conversation = store.openConversation();

    // Turn 1 — a diagnosis. The words carry a debugging cue, so this is T2 on its own.
    const goal = store.continueOrCreateGoal({ conversationId: conversation.conversationId, request: "Investigate why SaudiGPT logs the user out when the app is idle" });
    const turnOne = effectiveClassification({ prompt: classification("T2", "medium", ["debugging-cue", "sensitive-domain:auth"]), state: goal.state });
    assert.equal(turnOne.effective.complexity, "T2");
    store.updateGoalState(goal.goalId, {
      status: "diagnosed",
      acceptedFindings: [{ claim: "A cold-start splash routing race causes the apparent logout", evidence: ["apps/mobile/lib/features/splash/presentation/splash_page.dart:41"] }],
      secondaryFindings: [{ claim: "The Dio 401 refresh stub is a latent risk, but not the active root cause", evidence: ["lib/core/network/dio_client.dart:88"] }],
      approvedScope: ["apps/mobile/lib/features/splash/presentation/splash_page.dart"],
      openQuestions: ["regression-test strategy for cold-start routing"],
      nextAction: "implementation planning",
      assertedBy: "anthropic/claude-sonnet",
    });
    store.recordTurn({ conversationId: conversation.conversationId, goalId: goal.goalId, taskId: "task-1", request: "Investigate why SaudiGPT logs the user out when the app is idle", answer: "A cold-start splash routing race...", attributedTo: ["anthropic/claude-sonnet"] });

    // Turn 2 — the literal words classify as a cheap lookup. The goal does not.
    const continued = store.continueOrCreateGoal({ conversationId: conversation.conversationId, request: "How would you implement the proposed fix?" });
    assert.equal(continued.goalId, goal.goalId, "turn 2 continues turn 1's goal");

    const prompt = classification("T1", "low", ["small-question-cue"]);
    const turnTwo = effectiveClassification({ prompt, state: continued.state });
    assert.equal(prompt.complexity, "T1");
    assert.equal(turnTwo.effective.complexity, "T2", "the follow-up must not be routed as an isolated lookup");

    const handoff = buildHandoffPackage({ goal: continued, workUnit: "How would you implement the proposed fix?", addressedTo: "anthropic/claude-haiku" });
    const text = renderHandoff(handoff);
    assert.match(text, /cold-start splash routing race/);
    assert.match(text, /Dio 401 refresh stub/);
    assert.match(text, /\*not\*[\s\S]*the active cause/);
    assert.match(text, /splash_page\.dart/);
    assert.match(text, /no files have been changed/);
    assert.match(text, /no tests have been run/);
    assert.match(text, /implementation planning/);

    // The second worker proposes a different root cause. It is recorded, and it does not win.
    const afterTurnTwo = store.updateGoalState(goal.goalId, {
      acceptedFindings: ["Token refresh fragmentation causes the splash routing to log the user out"],
      assertedBy: "anthropic/claude-haiku",
    });
    assert.equal(afterTurnTwo.state.acceptedFindings.length, 1);
    assert.match(afterTurnTwo.state.acceptedFindings[0]!.claim, /splash routing race/);
    assert.equal(afterTurnTwo.state.disputedFindings.length, 1);

    // Turn 3 — back to the provider that did the diagnosis, which needs the delta.
    store.recordTurn({ conversationId: conversation.conversationId, goalId: goal.goalId, taskId: "task-2", request: "How would you implement the proposed fix?", answer: "Plan: ...", attributedTo: ["anthropic/claude-haiku"] });
    const backToSonnet = buildHandoffPackage({ goal: store.requireGoal(goal.goalId), workUnit: "Go ahead and implement it" });
    const delta = renderHandoff(backToSonnet);
    assert.match(delta, /cold-start splash routing race/);
    assert.match(delta, /Disputed — claimed, but not established/);
    assert.match(delta, /token refresh fragmentation/i);
    assert.match(delta, /asserted by: anthropic\/claude-haiku/);
    assert.match(delta, /no files have been changed/);
    assert.equal(store.recentTurns(conversation.conversationId, 10).length, 2);
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------- fixtures

function diagnosedState(): GoalState {
  return Object.freeze({
    status: "diagnosed" as const,
    acceptedFindings: Object.freeze([Object.freeze({
      findingId: "f1",
      status: "accepted" as const,
      claim: "A cold-start splash routing race causes the apparent logout",
      evidence: Object.freeze(["apps/mobile/lib/features/splash/presentation/splash_page.dart:41"]),
      assertedBy: "anthropic/claude-sonnet",
      conflictsWith: null,
      supersededBy: null,
      recordedAt: "2026-09-12T00:00:00.000Z",
    })]),
    secondaryFindings: Object.freeze([Object.freeze({
      findingId: "f2",
      status: "accepted" as const,
      claim: "The Dio 401 refresh stub is a latent risk, but not the active root cause",
      evidence: Object.freeze(["lib/core/network/dio_client.dart:88"]),
      assertedBy: "anthropic/claude-sonnet",
      conflictsWith: null,
      supersededBy: null,
      recordedAt: "2026-09-12T00:00:00.000Z",
    })]),
    disputedFindings: Object.freeze([]),
    openQuestions: Object.freeze(["regression-test strategy for cold-start routing"]),
    approvedScope: Object.freeze(["apps/mobile/lib/features/splash/presentation/splash_page.dart"]),
    filesChanged: Object.freeze([]),
    testsRun: Object.freeze([]),
    nextAction: "implementation planning",
    providerSessions: Object.freeze([]),
  });
}

function goalRecord(state: GoalState): GoalRecord {
  return Object.freeze({
    goalId: "goal-1",
    conversationId: "conversation-1",
    projectId: "sample",
    workspaceId: null,
    objective: "fix idle logout in SaudiGPT",
    state,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  });
}

// `applyGoalStateUpdate` is exercised directly where the store would only obscure the fold.
test("the fold is usable on its own, so a caller that is not a store can reason about state", () => {
  let counter = 0;
  const next = applyGoalStateUpdate({
    current: diagnosedState(),
    update: { acceptedFindings: ["the splash screen reads AuthInitial before restore resolves"], assertedBy: "anthropic/claude-sonnet" },
    findingId: () => `extra-${String(++counter)}`,
    recordedAt: "2026-09-12T02:00:00.000Z",
  });
  assert.equal(next.acceptedFindings.length, 2);
  assert.equal(next.disputedFindings.length, 0);
});
