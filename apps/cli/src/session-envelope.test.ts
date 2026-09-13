import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore, sessionEnvelopeFor, sessionEnvelopeReason } from "@braingate/goals";
import { ProjectRegistry, executionScopeFor, type ExecutionProject } from "@braingate/core";
import { createNativeSessionResolver } from "./worker-commands.js";

/**
 * Native sessions are execution-envelope specific.
 *
 * The dogfood failure this exists for: a Sonnet session created under "Analyze only; do not modify
 * files" was resumed for a write, and Claude refused — twice, deterministically — because the
 * standing instruction it was created with is part of what that session is. Continuity is therefore
 * per envelope, and a worker may hold more than one session for one goal.
 */

function project(label: string): ExecutionProject {
  const root = mkdtempSync(join(tmpdir(), `braingate-envelope-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const registered = new ProjectRegistry(join(root, "home")).register({ projectId: label as never, name: label, repositories: [repo] });
  return executionScopeFor(registered, repo).project;
}

const ENVELOPE = { intent: "read" as const, policy: "direct", role: "primary" };
const readEnvelope = sessionEnvelopeFor({ ...ENVELOPE, providerId: "anthropic" });
const writeEnvelope = sessionEnvelopeFor({ ...ENVELOPE, intent: "write", providerId: "anthropic" });

test("the envelope records what the session was created for", () => {
  assert.deepEqual(readEnvelope, { intent: "read", policy: "direct", role: "primary", readOnlyInstructions: true, permissionMode: "default" });
  assert.deepEqual(writeEnvelope, { intent: "write", policy: "direct", role: "primary", readOnlyInstructions: false, permissionMode: "acceptEdits" });
});

test("compatibility is one explicit rule, not an inference at each call site", () => {
  assert.equal(sessionEnvelopeReason(readEnvelope, readEnvelope), null, "read → read");
  assert.equal(sessionEnvelopeReason(writeEnvelope, writeEnvelope), null, "write → write");
  assert.equal(sessionEnvelopeReason(readEnvelope, writeEnvelope), "envelope-intent-changed", "read → write is refused");
  assert.equal(sessionEnvelopeReason(writeEnvelope, readEnvelope), "envelope-intent-changed", "write → read is refused too, in both directions");
  assert.equal(sessionEnvelopeReason(readEnvelope, { ...readEnvelope, policy: "worktree" }), "envelope-policy-changed");
  assert.equal(sessionEnvelopeReason(readEnvelope, { ...readEnvelope, role: "reviewer" }), "envelope-role-changed");
  assert.equal(sessionEnvelopeReason(null, writeEnvelope), "envelope-intent-changed", "an unrecorded envelope is never resumed for a write");
  assert.equal(sessionEnvelopeReason(null, readEnvelope), null, "and is still usable for a read");
});

/** A resolver over one store, with the intent and policy a run would have. */
function resolver(store: GoalStore, goalId: string, intent: "read" | "write") {
  return createNativeSessionResolver({
    goals: store,
    goal: () => store.getGoal(goalId) ?? null,
    conversationId: () => store.activeConversation()?.conversationId ?? null,
    freshRequested: () => false,
    consumeFresh: () => { /* nothing armed */ },
    probedPinning: () => true,
    runtimeVersion: () => "2.1.269",
    workspace: () => "/w",
    intent: () => intent,
    policy: () => "direct",
    onResolved: () => { /* the decision is what these tests read */ },
  });
}

const request = (task: string, context: unknown = { goal: { handoff: "the goal handoff" } }) => ({
  role: "primary", phase: "initial",
  model: { providerId: "anthropic", modelId: "claude-sonnet", quotaPool: "claude-subscription" },
  task, context,
});

test("G/H/I/L: the newest *compatible* session is the one that resumes", async () => {
  const store = new GoalStore(project("compat"));
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "make a harmless README change" });

    // Turn 1: a read session, created the way a read run creates one.
    const readResolver = resolver(store, goal.goalId, "read");
    const first = await readResolver(request("which file is safe?"));
    assert.equal(first?.decision.kind, "fresh");
    const readSessionId = first!.decision.sessionId!;

    // Turn 2: the same worker, same goal, same workspace, same envelope → resumed.
    const again = await resolver(store, goal.goalId, "read")(request("and why?"));
    assert.equal(again?.decision.kind, "resumed");
    assert.equal(again?.decision.sessionId, readSessionId, "read resumes the read session");

    // Turn 3: a write under the same goal. The read session must not be resumed.
    const writeResolver = resolver(store, goal.goalId, "write");
    const write = await writeResolver(request("Apply the agreed harmless comment-only change. Do not commit."));
    assert.equal(write?.decision.kind, "fresh", "a read-only session is not resumed for a write");
    assert.equal(write?.decision.reason, "envelope-intent-changed");
    assert.notEqual(write?.decision.sessionId, readSessionId, "and the write gets its own session");
    const writeSessionId = write!.decision.sessionId!;

    // Both sessions exist for one goal: the read one is not overwritten or deleted.
    const sessions = store.listProviderSessions();
    assert.equal(sessions.length, 2, "one worker, one goal, two sessions");
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    assert.equal(byId.get(readSessionId)?.envelope?.intent, "read");
    assert.equal(byId.get(writeSessionId)?.envelope?.intent, "write");

    // Turn 4: another write resumes the write session, not the read one.
    const secondWrite = await resolver(store, goal.goalId, "write")(request("now the same for the other line"));
    assert.equal(secondWrite?.decision.kind, "resumed");
    assert.equal(secondWrite?.decision.sessionId, writeSessionId);

    // Turn 5: a read again resumes the read session, which was never lost.
    const readAgain = await resolver(store, goal.goalId, "read")(request("what changed?"));
    assert.equal(readAgain?.decision.kind, "resumed");
    assert.equal(readAgain?.decision.sessionId, readSessionId);
  } finally { store.close(); }
});

test("I/K: a fresh write session is handed the goal handoff, because the session cannot carry it", async () => {
  const store = new GoalStore(project("handoff"));
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "make a harmless README change" });
    const firstRead = await resolver(store, goal.goalId, "read")(request("which file is safe?"));
    assert.equal(firstRead?.decision.kind, "fresh");

    // The write run's context still carries the goal layer — including the handoff — so the new
    // session knows what the previous worker established without the operator repeating it.
    const resolved = await resolver(store, goal.goalId, "write")(request("Apply it.", { goal: { handoff: "Sonnet recommended README.md; Haiku verified it." } }));
    assert.equal(resolved?.decision.kind, "fresh");
    assert.match(resolved?.note ?? "", /read-only request/, "and the reason is said in the operator's terms");
  } finally { store.close(); }
});

test("M: the goal survives every native-session change", async () => {
  const store = new GoalStore(project("goal-survives"));
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "make a harmless README change" });
    await resolver(store, goal.goalId, "read")(request("which file is safe?"));
    await resolver(store, goal.goalId, "write")(request("Apply it."));
    await resolver(store, goal.goalId, "read")(request("what changed?"));
    assert.equal(store.activeGoal()?.goalId, goal.goalId, "same goal throughout");
    assert.equal(store.getGoal(goal.goalId)?.workspaceId, store.getGoal(goal.goalId)?.workspaceId);
  } finally { store.close(); }
});
