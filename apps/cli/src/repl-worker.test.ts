import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ProjectRegistry,
  checkoutRootOf,
  type RegisteredProject,
  type ExecutionProject,
  executionScopeFor,
} from "@braingate/core";
import { GoalStore } from "@braingate/goals";
import { initializeDogfoodProject } from "@braingate/dogfood";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import { runRepl } from "./repl.js";
import { createPromptInput, PASTE_END, PASTE_START } from "./prompt-input.js";

/**
 * Execution state is workspace-scoped: the fixture's own directory is a workspace like any other.
 * A test that builds a project through this registry is asking for that directory's execution state,
 * which is exactly what `executionScopeFor` resolves for a real command.
 */
function workspace(project: RegisteredProject): ExecutionProject {
  return executionScopeFor(project, project.repositories[0]!).project;
}


/**
 * M20.2 through the interactive surface: switching workers without losing the goal.
 *
 * Every runtime here is a fake that behaves like a *CLI*, not like a model — it records the argv it
 * was given and answers whatever contract it was asked for. That is deliberate: what these tests
 * assert is what BrainGate did about sessions and handoffs, which is the part that was missing, and
 * none of it needs a subscription to check.
 */

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

function snapshot(providerId: "anthropic" | "xai" | "openai" | "google" | "github-copilot", displayName: string, binary: string): ProviderSnapshot {
  const observedAt = "2026-09-13T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName,
    binary,
    available: obs(true),
    version: obs("2.1.269"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: false }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    removedBillingOverrides: [],
    warnings: [],
  };
}

interface Recorded {
  readonly providerId: string;
  /** The model this CLI was told to use, read from its own argv. */
  readonly modelId: string | null;
  readonly role: string;
  readonly task: string;
  readonly args: readonly string[];
  readonly context: Record<string, unknown>;
  sessionIdArg: string | null;
  resumeArg: string | null;
  noPersistence: boolean;
}

/**
 * A CLI that honours the session flags it is given, the way the real one does.
 *
 * It records `--session-id` and `--resume` separately rather than as one blob, because "which flag
 * was passed" is the entire question: pinning an id and resuming one are different acts, and a fake
 * that could not tell them apart would pass whichever implementation it was given.
 */
/** The session a run was told to continue, in whichever shape its CLI says it. */
function continuedSessionId(providerId: string, args: readonly string[]): string | null {
  const flag = args.indexOf("--resume");
  if (flag >= 0) return args[flag + 1] ?? null;
  if (providerId === "openai" && args[0] === "exec" && args[1] === "resume") {
    return args.find((argument) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(argument)) ?? null;
  }
  const conversation = args.indexOf("--conversation");
  if (conversation >= 0) return args[conversation + 1] ?? null;
  return null;
}

/** The last complete JSON object in a text, which is how a brief travels when it rides in argv. */
function lastObjectIn(text: string): string | null {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  for (let start = text.indexOf("{"); start >= 0 && start < end; start = text.indexOf("{", start + 1)) {
    try { JSON.parse(text.slice(start, end + 1)); return text.slice(start, end + 1); } catch { /* not this one */ }
  }
  return null;
}

class FakeCli implements ShadowProcessExecutor {
  readonly calls: Recorded[] = [];
  constructor(private readonly answers: Readonly<Record<string, string>> = {}) {}

  async run(input: { project: ExecutionProject; plan: ShadowInvocationPlan; onText?: (text: string) => void }): Promise<ShadowProcessResult> {
    // Where the brief arrives depends on the provider's own invocation: Claude and Codex read it
    // from stdin, a staged Grok run from a file, and a DIRECT Grok run in the `-p` argument, because
    // that CLI takes its prompt as a flag value and has no stdin prompt mode. The fake reads all
    // three so a scenario can switch providers without the fixture deciding which CLI it is.
    const stdinBody = input.plan.stdin ?? input.plan.attachmentContent ?? "";
    // `-p <prompt>` for Grok, `-p=<prompt>` for Antigravity: the attached form is one argv element,
    // and reading the element after a flag that is not there would silently take the first argument.
    const inlineIndex = input.plan.args.indexOf("-p");
    const attached = input.plan.args.find((argument) => argument.startsWith("-p="));
    const promptArg = (inlineIndex >= 0 ? input.plan.args[inlineIndex + 1] : undefined) ?? attached?.slice(3) ?? "";
    const source = stdinBody.trim().startsWith("{") ? stdinBody : promptArg;
    const payload = JSON.parse(lastObjectIn(source) ?? "{}") as { readonly role?: string; readonly task?: string; readonly context?: Record<string, unknown> };
    const args = [...input.plan.args];
    const at = (flag: string): string | null => {
      const index = args.indexOf(flag);
      return index < 0 ? null : (args[index + 1] ?? null);
    };
    this.calls.push({
      providerId: input.plan.providerId,
      modelId: at("--model"),
      role: payload.role ?? "unknown",
      task: payload.task ?? "",
      args,
      context: payload.context ?? {},
      // Each CLI is told to continue a session in its own way: a `--resume` flag for Claude and
      // Grok, a `resume` subcommand for Codex, `--conversation` for Antigravity. A fake that knew
      // only the first would report "nothing was resumed" for a run that resumed correctly.
      sessionIdArg: at("--session-id"),
      resumeArg: continuedSessionId(input.plan.providerId, args),
      noPersistence: args.includes("--no-session-persistence"),
    });

    const role = payload.role ?? "primary";
    const output = role === "primary"
      ? (this.answers[payload.task ?? ""] ?? `answer from ${input.plan.providerId}/${input.plan.modelId}`)
      : "an approach";
    const work = JSON.stringify(role === "reviewer"
      ? { kind: "review", verdict: "approve", findings: [] }
      : { kind: "work", output });
    input.onText?.(output);
    // Each CLI answers in its own envelope, because BrainGate reads each one's own: a fake that
    // spoke Claude's shape for every provider would prove nothing about the adapters.
    if (input.plan.providerId === "openai") {
      const threadId = this.#threadIdFor(input.plan.args);
      const events = [
        JSON.stringify({ type: "thread.started", thread_id: threadId }),
        JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: work } }),
      ].join("\n");
      return { spawned: true, exitCode: 0, stdout: events, stderr: "", timedOut: false, durationMs: 5, removedEnvironmentKeys: [] };
    }
    if (input.plan.providerId === "google") {
      const conversationId = this.#conversationIdFor(input.plan.args);
      return {
        spawned: true, exitCode: 0,
        stdout: JSON.stringify({ conversation_id: conversationId, status: "SUCCESS", response: work, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } }),
        stderr: "", timedOut: false, durationMs: 5, removedEnvironmentKeys: [],
      };
    }
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ result: work }), stderr: "", timedOut: false, durationMs: 5, removedEnvironmentKeys: [] };
  }

  /**
   * The id a Codex-shaped run reports, honouring a resume the way the real CLI does.
   *
   * A resumed run echoes the id it was given; a fresh one mints a new one. That is the whole
   * behaviour BrainGate has to be right about, so the fake is built to make getting it wrong visible.
   */
  #threadIdFor(args: readonly string[]): string {
    const resumed = args[args.indexOf("exec") + 1] === "resume" ? args.find((argument) => /^[0-9a-f-]{36}$/.test(argument)) : undefined;
    if (resumed !== undefined) return resumed;
    this.freshIds += 1;
    return `01a09d2f-73db-72b3-8029-6a4786c2eb${String(this.freshIds).padStart(2, "0")}`;
  }

  #conversationIdFor(args: readonly string[]): string {
    const resumed = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : undefined;
    if (resumed !== undefined) return resumed;
    this.freshIds += 1;
    return `5e1e942f-772b-47e3-b220-e85f65fef3${String(this.freshIds).padStart(2, "0")}`;
  }

  /** How many fresh ids this fake has minted, so a test can tell "new" from "resumed". */
  freshIds = 0;

  primaryCalls(): readonly Recorded[] {
    return this.calls.filter((call) => call.role === "primary");
  }

  lastPrimary(): Recorded {
    const calls = this.primaryCalls();
    assert.ok(calls.length > 0, "no primary invocation was made");
    return calls[calls.length - 1]!;
  }
}

