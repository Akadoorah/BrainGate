import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ProjectRegistry,
  executionScopeFor,
} from "@braingate/core";
import { initializeDogfoodProject } from "@braingate/dogfood";
import { TaskLedger } from "@braingate/core";
import { GoalStore } from "@braingate/goals";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import { runDogfoodCli } from "./dogfood-cli.js";
import { routingContinuity } from "./repl.js";

/**
 * The continuity half of automatic routing, at both ends of the wire.
 *
 * The router's own matrix (`packages/router/src/automatic-routing.test.ts`) proves what a warm
 * session is *worth*. It cannot prove that anything ever tells the router about one. That is the
 * gap this file closes: the goal store's answer to "who already holds this goal", and the real
 * `dogfood ask plan` path carrying it into the routing decision the operator is shown.
 *
 * Both are cheap to get wrong in the same direction — a signal produced but never delivered looks
 * exactly like a signal that was never produced, and the run still succeeds.
 */

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

function modelCatalogEntry(state: ReturnType<typeof resolveOperatorState>, providerId: "anthropic" | "xai" | "google", modelId: string, coder: number, reasoning: number, planner = 0): void {
  new ModelCatalog(state.modelCatalogPath).upsert({
    providerId,
    modelId,
    quotaPool: providerId === "anthropic" ? "claude-subscription" : providerId === "xai" ? "grok-subscription" : "antigravity-subscription",
    capabilities: { coder, reviewer: 70, judge: 60, ...(planner === 0 ? {} : { planner }) },
    speed: "balanced",
    contextCapacity: 200_000,
    writeCapable: true,
    reasoning,
    underlyingFamily: null,
  });
}

