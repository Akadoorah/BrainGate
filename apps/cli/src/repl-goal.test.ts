import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRegistry, type RegisteredProject } from "@braingate/core";
import { GoalStore } from "@braingate/goals";
import { initializeDogfoodProject } from "@braingate/dogfood";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import { runRepl, taskIdOf } from "./repl.js";

/**
 * M20's behavioural test: a follow-up continues its goal, across providers.
 *
 * This is the regression for the SaudiGPT dogfood, reproduced end to end through the interactive
 * surface with a deterministic fake runtime. Turn 1 diagnoses. Turn 2 is the eight-word follow-up
 * that used to be classified as an isolated T1 lookup and answered by a cheaper model with a
 * different diagnosis. Turn 3 goes back.
 *
 * Nothing here needs a provider: what is asserted is what BrainGate *told* the worker, which is
 * exactly the part that was missing before this milestone.
 */

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

function snapshot(providerId: "anthropic" | "xai", displayName: string, binary: string): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName,
    binary,
    available: obs(true),
    version: obs("2.1.248"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: false }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    removedBillingOverrides: [],
    warnings: [],
  };
}

/** Answers as whichever role the payload names, the way the real CLIs are asked to. */
class FakeRuntime implements ShadowProcessExecutor {
  readonly calls: ShadowInvocationPlan[] = [];
  readonly payloads: Record<string, unknown>[] = [];
  /**
   * What each request is answered with, keyed by the request text.
   *
   * Keyed rather than sequential on purpose: the plan pass is a provider call of its own for some
   * tiers, so "the first call" is not "the first turn", and a fixture that assumed otherwise would
   * be asserting its own arithmetic instead of the behaviour.
   */
  constructor(private readonly answers: Readonly<Record<string, string>>) {}

  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan; onText?: (text: string) => void }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    const body = input.plan.stdin ?? input.plan.attachmentContent ?? "";
    const payload = JSON.parse(body) as { readonly role?: string; readonly task?: string };
    this.payloads.push(payload as Record<string, unknown>);
    // Each role answers in its own contract, which is what the real CLI is asked for and what the
    // workflow engine validates: a planner returns work, a reviewer returns a verdict. A fake that
    // answered every role the same way would only ever exercise the primary.
    const output = payload.role === "primary"
      ? (payload.task === undefined ? "an answer" : this.answers[payload.task] ?? "an answer")
      : "an approach";
    const work = JSON.stringify(payload.role === "reviewer"
      ? { kind: "review", verdict: "approve", findings: [] }
      : { kind: "work", output });
    // A real provider streams its prose as it writes it, and the terminal shows that rather than the
    // schema-enforced envelope it arrives in. The fake does the same, so what the session records as
    // a turn's answer is the model's own words.
    input.onText?.(output);
    if (input.plan.providerId === "xai") {
      return { spawned: true, exitCode: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: work } }), stderr: "", timedOut: false, durationMs: 6, removedEnvironmentKeys: [] };
    }
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ result: work }), stderr: "", timedOut: false, durationMs: 5, removedEnvironmentKeys: [] };
  }

  /** The goal layers the nth call was given, if it was given any. */
  goalContextOf(index: number): Record<string, unknown> | null {
    const payload = this.payloads[index];
    if (payload === undefined) return null;
    const context = payload.context as { readonly goal?: Record<string, unknown> } | undefined;
    return context?.goal ?? null;
  }

  /** The goal layers of the last call that carried any — the plan pass is not given the run's. */
  lastGoalContext(): Record<string, unknown> | null {
    for (let index = this.payloads.length - 1; index >= 0; index -= 1) {
      const found = this.goalContextOf(index);
      if (found !== null) return found;
    }
    return null;
  }
}

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `braingate-m20-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "splash_page.dart"), "// splash\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  initializeDogfoodProject({ cwd: repo, projectId: label, name: "Sample" });
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const state = resolveOperatorState(env, repo);
  const catalog = new ModelCatalog(state.modelCatalogPath);
  catalog.upsert({
    providerId: "anthropic",
    modelId: "claude-capable",
    quotaPool: "claude-subscription",
    capabilities: { coder: 95, reviewer: 80, judge: 75 },
    speed: "balanced",
    contextCapacity: 200_000,
    writeCapable: true,
    reasoning: 95,
    underlyingFamily: null,
  });
  catalog.upsert({
    providerId: "xai",
    modelId: "grok-fast",
    quotaPool: "grok-subscription",
    capabilities: { coder: 60, reviewer: 55, judge: 50 },
    speed: "fast",
    contextCapacity: 128_000,
    writeCapable: false,
    reasoning: 55,
    underlyingFamily: null,
  });
  return { root, repo, env, project: new ProjectRegistry(home).loadFile(join(repo, ".brain", "project.json")) };
}

function sessionOf(repo: string, env: NodeJS.ProcessEnv, runtime: FakeRuntime, answers: readonly string[]) {
  const remaining = [...answers];
  let out = "";
  let err = "";
  return {
    text: () => `${out}${err}`,
    out: () => out,
    err: () => err,
    run: () => runRepl({
      cwd: repo,
      env,
      // No animation: a redrawn banner puts carriage returns and cursor moves between the lines a
      // test is trying to read, which turns "did this reach the terminal" into a rendering question.
      animate: false,
      colour: false,
      stdout: (t) => { out += t; },
      stderr: (t) => { err += t; },
      ask: async () => remaining.shift() ?? null,
      executor: runtime,
      discoverAll: async () => [snapshot("anthropic", "Claude Code", "claude"), snapshot("xai", "Grok Build", "grok")],
    }),
  };
}

test("a follow-up continues the same goal and the next worker is handed the established state", async () => {
  const f = fixture("continuity");
  const runtime = new FakeRuntime({ "Investigate why the app logs the user out when it is idle": "A cold-start splash routing race causes the apparent logout." });
  const session = sessionOf(f.repo, f.env, runtime, [
    "Investigate why the app logs the user out when it is idle",
    "y",
    "How would you implement the proposed fix?",
    "y",
  ]);
  assert.equal(await session.run(), 0);

  // The diagnosis was executed and recorded as the goal's first turn.
  const store = new GoalStore(f.project);
  try {
    const conversation = store.activeConversation();
    assert.ok(conversation !== null, "the session must have opened a conversation");
    const goal = store.activeGoal(conversation.conversationId);
    assert.ok(goal !== null, "the first request must have started a goal");
    const turns = store.recentTurns(conversation.conversationId, 10);
    assert.equal(turns.length, 2, "both turns must be on the timeline, not only in the expiring thread");
    assert.equal(turns[0]?.goalId, goal.goalId);
    assert.equal(turns[1]?.goalId, goal.goalId);
    assert.ok(turns[0]!.answer.includes("cold-start splash routing race"), "the answer is the timeline's record");
    assert.deepEqual([...turns[0]!.attributedTo], ["anthropic/claude-capable"], "a turn says which provider answered it");
  } finally { store.close(); }

  // The second worker's payload carried the goal: the earlier turn, and the state derived from it.
  const goalContext = runtime.lastGoalContext();
  assert.ok(goalContext !== null, "a follow-up must reach the provider with the goal attached");
  const handoff = goalContext.handoff as { readonly goalId: string; readonly workUnit: string; readonly status: string };
  assert.equal(handoff.workUnit, "How would you implement the proposed fix?");
  assert.equal(handoff.status, "diagnosed", "the goal's status is what the follow-up inherits");
  const turns = goalContext.recentTurns as readonly { readonly request: string; readonly answer: string }[];
  assert.ok(turns.some((turn) => turn.answer.includes("cold-start splash routing race")), "the diagnosis must travel with the follow-up");
});

test("a short follow-up is planned as continuing its goal, not as an isolated lookup", async () => {
  const f = fixture("inherited-tier");
  const runtime = new FakeRuntime({ "Investigate why the app logs the user out when it is idle": "The splash screen reads AuthInitial before the session is restored." });
  const session = sessionOf(f.repo, f.env, runtime, [
    "Investigate why the app logs the user out when it is idle",
    "y",
    "Apply it.",
    "n",
  ]);
  assert.equal(await session.run(), 0);
  const text = session.text();
  assert.match(text, /continues goal/, "the operator must see that this request continues a goal");
  assert.match(text, /continues goal [0-9a-f]+ · diagnosed · raised to T3 by this goal/, "the plan must route the follow-up at the goal's tier, not the sentence's");
  assert.match(text, /read-only · T3\/low/, "and the plan line must show the tier the run will use");
  // The second plan was declined, so nothing was spent on it: the gate still holds.
  assert.match(text, /Skipped\. Nothing was spent\./);
});

test("a task records the goal it is a work unit of, so a goal has its own history", async () => {
  const f = fixture("task-link");
  const runtime = new FakeRuntime({ "Explain why the session is lost on cold start": "first answer" });
  const session = sessionOf(f.repo, f.env, runtime, ["Explain why the session is lost on cold start", "y"]);
  assert.equal(await session.run(), 0);

  const store = new GoalStore(f.project);
  try {
    const goal = store.activeGoal();
    assert.ok(goal !== null);
    const { TaskLedger } = await import("@braingate/core");
    const ledger = new TaskLedger(f.project);
    try {
      const tasks = ledger.listTasksForGoal(goal.goalId);
      assert.equal(tasks.length, 1, "the run's task must be linked to the goal it served");
      assert.equal(tasks[0]?.conversationId, goal.conversationId);
      assert.equal(tasks[0]?.complexity !== null, true);
    } finally { ledger.close(); }
  } finally { store.close(); }
});

test("/new sets the current goal aside, and the next request starts a different one", async () => {
  const f = fixture("new-goal");
  const runtime = new FakeRuntime({ "Investigate the idle logout": "first answer", "Now something completely unrelated": "second answer" });
  const session = sessionOf(f.repo, f.env, runtime, [
    "Investigate the idle logout",
    "y",
    "/new",
    "Now something completely unrelated",
    "y",
  ]);
  assert.equal(await session.run(), 0);

  const store = new GoalStore(f.project);
  try {
    const conversation = store.activeConversation();
    assert.ok(conversation !== null);
    const goals = store.listGoals(conversation.conversationId);
    assert.equal(goals.length, 2, "/new must start a second goal rather than continue the first");
    assert.equal(goals[0]?.state.status, "abandoned");
    assert.ok(store.activeGoal(conversation.conversationId)?.goalId === goals[1]?.goalId);
  } finally { store.close(); }
});

test("/goal prints the current goal without spending anything", async () => {
  const f = fixture("goal-command");
  const runtime = new FakeRuntime({ "Investigate the idle logout": "an answer" });
  const session = sessionOf(f.repo, f.env, runtime, ["Investigate the idle logout", "y", "/goal", "/exit"]);
  assert.equal(await session.run(), 0);
  assert.match(session.text(), /You are continuing BrainGate goal/);
  assert.match(session.text(), /Next action on record: Investigate the idle logout/);
  // /goal is a read. The turn reached a provider exactly once — the executed primary, since planning
  // is a routing decision and spends nothing — and printing the goal added no call at all: what it
  // shows is the state the store recorded, not a fresh question put to a model.
  const roles = runtime.payloads.map((payload) => payload.role);
  assert.deepEqual(roles, ["primary"], `expected the one executed primary call, got ${roles.join(",")}`);
});

test("a failed run is not recorded as a turn, so a follow-up cannot inherit a failure as its premise", async () => {
  const f = fixture("failed-turn");
  const runtime: ShadowProcessExecutor = {
    async run(): Promise<ShadowProcessResult> {
      return { spawned: true, exitCode: 1, stdout: "", stderr: "provider refused", timedOut: false, durationMs: 3, removedEnvironmentKeys: [] };
    },
  };
  let out = "";
  await runRepl({
    cwd: f.repo,
    env: f.env,
    animate: false,
    colour: false,
    stdout: (t) => { out += t; },
    stderr: (t) => { out += t; },
    ask: (() => { const answers = ["Investigate the idle logout", "y"]; return async () => answers.shift() ?? null; })(),
    executor: runtime,
    discoverAll: async () => [snapshot("anthropic", "Claude Code", "claude")],
  });
  const store = new GoalStore(f.project);
  try {
    const conversation = store.activeConversation();
    assert.ok(conversation !== null);
    assert.equal(store.recentTurns(conversation.conversationId, 5).length, 0);
  } finally { store.close(); }
});

test("task ids are read from a result, and a result that recorded nothing yields none", () => {
  assert.equal(taskIdOf({ taskId: "abc" }), "abc");
  assert.equal(taskIdOf({}), null);
  assert.equal(taskIdOf(null), null);
  assert.equal(taskIdOf("abc"), null);
});