function fixture(
  label: string,
  models: readonly { providerId: "anthropic" | "xai" | "openai" | "google" | "github-copilot"; modelId: string; coder: number; speed: "fast" | "balanced" | "deep"; writeCapable?: boolean }[] = [
    { providerId: "anthropic", modelId: "claude-sonnet", coder: 95, speed: "balanced" },
    { providerId: "anthropic", modelId: "claude-haiku", coder: 60, speed: "fast" },
    { providerId: "xai", modelId: "grok-fast", coder: 70, speed: "fast" },
    { providerId: "openai", modelId: "gpt-review", coder: 80, speed: "balanced" },
  ],
  /** Two clones deliberately sharing an id is the shape that collided, so it has to be expressible. */
  options: { readonly projectId?: string } = {},
) {
  const projectId = options.projectId ?? label;
  const root = mkdtempSync(join(tmpdir(), `braingate-m202-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "splash_page.dart"), "// splash\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  initializeDogfoodProject({ cwd: repo, projectId, name: "Sample" });
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const state = resolveOperatorState(env, repo);
  const catalog = new ModelCatalog(state.modelCatalogPath);
  for (const model of models) {
    catalog.upsert({
      providerId: model.providerId,
      modelId: model.modelId,
      quotaPool: `${model.providerId}-subscription`,
      capabilities: { coder: model.coder, reviewer: 70, judge: 65 },
      speed: model.speed,
      contextCapacity: 200_000,
      // Read-only unless a case says otherwise: the write path reaches the worktree surface, which
      // these scenarios are not about.
      writeCapable: model.writeCapable ?? false,
      reasoning: model.coder,
      underlyingFamily: null,
    });
  }
  return { root, repo, env, home, project: workspace(new ProjectRegistry(home).loadFile(join(repo, ".brain", "project.json"))) };
}

interface SessionPlan {
  readonly answers?: Readonly<Record<string, string>>;
  /** Which providers report `sessionIdPinning` from the capability probe. */
  readonly pinning?: Readonly<Record<string, boolean>>;
  /** Refuses every provider but this one, for the manual-ineligibility case. */
  readonly unavailable?: readonly string[];
}

function sessionOf(repo: string, env: NodeJS.ProcessEnv, cli: FakeCli, answers: readonly string[], plan: SessionPlan = {}) {
  const remaining = [...answers];
  let out = "";
  let err = "";
  const pinning = plan.pinning ?? { anthropic: true, xai: true, openai: false };
  const unavailable = new Set(plan.unavailable ?? []);
  return {
    text: () => `${out}${err}`,
    out: () => out,
    err: () => err,
    run: () => runRepl({
      cwd: repo,
      env,
      animate: false,
      colour: false,
      stdout: (t) => { out += t; },
      stderr: (t) => { err += t; },
      ask: async () => remaining.shift() ?? null,
      executor: cli,
      discoverAll: async () => ([
        snapshot("anthropic", "Claude Code", "claude"),
        snapshot("xai", "Grok Build", "grok"),
        snapshot("openai", "Codex CLI", "codex"),
        snapshot("google", "Antigravity", "agy"),
        snapshot("github-copilot", "Copilot", "copilot"),
      ]).map((item) => (unavailable.has(item.providerId) ? { ...item, available: { ...item.available, value: false } } : item)),
      probeCapabilities: async (providerId: string) => ({
        features: { sessionIdPinning: { supported: pinning[providerId] ?? false } },
      }),
      // No capability probe of the installed builds.
      //
      // Not a convenience: the real probe spawns each CLI, and a CLI started in a project with MCP
      // servers configured starts *those* — which on this machine means several `npm exec` processes
      // that never exit. A test suite must not launch the operator's own tooling, and the reading
      // this stands in for is exercised against the real builds by the integration tests instead.
      measureCapabilities: async () => ({}),
      // No isolation self-test either. The real one spawns the provider's CLI, and a CLI started
      // with this machine's MCP configuration starts *those* servers too — processes that never
      // exit. What these tests are about is session continuity, and a live self-test would make
      // them depend on the operator's installed tooling and take minutes apiece.
      verifyGrokIsolation: async (snapshot: ProviderSnapshot) => ({
        providerId: "xai" as const,
        source: "sandbox-event-self-test" as const,
        version: snapshot.version.value ?? "0.0.0",
        platform: process.platform === "linux" ? "linux" as const : "darwin" as const,
        profileHash: "test-profile",
        policyHash: "test-policy",
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        readableRoots: [],
        networkRestricted: true,
        configSurfaces: [],
      }),
      verifyCodexIsolation: async (snapshot: ProviderSnapshot) => ({
        providerId: "openai" as const,
        source: "sandbox-self-test" as const,
        version: snapshot.version.value ?? "0.0.0",
        platform: process.platform === "linux" ? "linux" as const : "darwin" as const,
        profileHash: "test-profile",
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        unrecognisedKeys: [],
        droppedKeys: [],
        droppedFeatureKeys: [],
      }),
    }),
  };
}

// ---------------------------------------------------------------- A. same-provider resume

test("A: the same worker is resumed on its own session, and given a delta rather than the whole goal", async () => {
  const f = fixture("resume");
  const cli = new FakeCli({ "Investigate the idle logout": "The splash screen reads AuthInitial before restore resolves." });
  const session = sessionOf(f.repo, f.env, cli, [
    "Investigate the idle logout", "y",
    "What else could cause it?", "y",
  ]);
  assert.equal(await session.run(), 0);

  const calls = cli.primaryCalls();
  assert.equal(calls.length, 2, "two turns, two primary invocations");
  const [first, second] = calls;
  // Turn 1 pins an id BrainGate chose, and the run is allowed to persist it.
  assert.ok(first!.sessionIdArg !== null, "the first turn must pin a session id");
  assert.equal(first!.resumeArg, null, "the first turn resumes nothing");
  assert.equal(first!.noPersistence, false, "a pinning turn must not be told not to persist");
  // Turn 2 continues that exact session and does not pin a new one.
  assert.equal(second!.resumeArg, first!.sessionIdArg, "the second turn must resume the first turn's session");
  assert.equal(second!.sessionIdArg, null, "a resumed turn must not also name a new session");
  assert.equal(second!.noPersistence, false);

  const store = new GoalStore(f.project);
  try {
    const goal = store.activeGoal();
    assert.ok(goal !== null);
    const registered = store.latestSessionFor("anthropic", "claude-sonnet");
    assert.equal(registered?.sessionId, first!.sessionIdArg);
    assert.equal(registered?.resumeMode, "available");
    assert.equal(registered?.status, "active");
    assert.equal(registered?.goalId, goal.goalId);
    // The session's position is recorded, which is what the *next* delta is measured from.
    assert.ok((registered?.lastTurnSequence ?? 0) > 0, "the session must record the turn it last used");
  } finally { store.close(); }
});

test("A: a resumed worker is sent a delta, not a second copy of the handoff it already lived through", async () => {
  const f = fixture("delta-not-handoff");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, [
    "Investigate the idle logout", "y",
    "What else could cause it?", "y",
  ]);
  assert.equal(await session.run(), 0);

  const second = cli.lastPrimary();
  // The resumed session is handed the delta, and explicitly NOT the full handoff: it remembers its
  // own turns, and re-sending them would read as "here is everything" and invite a re-derivation.
  const resumedGoal = second.context.goal as { readonly goalDelta?: { readonly sinceWorker: string | null }; readonly handoff?: unknown; readonly handoffText?: string } | undefined;
  assert.ok(resumedGoal !== undefined, "a resumed turn must carry the goal layer");
  assert.ok(resumedGoal.goalDelta !== undefined, "a resumed turn must carry a delta rather than the handoff");
  assert.equal(resumedGoal.handoff, undefined, "a resumed turn must not repeat the whole goal handoff");
  assert.equal(resumedGoal.goalDelta.sinceWorker, "anthropic/claude-sonnet");
  const text = String(resumedGoal.handoffText ?? "");
  assert.match(text, /Your native session is continuing/);
  assert.match(text, /Do not restate or re-derive the work you already did/);
});

// ---------------------------------------------------------------- B. cross-provider

test("B: switching provider continues the same goal and hands the new worker the established state", async () => {
  const f = fixture("cross-provider");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, [
    "Investigate the idle logout", "y",
    "/use anthropic/claude-haiku",
    "What is the second-order effect?", "y",
  ]);
  assert.equal(await session.run(), 0);

  constants: {
    const store = new GoalStore(f.project);
    try {
      const conversation = store.activeConversation();
      assert.ok(conversation !== null);
      const goals = store.listGoals(conversation.conversationId);
      assert.equal(goals.length, 1, "a provider switch must not start a second goal");
      const turns = store.recentTurns(conversation.conversationId, 10);
      assert.equal(turns.length, 2);
      assert.equal(turns[0]?.goalId, turns[1]?.goalId);
      assert.deepEqual([...turns[1]!.attributedTo], ["anthropic/claude-haiku"], "the second turn records who actually served it");
    } finally { store.close(); }
  }

  const switched = cli.primaryCalls().find((call) => call.modelId === "claude-haiku");
  assert.ok(switched !== undefined, "the switched-to worker must have been invoked");
  // A worker with no session for this goal gets the full handoff, and is told it may check it.
  const goal = switched.context.goal as { readonly handoff?: { readonly status: string; readonly workUnit: string }; readonly handoffText?: string; readonly goalDelta?: unknown } | undefined;
  assert.ok(goal?.handoff !== undefined, `a worker joining the goal must carry the goal handoff (goal keys: ${goal === undefined ? "none" : Object.keys(goal).join(",")})`);
  assert.equal(goal.handoff.workUnit, "What is the second-order effect?");
  assert.match(String(goal.handoffText ?? ""), /You are continuing BrainGate goal/);
  assert.match(String(goal.handoffText ?? ""), /free to inspect the repository yourself/);
  assert.equal(goal.goalDelta, undefined, "a worker with no prior session has nothing to be given a delta against");
});

test("B: a pin to a provider that is deliberately excluded refuses instead of routing around it", async () => {
  const f = fixture("excluded-provider", [{ providerId: "github-copilot", modelId: "copilot-fast", coder: 90, speed: "fast" }]);
  const cli = new FakeCli();
  // Copilot has no measured DIRECT invocation, so it is excluded as a read primary under the
  // default policy and the pin is refused rather than quietly given to someone else.
  //
  // Grok used to be the example here, because it could only run staged roles; the multi-provider
  // milestone measured its native invocation and it now runs when the operator names it, so the
  // test moved to the provider that is still closed rather than to the behaviour that changed.
  const session = sessionOf(f.repo, f.env, cli, ["/use github-copilot/copilot-fast", "Investigate the idle logout", "y"]);
  assert.equal(await session.run(), 0);
  assert.equal(cli.calls.length, 0, "an excluded provider must not be invoked by a manual pin");
  assert.match(session.text(), /ROUTE_MANUAL_INELIGIBLE/);
  assert.match(session.text(), /Nothing was routed elsewhere/);
});

// ---------------------------------------------------------------- C. returning provider

test("C: returning to the first provider resumes its own session and reports only what changed", async () => {
  const f = fixture("returning");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, [
    "Investigate the idle logout", "y",
    "/use xai/grok-fast",
    "Review that diagnosis", "y",
    "/use anthropic/claude-sonnet",
    "What would you check next?", "y",
  ]);
  assert.equal(await session.run(), 0);

  const sonnet = cli.primaryCalls().filter((call) => call.providerId === "anthropic");
  assert.equal(sonnet.length, 2, "Sonnet ran turn 1 and turn 3");
  assert.equal(sonnet[1]!.resumeArg, sonnet[0]!.sessionIdArg, "turn 3 must resume the session turn 1 created");
  // And it is given a delta rather than the whole goal again, because it already lived through its
  // own turns — even when the truthful answer is that nothing changed.
  const returning = sonnet[1]!.context.goal as { readonly goalDelta?: { readonly sinceWorker: string | null }; readonly handoff?: unknown; readonly handoffText?: string } | undefined;
  const delta = returning?.goalDelta;
  assert.ok(delta !== undefined, "the returning worker needs to be told what it missed, even when nothing did change");
  assert.equal(delta.sinceWorker, "anthropic/claude-sonnet", "the delta is measured from that session's own last turn");
  assert.equal(returning!.handoff, undefined, "a returning worker is not handed the whole goal again");
  assert.match(String(returning!.handoffText ?? ""), /since your last turn/i);
});

test("C: a delta with no baseline is not invented", async () => {
  const f = fixture("no-baseline");
  const cli = new FakeCli();
  // A fresh session on turn 1, then a resumed turn 2 whose snapshot was never written: the delta
  // must degrade to the ordinary handoff rather than claiming everything is new.
  const session = sessionOf(f.repo, f.env, cli, ["Investigate the idle logout", "y", "Why does that happen?", "y"]);
  assert.equal(await session.run(), 0);
  const store = new GoalStore(f.project);
  try {
    const goal = store.activeGoal();
    assert.ok(goal !== null);
    const registered = store.latestSessionFor("anthropic", "claude-sonnet");
    assert.ok(registered !== null);
    // Clearing the snapshot simulates a session whose first run died before it was marked.
    store.markSessionUsed({ providerId: "anthropic", modelId: "claude-sonnet", sessionId: registered!.sessionId, stateSnapshot: undefined });
    assert.equal(store.sessionStateSnapshot("anthropic", "claude-sonnet", registered!.sessionId) === null, false, "a snapshot exists after a normal turn");
  } finally { store.close(); }
});

// ---------------------------------------------------------------- D. multiple models, one provider

test("D: two models on one subscription are two workers with two sessions, and the first one comes back", async () => {
  const f = fixture("two-models");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, [
    "Investigate the idle logout", "y",
    "/use anthropic/claude-haiku",
    "Summarise that for me", "y",
    "/use anthropic/claude-sonnet",
    "What would you check next?", "y",
  ]);
  assert.equal(await session.run(), 0);

  const all = cli.primaryCalls();
  const byModel = (model: string) => all.filter((call) => call.modelId === model);
  const sonnetCalls = byModel("claude-sonnet");
  const haikuCalls = byModel("claude-haiku");
  assert.equal(sonnetCalls.length, 2);
  assert.equal(haikuCalls.length, 1);
  // Different workers, different sessions: Haiku pins its own id rather than joining Sonnet's.
  assert.ok(haikuCalls[0]!.sessionIdArg !== null);
  assert.notEqual(haikuCalls[0]!.sessionIdArg, sonnetCalls[0]!.sessionIdArg, "one model's session must not be used by another");
  // And returning to Sonnet resumes Sonnet's own session, not Haiku's.
  assert.equal(sonnetCalls[1]!.resumeArg, sonnetCalls[0]!.sessionIdArg);
  assert.notEqual(sonnetCalls[1]!.resumeArg, haikuCalls[0]!.sessionIdArg);

  const store = new GoalStore(f.project);
  try {
    const goal = store.activeGoal();
    assert.ok(goal !== null, "both models worked on one goal");
    const sessions = store.listProviderSessions(10);
    assert.equal(sessions.length, 2, "each model holds its own session");
    assert.deepEqual([...sessions.map((item) => item.modelId)].sort(), ["claude-haiku", "claude-sonnet"]);
    // The goal remembers both, so a switch back needs no lookup by guesswork.
    assert.equal(goal.state.providerSessions.length, 2);
  } finally { store.close(); }
});

// ---------------------------------------------------------------- E. manual hard ineligibility

test("E: a manually chosen model that cannot run the work is refused, and nothing is routed elsewhere", async () => {
  const f = fixture("ineligible");
  const cli = new FakeCli();
  // Codex is unavailable on this machine, so the pin cannot be satisfied.
  const session = sessionOf(f.repo, f.env, cli, [
    "/use openai/gpt-review",
    "Investigate the idle logout", "y",
  ], { unavailable: ["openai"] });
  assert.equal(await session.run(), 0);
  assert.equal(cli.calls.length, 0, "a refused pin must not reach any provider");
  assert.match(session.text(), /ROUTE_MANUAL_INELIGIBLE/);
  assert.match(session.text(), /Nothing was routed elsewhere/);
  assert.match(session.text(), /\/auto/);
});

test("E: a model nobody configured is refused at the command, before any work is planned", async () => {
  const f = fixture("unknown-model");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, ["/use anthropic/claude-opus", "/auto", "/exit"]);
  assert.equal(await session.run(), 0);
  assert.match(session.text(), /is not in your model catalogue/);
  assert.match(session.text(), /Configured for anthropic: /);
  assert.match(session.text(), /anthropic\/claude-sonnet/);
  assert.equal(cli.calls.length, 0);
});

// ---------------------------------------------------------------- F. /auto

test("F: /auto restores automatic routing", async () => {
  const f = fixture("auto");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, [
    "/use anthropic/claude-haiku",
    "Investigate the idle logout", "y",
    "/auto",
    "What else could cause it?", "y",
  ]);
  assert.equal(await session.run(), 0);
  const models = cli.primaryCalls().map((call) => call.modelId);
  assert.equal(models[0], "claude-haiku", "the manual choice was used");
  // What `/auto` must do is release the pin, not pick a particular model: which model the router
  // then prefers is routing policy, and retuning that is a different milestone.
  assert.notEqual(models[1], "claude-haiku", "automatic selection must not still be pinned");
  assert.match(session.text(), /Automatic selection restored/);
});

// ---------------------------------------------------------------- G. fresh session

test("G: /use --fresh starts a new native session and still continues the goal", async () => {
  const f = fixture("fresh");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, [
    "Investigate the idle logout", "y",
    "/use anthropic/claude-sonnet --fresh",
    "Why does that happen again?", "y",
  ]);
  assert.equal(await session.run(), 0);
  const calls = cli.primaryCalls();
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.sessionIdArg !== null, "a fresh session is pinned to a new id");
  assert.notEqual(calls[1]!.sessionIdArg, calls[0]!.sessionIdArg, "fresh must not reuse the old session");
  assert.equal(calls[1]!.resumeArg, null, "fresh must not resume");
  // The goal is still continued: freshness is about the native session, not the work.
  assert.match(session.text(), /continues goal/);

  const store = new GoalStore(f.project);
  try {
    const conversation = store.activeConversation();
    assert.ok(conversation !== null);
    assert.equal(store.listGoals(conversation.conversationId).length, 1, "a fresh session is not a new goal");
    assert.equal(store.recentTurns(conversation.conversationId, 10).length, 2);
  } finally { store.close(); }
});

test("G: a fresh request is consumed by one run, not left armed forever", async () => {
  const f = fixture("fresh-once");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, [
    "/use anthropic/claude-sonnet --fresh",
    "First request", "y",
    "Does the same reasoning hold?", "y",
  ]);
  assert.equal(await session.run(), 0);
  const calls = cli.primaryCalls();
  assert.ok(calls[0]!.sessionIdArg !== null);
  // The second turn resumes the session the first one pinned, because --fresh applied to one run.
  assert.equal(calls[1]!.resumeArg, calls[0]!.sessionIdArg);
});

// ---------------------------------------------------------------- H. process restart

test("H: after a restart the goal continues and the session resumes, because both are persisted", async () => {
  const f = fixture("restart");
  const first = new FakeCli();
  assert.equal(await sessionOf(f.repo, f.env, first, ["Investigate the idle logout", "y"]).run(), 0);
  const pinned = first.lastPrimary().sessionIdArg;
  assert.ok(pinned !== null);

  // A second process against the same project: nothing in memory survives but the stores do.
  const second = new FakeCli();
  const session = sessionOf(f.repo, f.env, second, ["What would you check next?", "y"]);
  assert.equal(await session.run(), 0);
  assert.equal(second.lastPrimary().resumeArg, pinned, "the session recorded by the first process must be resumed");
  assert.match(session.text(), /continues goal/);
});

// ---------------------------------------------------------------- I. runtime without resume

test("I: a runtime whose build exposes no session id gets a fresh invocation with the goal handoff, and no false claim", async () => {
  const f = fixture("no-resume");
  const cli = new FakeCli();
  // The capability probe is what decides this, and it is the same decision for Codex, Antigravity
  // and Copilot as it is here: their builds have resume but no way to name a *new* session's id, so
  // there is nothing truthful to hold a reference to. Modelled on the provider whose probe answers
  // false, which keeps this a test of the decision rather than of another provider's self-tests.
  const session = sessionOf(f.repo, f.env, cli, [
    "Investigate the idle logout", "y",
  ], { pinning: { anthropic: false, xai: false, openai: false } });
  assert.equal(await session.run(), 0);

  const calls = cli.primaryCalls();
  assert.ok(calls.length >= 1);
  for (const call of calls) {
    assert.equal(call.sessionIdArg, null, "this runtime must never be handed a pinned id");
    assert.equal(call.resumeArg, null, "this runtime must never be resumed");
  }
  // It is still given the goal, which is the point: continuity of the *work* does not depend on
  // continuity of a session.
  const goal = calls[0]!.context.goal as { readonly handoff?: unknown; readonly goalDelta?: unknown } | undefined;
  assert.ok(goal?.handoff !== undefined, "a worker on a runtime without session ids must still be handed the goal");
  assert.equal(goal.goalDelta, undefined, "and it is not given a delta against a session it never had");
  // And nothing on record claims a session it does not have: no id was invented, and none was
  // written down as though one had been.
  const store = new GoalStore(f.project);
  try {
    assert.equal(store.latestSessionFor("anthropic", "claude-sonnet"), null);
    assert.deepEqual([...store.listProviderSessions(5)], []);
  } finally { store.close(); }
  // The turn says what it did about a session, and says it truthfully: a fresh invocation with the
  // goal handoff, because this build has no id to hold on to.
  assert.match(session.text(), /session: fresh invocation with a goal handoff/);
});

// ---------------------------------------------------------------- J. context bounds

test("J: a long conversation is bounded in what a worker is given, and the history stays retrievable", async () => {
  const f = fixture("bounds");
  const cli = new FakeCli();
  const answers: string[] = [];
  // Twelve turns, each answered with a long paragraph, all on one goal.
  for (let index = 0; index < 12; index += 1) {
    answers.push(`Question number ${String(index)} about the idle logout`, "y");
  }
  const session = sessionOf(f.repo, f.env, cli, answers);
  assert.equal(await session.run(), 0);

  const payload = JSON.stringify(cli.lastPrimary().context);
  // The bounded layers, not the transcript. The limit is generous but finite, and it does not grow
  // with the conversation: the point is that turn twelve is not twelve times the prompt.
  assert.ok(payload.length < 40_000, `context grew to ${String(payload.length)} characters`);
  const delta = cli.lastPrimary().context.goalDelta as { readonly turns: readonly unknown[] } | undefined;
  if (delta !== undefined) assert.ok(delta.turns.length <= 6, "a delta carries a bounded number of turns");

  const store = new GoalStore(f.project);
  try {
    const conversation = store.activeConversation();
    assert.ok(conversation !== null);
    // Every turn is still there: bounding what a worker is *told* never bounds what is *kept*.
    assert.equal(store.recentTurns(conversation.conversationId, 50).length, 12);
  } finally { store.close(); }
});

// ---------------------------------------------------------------- /worker and /auto shape

// ---------------------------------------------------------------- read -> write continuation

test("K: a read turn and the write turn that follows it stay one conversation, one goal, one worker", async () => {
  // The read->write case is the one M20.1 got wrong, and it needs its own fixture: a write turn
  // reaches the worktree path, which runs provider self-tests a unit test cannot stub into validity.
  // What this asserts is the continuity, so the fixture holds only the worker under test.
  const f = fixture("read-then-write", [{ providerId: "anthropic", modelId: "claude-sonnet", coder: 95, speed: "balanced", writeCapable: true }]);
  const cli = new FakeCli({ "Find the bug in the splash flow. Do not modify any files.": "The splash screen reads AuthInitial before restore resolves." });
  const session = sessionOf(f.repo, f.env, cli, [
    "/use anthropic/claude-sonnet",
    "Find the bug in the splash flow. Do not modify any files.", "y",
    "Fix the splash ordering.", "n",
  ]);
  assert.equal(await session.run(), 0);

  const text = session.text();
  // The second turn is planned as a write, at the same goal, and declining it spends nothing. Under
  // the default DIRECT policy that write happens in the workspace, so the line says so rather than
  // promising a worktree the run would never create (ADR 0017).
  assert.match(text, /write · direct · in your workspace/);
  assert.match(text, /continues goal/);
  assert.match(text, /Skipped\. Nothing was spent\./);

  const store = new GoalStore(f.project);
  try {
    const conversation = store.activeConversation();
    assert.ok(conversation !== null, "the session must have opened a conversation");
    const goals = store.listGoals(conversation.conversationId);
    assert.equal(goals.length, 1, "a write follow-up must not start a second goal");
    const turns = store.recentTurns(conversation.conversationId, 10);
    assert.equal(turns.length, 1, "only the executed read turn is on the timeline");
    assert.equal(turns[0]?.goalId, goals[0]?.goalId);
  } finally { store.close(); }

  // The manual choice survives into the write plan: the same worker plans the change it diagnosed.
  assert.ok(cli.calls.some((call) => call.modelId === "claude-sonnet"), "the pinned worker must plan the write too");
});

test("the worker command reports the selection, the goal and what the next run would do", async () => {
  const f = fixture("worker-view");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, [
    "/worker",
    "/use anthropic/claude-sonnet",
    "Investigate the idle logout", "y",
    "/worker",
    "/exit",
  ]);
  assert.equal(await session.run(), 0);
  const text = session.text();
  assert.match(text, /Worker: auto/);
  assert.match(text, /Worker: manual — anthropic\/claude-sonnet/);
  assert.match(text, /Goal: /);
  assert.match(text, /Last run: anthropic\/claude-sonnet/);
  assert.match(text, /Native session: new native session|Native session: resuming native session/);
  assert.match(text, /Sessions on record:/);
  assert.equal(cli.calls.length, 1, "looking at the worker state must not spend anything");
});

// ---------------------------------------------------------------- failure guidance

test("L: failure guidance names a command the session will not read as a new request", async () => {
  const f = fixture("failure-guidance");
  const cli = new FakeCli();
  // A run that fails after its task was created: the receipt is recorded, and the operator needs to
  // be told how to read it.
  const failing: ShadowProcessExecutor = {
    async run(): Promise<ShadowProcessResult> {
      return { spawned: true, exitCode: 1, stdout: "", stderr: "provider refused", timedOut: false, durationMs: 3, removedEnvironmentKeys: [] };
    },
  };
  let out = "";
  const answers = ["Investigate the idle logout", "y"];
  await runRepl({
    cwd: f.repo,
    env: f.env,
    animate: false,
    colour: false,
    stdout: (t) => { out += t; },
    stderr: (t) => { out += t; },
    ask: async () => answers.shift() ?? null,
    executor: failing,
    discoverAll: async () => [snapshot("anthropic", "Claude Code", "claude")],
    measureCapabilities: async () => ({}),
    probeCapabilities: async () => ({ features: { sessionIdPinning: { supported: true } } }),
  });
  void cli;

  assert.match(out, /Exit 1: this task did not finish successfully/);
  // The guidance must not be a bare `tasks list`: the session reads that as a request, and following
  // BrainGate's own advice spent a task on the phrase — which is exactly what happened in dogfood.
  assert.doesNotMatch(out, /Run `tasks list`/, "a bare tasks command is a request to this session");
  assert.match(out, /Use \/status here/, "the interactive equivalent is named");
  assert.match(out, /`braingate tasks list` in your shell/, "and the shell command is fully qualified");
});

test("L: /status is an observation, so following the guidance records no second task", async () => {
  const f = fixture("status-is-an-observation");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, ["/status", "/exit"]);
  assert.equal(await session.run(), 0);
  assert.equal(cli.calls.length, 0, "/status must not reach a provider");
  const store = new GoalStore(f.project);
  try {
    // And it must not have started a goal: a command is not a request.
    assert.equal(store.activeGoal(), null);
  } finally { store.close(); }
});

// ---------------------------------------------------------------- pasted input

/**
 * A terminal fixture that speaks the bytes a terminal actually sends.
 *
 * Not a line emitter: the whole defect was that lines are what readline reduces a paste to, so a
 * fixture that hands over lines cannot express the difference between a paste and held-down Enter.
 * This one delivers raw chunks, brackets included, and can split a chunk anywhere.
 */
class FakeTerminal {
  readonly #dataListeners: ((chunk: string) => void)[] = [];
  readonly #endListeners: (() => void)[] = [];
  readonly #written: string[] = [];
  readonly prompt: ReturnType<typeof createPromptInput>;

  constructor(options: { readonly terminal?: boolean } = {}) {
    this.prompt = createPromptInput({
      input: this as never,
      write: (text: string) => { this.#written.push(text); },
      terminal: options.terminal ?? true,
    });
  }

  on(event: "data", listener: (chunk: string) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  on(event: string, listener: ((chunk: string) => void) | (() => void)): this {
    if (event === "data") this.#dataListeners.push(listener as (chunk: string) => void);
    else this.#endListeners.push(listener as () => void);
    return this;
  }

  setRawMode(): void { /* the fixture has no modes; the API is what is under test */ }

  /** A chunk exactly as the kernel would deliver it. */
  chunk(text: string): void { for (const listener of [...this.#dataListeners]) listener(text); }

  /** Typing: one character at a time, as the terminal sends it. */
  type(text: string): void { for (const character of text) this.chunk(character); }

  /** Enter. */
  enter(): void { this.chunk("\r"); }

  /**
   * A paste, exactly as a terminal in bracketed-paste mode delivers one.
   *
   * The content goes between the markers with its newlines intact — including a trailing one, which
   * is the case that used to submit the request before the operator pressed anything.
   */
  paste(content: string, options: { readonly splitAt?: number } = {}): void {
    const framed = `${PASTE_START}${content}${PASTE_END}`;
    const splitAt = options.splitAt;
    if (splitAt === undefined) { this.chunk(framed); return; }
    // A split marker, so the parser has to hold a partial escape sequence rather than assume chunks.
    this.chunk(framed.slice(0, splitAt));
    this.chunk(framed.slice(splitAt));
  }

  end(): void { for (const listener of [...this.#endListeners]) listener(); }

  written(): string { return this.#written.join(""); }
}

test("M: a pasted multiline request stays pending until Enter, then submits once", async () => {
  const terminal = new FakeTerminal();
  const request = terminal.prompt.ask("> ");
  // The paste the operator actually made, trailing newline and all. Nothing is submitted by it.
  terminal.paste("Find why users are logged out.\nTrace the session path.\nKeep the answer concise.\n");
  await terminal.prompt.idle();
  // Four lines, not three: the paste ended with a newline, so its last line is empty — and that is
  // kept rather than trimmed, because it is what the operator pasted.
  // The draft is painted as its own lines, in full: a pending multiline request looks like itself.
  assert.match(terminal.written(), /Find why users are logged out\.\r\nTrace the session path\.\r\nKeep the answer concise\./, "the whole draft is visible while it is pending");
  assert.doesNotMatch(terminal.written(), /pasted \d+ lines/, "and there is no notice to announce what the screen already shows");

  // The explicit submit, and only then — and the whole request is echoed as output.
  terminal.enter();
  assert.equal(
    await request,
    "Find why users are logged out.\nTrace the session path.\nKeep the answer concise.\n",
    "the whole paste is one request, exactly as pasted",
  );
  assert.match(terminal.written(), /Find why users are logged out\.\r\nTrace the session path\./, "and the submitted request is echoed in full, as the lines it is");
});

test("M: a paste followed by typing and one Enter is still one request", async () => {
  const terminal = new FakeTerminal();
  const request = terminal.prompt.ask("> ");
  terminal.paste("Inspect auth.dart.\n");
  await terminal.prompt.idle();
  terminal.type("Do not modify anything.");
  terminal.enter();
  assert.equal(await request, "Inspect auth.dart.\nDo not modify anything.", "typing continues the draft after a paste");
});

test("M: the request never answers the confirmation, and the confirmation never joins the next request", async () => {
  const terminal = new FakeTerminal();
  const request = terminal.prompt.ask("> ");
  terminal.paste("One line.\nTwo lines.\n");
  await terminal.prompt.idle();
  terminal.enter();
  assert.equal(await request, "One line.\nTwo lines.\n");

  // The confirmation is a different ask, and only the bytes that arrive while it is waiting count.
  const confirmation = terminal.prompt.ask("  Run it? [y/N] ");
  await terminal.prompt.idle();
  terminal.type("y");
  terminal.enter();
  assert.equal(await confirmation, "y");

  // And the next request starts empty rather than inheriting anything from either.
  const next = terminal.prompt.ask("> ");
  terminal.type("/status");
  terminal.enter();
  assert.equal(await next, "/status");
});

test("M: Ctrl+C clears a pending draft instead of sending it", async () => {
  const terminal = new FakeTerminal();
  const request = terminal.prompt.ask("> ");
  terminal.paste("half a request\n");
  await terminal.prompt.idle();
  terminal.chunk("\u0003");
  terminal.type("a different request");
  terminal.enter();
  assert.equal(await request, "a different request", "what was cleared is not part of what is sent");
});

test("M: an escape sequence is consumed rather than pasted into the request", async () => {
  const terminal = new FakeTerminal();
  const request = terminal.prompt.ask("> ");
  terminal.chunk("\u001b[A");          // Up arrow
  terminal.type("real request");
  terminal.enter();
  assert.equal(await request, "real request");
});

test("M: an ended input releases a waiting prompt instead of hanging the session", async () => {
  // A closed pipe must not leave a prompt waiting forever: that is a process that never exits.
  const terminal = new FakeTerminal();
  const waiting = terminal.prompt.ask("> ");
  terminal.end();
  assert.equal(await waiting, null, "the end of input is an answer of `no more input`");
});

// ---------------------------------------------------------------- workspace attachment

test("N: a manifest bound to another workspace stops the session before anything is planned or spent", async () => {
  // The real dogfood failure: the registration names one directory and the operator is standing in
  // another. Here the binding is written out directly, which is also how it arises in the world —
  // a clone copied to a second volume carries the first one's manifest with it.
  const registered = fixture("attach-registered", undefined, { projectId: "shared-slug" });
  const other = fixture("attach-other", undefined, { projectId: "shared-slug" });
  const cli = new FakeCli();

  // The other clone's manifest now names the first workspace, as a copy of it would.
  writeFileSync(
    join(other.repo, ".brain", "project.json"),
    JSON.stringify({ project_id: "shared-slug", name: "Sample", repositories: [registered.repo] }),
  );

  const session = sessionOf(other.repo, other.env, cli, ["Investigate the idle logout", "y"]);
  assert.equal(await session.run(), 1, "the session must stop rather than run somewhere else");
  assert.equal(cli.calls.length, 0, "no provider may be reached");
  const text = session.text();
  assert.match(text, /registered to a different workspace/);
  assert.match(text, /registered: {2}/);
  assert.match(text, /you are in: {2}/);
  assert.match(text, /init --rebind/);
  assert.match(text, /--project-id/);
});

test("N: two clones that each name themselves both attach, because a clone is self-consistent", async () => {
  // The complement of the refusal, and the reason identity is a path rather than a slug: a second
  // clone carrying the same project id is not itself an error. What was wrong was the *shared
  // storage*, and that is what the refusal above prevents from being used silently.
  const first = fixture("attach-self-a", undefined, { projectId: "shared-slug" });
  const second = fixture("attach-self-b", undefined, { projectId: "shared-slug" });
  for (const f of [first, second]) {
    const cli = new FakeCli();
    const session = sessionOf(f.repo, f.env, cli, ["/project", "/exit"]);
    assert.equal(await session.run(), 0);
    assert.match(session.text(), /Execution is bound to this workspace/);
    assert.match(session.text(), /A different directory is a different workspace/);
  }
});

test("N: /project reports the binding, and a matching workspace is attached rather than refused", async () => {
  const f = fixture("attach-matching");
  const cli = new FakeCli();
  const session = sessionOf(f.repo, f.env, cli, ["/project", "/exit"]);
  assert.equal(await session.run(), 0);
  const text = session.text();
  assert.match(text, /Project: +attach-matching/);
  assert.match(text, /Workspace: /);
  assert.match(text, /Git: +\S+ · main @ [0-9a-f]{8} · clean/, "the git metadata is shown, and labelled as metadata");
  assert.match(text, /Execution is bound to this workspace/);
  assert.match(text, /A different directory is a different workspace/);
  assert.equal(cli.calls.length, 0, "looking at the binding spends nothing");
});

test("N: a session in a subdirectory attaches, and the workspace is the subdirectory", async () => {
  const f = fixture("attach-subdir");
  const nested = join(f.repo, "flutter_migration", "tabaq_app_clean");
  mkdirSync(nested, { recursive: true });
  const cli = new FakeCli();
  const session = sessionOf(nested, f.env, cli, ["/project", "/exit"]);
  assert.equal(await session.run(), 0);
  // The manifest is found upward, so a session started in a package of a monorepo still attaches to
  // the project. The workspace, though, is the directory they launched in: `git rev-parse
  // --show-toplevel` is not what a native CLI's cwd should be, and widening to it was the defect.
  // The manifest was written at the repository, so that is the workspace this project has: launching
  // from a package inside it does not mint a second one, and the ledger one directory up is the one
  // this session reads.
  const reported = (/Workspace: (.+)/.exec(session.text())?.[1] ?? "").trim();
  assert.equal(reported, realpathSync.native(f.repo), "the workspace is the directory that was registered");
  assert.equal(reported, checkoutRootOf(nested), "which here is the repository Git reports above it");
  // And the worker still runs where the operator launched, which is the M20.3 promise this keeps.
  const directory = (/Directory: (.+)/.exec(session.text())?.[1] ?? "").trim();
  assert.equal(directory, realpathSync.native(nested), "the directory workers run in is the one they launched from");
});

test("N: a workspace with no repository attaches and reports Git as metadata it does not have", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-attach-plain-"));
  try {
    mkdirSync(join(root, ".brain"), { recursive: true });
    writeFileSync(join(root, ".brain", "project.json"), JSON.stringify({ project_id: "plain", name: "Plain", repositories: [root] }));
    const cli = new FakeCli();
    const session = sessionOf(root, { BRAINGATE_HOME: join(root, "brain-home") }, cli, ["/project", "/exit"]);
    assert.equal(await session.run(), 0, session.text());
    assert.match(session.text(), /Project: +plain/);
    assert.match(session.text(), /Git: +none — this workspace is not inside a repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- K. reported-id continuity

/**
 * A runtime that mints its own session id, and BrainGate resuming it.
 *
 * Measured 2026-09-14: Codex publishes `thread.started.thread_id` as the first line of its JSONL
 * stream and `exec resume <id>` continues it; Antigravity answers with a `conversation_id` and
 * `--conversation <id>` continues that. Neither lets the caller name the id up front, so continuity
 * here is two facts working together — the run reports an id, and BrainGate records it against the
 * goal so the next compatible run can hand it back. A fake that minted an id but was never asked to
 * resume it would pass whichever implementation it was given, which is why both halves are asserted.
 */
test("K: a runtime that reports its own session id is resumed on it, and never claims a pinned one", async () => {
  // Codex only: Antigravity has the same reported-id shape but cannot run a DIRECT read at all,
  // which its own test records rather than this one asserting a capability that was measured away.
  for (const [providerId, modelId] of [["openai", "codex-fast"]] as const) {
    const f = fixture(`reported-${providerId}`, [{ providerId, modelId, coder: 100, speed: "fast" }]);
    const cli = new FakeCli({ "Read the notes file": "Three lines about a launch screen." });
    const session = sessionOf(f.repo, f.env, cli, [
      `/use ${providerId}/${modelId}`,
      "Read the notes file", "y",
      "What did it say?", "y",
    ], { pinning: { anthropic: true, xai: true, openai: false } });
    try {
      assert.equal(await session.run(), 0, session.text());
      const calls = cli.primaryCalls().filter((call) => call.providerId === providerId);
      assert.equal(calls.length, 2, `${providerId}: two turns, two invocations\n${session.text()}`);
      const [first, second] = calls;

      // The first turn cannot pin an id — this runtime does not accept one — so the run starts
      // without a session flag and BrainGate learns the id from what came back.
      assert.equal(first!.sessionIdArg, null, `${providerId}: nothing was pinned`);
      assert.equal(first!.resumeArg, null, `${providerId}: and nothing was resumed`);

      // The second turn hands that exact id back to the same worker, and pins nothing new.
      assert.notEqual(second!.resumeArg, null, `${providerId}: the reported id was resumed`);
      assert.equal(second!.sessionIdArg, null, `${providerId}: a resumed turn pins nothing`);
      assert.match(session.text(), /resuming native session/, `${providerId}: and the terminal says so`);

      const store = new GoalStore(f.project);
      try {
        const goal = store.activeGoal();
        const registered = store.latestSessionFor(providerId, modelId);
        assert.equal(registered?.sessionId, second!.resumeArg, `${providerId}: the session on record is the reported one`);
        assert.equal(registered?.goalId, goal?.goalId, `${providerId}: and it belongs to this goal`);
      } finally { store.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