function fixture(label: string): { readonly repo: string; readonly home: string; readonly env: Record<string, string>; readonly state: ReturnType<typeof resolveOperatorState> } {
  const root = mkdtempSync(join(tmpdir(), `braingate-routing-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "app.txt"), "before\n");
  git(repo, ["add", "app.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  initializeDogfoodProject({ cwd: repo, projectId: label, name: "Routing" });
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const state = resolveOperatorState(env, repo);
  // Two models on one subscription, eight capability points apart: close enough that a preference
  // between them is visible in the decision, far enough that the decision is not a coin toss.
  modelCatalogEntry(state, "anthropic", "claude-strong", 96, 92);
  modelCatalogEntry(state, "anthropic", "claude-warm", 88, 84);
  // A second subscription, weaker at this work than either Claude model: it can only win a decision
  // on merit, by being the worker that already holds the goal.
  modelCatalogEntry(state, "xai", "grok-warm", 70, 80);
  // And one that cannot do the work at any tier. Warmth is a preference between candidates, so the
  // model that must never win is the one no amount of continuity may promote.
  modelCatalogEntry(state, "anthropic", "claude-lite", 20, 20);
  return { repo, home, env, state };
}

function snapshot(providerId: "anthropic" | "xai" | "google" = "anthropic"): ProviderSnapshot {
  const observedAt = "2026-09-14T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName: providerId === "anthropic" ? "Claude Code" : providerId === "xai" ? "Grok CLI" : "Antigravity",
    binary: providerId === "anthropic" ? "claude" : providerId === "xai" ? "grok" : "agy",
    available: obs(true),
    version: obs(providerId === "anthropic" ? "2.1.270" : providerId === "xai" ? "1.0.24" : "1.2.2"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    removedBillingOverrides: [],
    warnings: [],
  };
}

function io(): { stdout: (text: string) => void; stderr: (text: string) => void; out: () => string; err: () => string } {
  let stdout = "";
  const stderr: string[] = [];
  return { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr.push(text); }, out: () => stdout, err: () => stderr.join("") };
}

/** The primary worker the plan the operator approves names, from the plan's own summary line. */
function primaryOf(plan: unknown): string {
  const parsed = plan as { readonly summary?: unknown };
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const match = summary.match(/primary=([^\s·]+)/);
  assert.ok(match !== null, `the plan summary names a primary worker: ${summary}`);
  return match[1]!;
}

/** The plan the operator would be shown, from the real CLI path, with continuity as the only change. */
async function planFor(f: ReturnType<typeof fixture>, task: string, options: { readonly continuity?: NonNullable<Parameters<typeof runDogfoodCli>[1]>["continuity"]; readonly providers?: readonly ProviderSnapshot[] } = {}): Promise<unknown> {
  const out = io();
  const result = await runDogfoodCli(["dogfood", "ask", "plan", "--task", task, "--json"], {
    cwd: f.repo,
    env: f.env,
    discoverAll: async () => [...(options.providers ?? [snapshot()])],
    stdout: out.stdout,
    stderr: out.stderr,
    ...(options.continuity === undefined ? {} : { continuity: options.continuity }),
  });
  assert.equal(result.exitCode, 0);
  return result.data;
}

test("the goal's own sessions decide which workers are warm, under the request's envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-routing-goal-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const registered = new ProjectRegistry(join(root, "home")).register({ projectId: "warm" as never, name: "Warm", repositories: [repo] });
  const store = new GoalStore(executionScopeFor(registered, repo).project);
  try {
    const conversation = store.openConversation();
    const goal = store.createGoal({ conversationId: conversation.conversationId, objective: "fix the idle logout" });
    // Two sessions for one goal, created under different boundaries: this is the case the whole
    // envelope rule exists for, and it is the case a "newest session wins" shortcut gets wrong.
    store.recordProviderSession({
      providerId: "anthropic", modelId: "claude-strong", sessionId: "read-session", resumeMode: "available",
      goalId: goal.goalId, conversationId: conversation.conversationId,
      envelope: { intent: "read", policy: "direct", role: "primary", readOnlyInstructions: true, permissionMode: "default" },
    });
    store.recordProviderSession({
      providerId: "xai", modelId: "grok-warm", sessionId: "write-session", resumeMode: "available",
      goalId: goal.goalId, conversationId: conversation.conversationId,
      envelope: { intent: "write", policy: "direct", role: "primary", readOnlyInstructions: false, permissionMode: "acceptEdits" },
    });
    store.recordTurn({ conversationId: conversation.conversationId, goalId: goal.goalId, request: "where is the theme?", answer: "in app.txt", attributedTo: ["anthropic/claude-strong"] });

    const read = routingContinuity({ goals: store, goalId: goal.goalId, conversationId: conversation.conversationId, intent: "read", policy: "direct" });
    assert.deepEqual(read?.warm, [{ providerId: "anthropic", modelId: "claude-strong" }], "a read request is warm for the read session and cold for the write one");
    assert.deepEqual(read?.previous, { providerId: "anthropic", modelId: "claude-strong" }, "the previous worker is who answered the last turn");

    const write = routingContinuity({ goals: store, goalId: goal.goalId, conversationId: conversation.conversationId, intent: "write", policy: "direct" });
    assert.deepEqual(write?.warm, [{ providerId: "xai", modelId: "grok-warm" }], "a write is not warm for a session that was told not to modify anything");

    const otherPolicy = routingContinuity({ goals: store, goalId: goal.goalId, conversationId: conversation.conversationId, intent: "read", policy: "worktree" });
    assert.equal(otherPolicy?.warm.length, 0, "a policy change invalidates a session created under another boundary");

    const otherGoal = store.createGoal({ conversationId: conversation.conversationId, objective: "something else" });
    assert.equal(
      routingContinuity({ goals: store, goalId: otherGoal.goalId, conversationId: conversation.conversationId, intent: "read", policy: "direct" }),
      undefined,
      "a goal with no sessions and no turns supplies no continuity at all",
    );
  } finally {
    store.close();
  }
});

test("a warm worker wins the plan the operator approves when the alternative is only marginally better", async () => {
  const f = fixture("warm-plan");
  const task = "Where is the theme config read from?";
  const cold = primaryOf(await planFor(f, task));
  const warm = primaryOf(await planFor(f, task, { continuity: { warm: [{ providerId: "anthropic", modelId: "claude-warm" }] } }));
  assert.equal(cold, "anthropic/claude-strong", "with nothing warm, the stronger model is the one worth spending on");
  assert.equal(warm, "anthropic/claude-warm", "the worker that already holds this goal keeps it, and the plan says so");

  const previous = primaryOf(await planFor(f, task, { continuity: { warm: [{ providerId: "anthropic", modelId: "claude-warm" }], previous: { providerId: "anthropic", modelId: "claude-warm" } } }));
  assert.equal(previous, "anthropic/claude-warm", "the model that ran the last turn is not switched away from for a marginal gain");

  // A preference, not a floor: a warm model that cannot do the work is still not routed to, and the
  // plan the operator approves says which model it chose rather than silently promoting one.
  const ineligible = primaryOf(await planFor(f, task, { continuity: { warm: [{ providerId: "anthropic", modelId: "claude-lite" }] } }));
  assert.notEqual(ineligible, "anthropic/claude-lite", "continuity never promotes a model below the capability floor");
});

test("an automatic DIRECT turn can reach a second subscription, not only the reference provider", async () => {
  const f = fixture("second-provider");
  const task = "Where is the theme config read from?";
  const providers = [snapshot("anthropic"), snapshot("xai")];
  // Grok is the weaker worker here, so it only wins by already holding the goal — which is the point:
  // it is a candidate at all. Before this, an automatic DIRECT turn pushed every provider but the
  // reference one out of the route by name, so a goal whose warm worker lived on another
  // subscription could not continue with it, and an exhausted reference pool left no one at all.
  const cold = primaryOf(await planFor(f, task, { providers }));
  assert.match(cold, /^anthropic\//, "on merit, the stronger subscription still wins");

  const warm = primaryOf(await planFor(f, task, { providers, continuity: { warm: [{ providerId: "xai", modelId: "grok-warm" }] } }));
  assert.equal(warm, "xai/grok-warm", "the warm worker on the second subscription continues the goal");
});

/**
 * A provider CLI that records what it was asked to do and answers in the contracted shape.
 *
 * Per provider, because the shapes genuinely differ: Claude returns its contract inside a JSON
 * envelope, Grok streams the contract itself. A fake that answered one shape to both would pass
 * whichever single-provider plan it was handed and prove nothing about a plan that spends more.
 */
class FakeShadowExecutor implements ShadowProcessExecutor {
  readonly calls: ShadowInvocationPlan[] = [];
  async run(input: { readonly plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    const role = (input.plan as unknown as { readonly payload?: { readonly role?: string } }).payload?.role ?? "primary";
    const contract = role === "reviewer"
      ? { kind: "review", verdict: "approve", findings: [] }
      : role === "judge"
        ? { kind: "judge", verdict: "approve", rationale: "sound", findings: [] }
        : { kind: "work", output: "the theme is in src/theme.ts" };
    const body = JSON.stringify(contract);
    const providerId = (input.plan as unknown as { readonly providerId?: string }).providerId ?? "anthropic";
    return {
      spawned: true,
      exitCode: 0,
      stdout: providerId === "anthropic" ? JSON.stringify({ result: body }) : body,
      stderr: "",
      timedOut: false,
      durationMs: 4,
      removedEnvironmentKeys: [],
    };
  }
}

test("the run executes the worker the plan named, on whichever subscription it is", async () => {
  const f = fixture("run-agrees");
  const task = "Where is the theme config read from?";
  const providers = [snapshot("anthropic"), snapshot("xai")];
  const continuity = { warm: [{ providerId: "xai", modelId: "grok-warm" }] };
  const planned = primaryOf(await planFor(f, task, { providers, continuity }));
  assert.equal(planned, "xai/grok-warm", "the plan names the warm worker on the second subscription");

  const executor = new FakeShadowExecutor();
  const out = io();
  const result = await runDogfoodCli(["dogfood", "ask", "run", "--task", task, "--policy", "direct", "--execute", "--json"], {
    cwd: f.repo,
    env: f.env,
    discoverAll: async () => [...providers],
    executor,
    stdout: out.stdout,
    stderr: out.stderr,
    continuity,
  });
  assert.equal(result.exitCode, 0, `${out.out()}\n${out.err()}`);

  // What actually ran, from the ledger rather than from the screen: the plan and the run have
  // separate routing calls, and the failure this test exists for is the one where they disagree —
  // the plan advertising a worker the run then declines to spend.
  const registry = new ProjectRegistry(f.home);
  const project = executionScopeFor(registry.loadFile(join(f.repo, ".brain", "project.json")), f.repo).project;
  const ledger = new TaskLedger(project);
  try {
    const taskId = ledger.listTasks()[0]!.taskId;
    const brief = ledger.receipt(taskId).events.find((event) => event.kind === "task.brief");
    const route = (brief?.payload as { readonly route?: readonly { readonly role: string; readonly providerId: string; readonly modelId: string; readonly selectedReasons?: readonly string[] }[] } | undefined)?.route ?? [];
    const primary = route.find((role) => role.role === "coder" || role.role === "primary");
    assert.equal(`${String(primary?.providerId)}/${String(primary?.modelId)}`, planned, "the run's own route record names the worker the plan named");
    assert.ok(
      (primary?.selectedReasons ?? []).includes("continuity:warm-session"),
      `the record says why this worker won: ${String(primary?.selectedReasons?.join(", "))}`,
    );
    assert.deepEqual(executor.calls.length, 1, "one worker ran");
  } finally {
    ledger.close();
  }
});

test("a role that cannot run the policy is not named, however good it is at that role", async () => {
  const f = fixture("policy-role");
  // The best planner on this machine is Antigravity (planner 98) and it cannot run a DIRECT
  // invocation at all. The router used to choose it for the planner role anyway — the gate reached
  // the primary and nothing else — and the invocation then refused it, so the whole plan failed with
  // SHADOW_NATIVE_HARNESS_UNSUPPORTED before a single provider was called.
  modelCatalogEntry(f.state, "google", "gemini-planner", 40, 90, 98);
  modelCatalogEntry(f.state, "anthropic", "claude-strong", 96, 92, 90);
  const providers = [snapshot("anthropic"), snapshot("google")];
  const task = "Trace how session expiry is checked across the request path, find the root cause of the logout race, and propose a minimal fix.";

  const executor = new FakeShadowExecutor();
  const out = io();
  const result = await runDogfoodCli(["dogfood", "ask", "run", "--task", task, "--policy", "direct", "--execute", "--json"], {
    cwd: f.repo,
    env: f.env,
    discoverAll: async () => [...providers],
    executor,
    stdout: out.stdout,
    stderr: out.stderr,
  });
  assert.equal(result.exitCode, 0, `${out.out()}\n${out.err()}`);

  const registry = new ProjectRegistry(f.home);
  const project = executionScopeFor(registry.loadFile(join(f.repo, ".brain", "project.json")), f.repo).project;
  const ledger = new TaskLedger(project);
  try {
    const brief = ledger.receipt(ledger.listTasks()[0]!.taskId).events.find((event) => event.kind === "task.brief");
    const route = (brief?.payload as { readonly route?: readonly { readonly role: string; readonly providerId: string; readonly rejected?: readonly { readonly providerId: string; readonly reasons: readonly string[] }[] }[] } | undefined)?.route ?? [];
    assert.ok(route.length > 0, "the run recorded its routes");
    for (const role of route) {
      assert.notEqual(role.providerId, "google", `${role.role} must not be routed to a provider that cannot run the policy`);
      const google = role.rejected?.find((rejection) => rejection.providerId === "google");
      if (google === undefined) continue;
      assert.ok(
        google.reasons.includes("policy-not-supported:direct"),
        `${role.role} rejects Antigravity for the policy, not for something incidental: ${google.reasons.join(", ")}`,
      );
    }
    // And the planner that ran is the one the policy reaches.
    const planner = route.find((role) => role.role === "planner");
    if (planner !== undefined) assert.equal(planner.providerId, "anthropic");
  } finally {
    ledger.close();
  }
});
