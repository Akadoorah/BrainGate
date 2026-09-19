import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRegistry, TaskLedger, executionScopeFor } from "@braingate/core";
import { GoalStore } from "@braingate/goals";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { MeasuredCapabilities, ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "@braingate/write";
import { runRepl } from "./repl.js";
import { ProjectMemory } from "@braingate/memory";

/**
 * One goal, one workspace, four native workers — the multi-provider acceptance.
 *
 * Every runtime here is a fake that answers in *its own* CLI's envelope, because that is the part
 * BrainGate has to read correctly: Claude's `{result}`, Codex's `thread.started`/`agent_message`
 * JSONL, Antigravity's `conversation_id` envelope, Grok's streamed `text`. A fake that spoke one
 * shared shape would prove nothing about the adapters and would pass for an implementation that
 * never learned to tell them apart.
 *
 * What is asserted is the contract rather than the mechanism: one goal across every switch, the
 * workspace itself as the working directory for every worker, writes that land in that workspace
 * and nowhere else, no branch, worktree or commit, and session decisions that match what each
 * runtime actually published — resumed where the id was reported and replayed, fresh where it was
 * not.
 */

const README = "flutter_migration/tabaq_onboarding/ios/Runner/Assets.xcassets/LaunchImage.imageset/README.md";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  return String(result.stdout ?? "").trim();
}

function snapshot(providerId: "anthropic" | "openai" | "google" | "xai", models: readonly string[], version: string): ProviderSnapshot {
  const observedAt = "2026-09-14T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  const binary = providerId === "anthropic" ? "claude" : providerId === "openai" ? "codex" : providerId === "google" ? "agy" : "grok";
  return {
    providerId,
    displayName: providerId,
    binary,
    available: obs(true),
    version: obs(version),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: obs([...models]),
    capabilities: obs({ headless: true, modelPinning: true, sessionIdPinning: providerId === "anthropic" || providerId === "xai", outputFormats: ["json"], supportsMcp: true, supportsSubagents: true }),
    quotaState: obs("unknown"),
    quotaHint: obs(null),
    quotaObservedAt: obs(null),
    refusalBackoffUntil: obs(null),
    observedAt,
  } as unknown as ProviderSnapshot;
}

/** A workspace with one harmless document, and a catalogue with a model on each subscription. */
function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `braingate-cross-${label}-`));
  const repo = join(root, "repo");
  const readme = join(repo, README);
  mkdirSync(join(readme, ".."), { recursive: true });
  writeFileSync(readme, "# Launch Screen Assets\n\nPlaceholder copy for a disposable test workspace.\n");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  mkdirSync(join(repo, ".brain"), { recursive: true });
  writeFileSync(join(repo, ".brain", "project.json"), JSON.stringify({ project_id: label, name: label, repositories: [repo] }));
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const catalog = new ModelCatalog(resolveOperatorState(env, repo).modelCatalogPath);
  for (const [providerId, modelId, coder, speed, writeCapable] of [
    ["anthropic", "claude-sonnet-5", 95, "balanced", true],
    ["anthropic", "claude-haiku-4-5", 85, "fast", true],
    ["google", "gemini-3.8-flash-medium", 90, "balanced", true],
    ["openai", "gpt-6-astra", 92, "balanced", true],
    ["xai", "grok-4.6", 93, "balanced", true],
    ["xai", "grok-4.5", 88, "balanced", true],
  ] as const) {
    catalog.upsert({
      providerId, modelId, quotaPool: `${providerId}-subscription`,
      capabilities: { coder, reviewer: 70, judge: 65 }, speed,
      contextCapacity: 200_000, writeCapable, reasoning: coder, underlyingFamily: null,
    });
  }
  return { root, repo, readme, env, home };
}

/** One recorded invocation: where it ran, what it was told, and which session it continued. */
interface Call {
  readonly providerId: string;
  readonly modelId: string | null;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly task: string;
  readonly resumed: string | null;
  readonly pinned: string | null;
}

/** The four CLIs, each answering in its own dialect, each able to edit the workspace it is given. */
class FakeWorkers {
  readonly reads: Call[] = [];
  readonly writes: Call[] = [];
  #markers = 0;

  readonly shadow: ShadowProcessExecutor = {
    run: async (input: { readonly plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> => {
      const plan = input.plan;
      const call = this.#record(plan, this.reads);
      const answer = `worked in ${plan.cwd}: ${call.task.slice(0, 40)}`;
      const contract = JSON.stringify({ kind: "work", output: answer });
      const base = { spawned: true, timedOut: false, durationMs: 5, stderr: "", removedEnvironmentKeys: Object.freeze([]) };
      if (plan.providerId === "openai") {
        return {
          ...base, exitCode: 0,
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: this.#threadId(call.resumed) }),
            JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: contract } }),
          ].join("\n"),
        };
      }
      if (plan.providerId === "google") {
        return { ...base, exitCode: 0, stdout: JSON.stringify({ conversation_id: this.#conversationId(call.resumed), status: "SUCCESS", response: contract, num_turns: 1 }) };
      }
      if (plan.providerId === "xai") return { ...base, exitCode: 0, stdout: JSON.stringify({ text: contract }) };
      return { ...base, exitCode: 0, stdout: JSON.stringify({ result: contract }) };
    },
  };

  readonly writer: WriteProviderExecutor = {
    run: async (input: { readonly plan: WriteProviderPlan }): Promise<WriteProviderResult> => {
      const plan = input.plan;
      const call = this.#record(plan, this.writes);
      // One inert comment line, in the workspace the plan named, by whichever worker was routed.
      this.#markers += 1;
      const target = join(plan.cwd, README);
      writeFileSync(target, `${readFileSync(target, "utf8")}<!-- marker ${String(this.#markers)} by ${plan.providerId} -->\n`);
      const report = JSON.stringify({ summary: `${plan.providerId} appended marker ${String(this.#markers)}` });
      const base = { spawned: true, timedOut: false, durationMs: 5, stderr: "", removedEnvironmentKeys: Object.freeze([]) };
      if (plan.providerId === "openai") {
        return {
          ...base, exitCode: 0,
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: this.#threadId(call.resumed) }),
            JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: report } }),
          ].join("\n"),
        };
      }
      if (plan.providerId === "google") {
        return { ...base, exitCode: 0, stdout: JSON.stringify({ conversation_id: this.#conversationId(call.resumed), status: "SUCCESS", response: report }) };
      }
      if (plan.providerId === "xai") return { ...base, exitCode: 0, stdout: JSON.stringify({ text: report }) };
      return { ...base, exitCode: 0, stdout: JSON.stringify({ result: report }) };
    },
  };

  #record(plan: { readonly providerId: string; readonly modelId: string; readonly cwd: string; readonly args: readonly string[]; readonly stdin?: string | null; readonly attachmentContent?: string | null }, into: Call[]): Call {
    const brief = plan.stdin !== null && plan.stdin !== undefined && plan.stdin.trim().startsWith("{")
      ? plan.stdin
      : (plan.attachmentContent ?? "") + " " + plan.args.join(" ");
    const task = /"task":"((?:[^"\\]|\\.)*)"/.exec(brief)?.[1]?.replace(/\\"/g, "\"") ?? "";
    const call: Call = {
      providerId: plan.providerId,
      modelId: plan.args[plan.args.indexOf("--model") + 1] ?? null,
      cwd: plan.cwd,
      args: [...plan.args],
      task,
      resumed: continuedSession(plan.providerId, plan.args),
      // Only when the flag is there: reading the element after a flag that is absent silently takes
      // the first argument, which is how a run that pinned nothing looked like it pinned `exec`.
      pinned: plan.args.includes("--session-id") ? plan.args[plan.args.indexOf("--session-id") + 1] ?? null : null,
    };
    into.push(call);
    return call;
  }

  /** Codex mints its own thread id; a resumed run echoes the one it was given. */
  #threadId(resumed: string | null): string {
    if (resumed !== null) return resumed;
    this.threads += 1;
    return `01a09d2f-73db-72b3-8029-6a4786c2eb${String(this.threads).padStart(2, "0")}`;
  }

  #conversationId(resumed: string | null): string {
    if (resumed !== null) return resumed;
    this.threads += 1;
    return `5e1e942f-772b-47e3-b220-e85f65fef3${String(this.threads).padStart(2, "0")}`;
  }

  threads = 0;
  markers = (): number => this.#markers;
  readsFor = (providerId: string): readonly Call[] => this.reads.filter((call) => call.providerId === providerId);
  writesFor = (providerId: string): readonly Call[] => this.writes.filter((call) => call.providerId === providerId);
}

/** The session a run was told to continue, in whichever shape its CLI says it. */
function continuedSession(providerId: string, args: readonly string[]): string | null {
  const flag = args.indexOf("--resume");
  if (flag >= 0) return args[flag + 1] ?? null;
  if (providerId === "openai" && args[0] === "exec" && args[1] === "resume") {
    return args.find((argument) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(argument)) ?? null;
  }
  const conversation = args.indexOf("--conversation");
  return conversation >= 0 ? args[conversation + 1] ?? null : null;
}

function sessionOf(repo: string, env: NodeJS.ProcessEnv, workers: FakeWorkers, answers: readonly string[], measured: Readonly<Record<string, MeasuredCapabilities>> = {}) {
  const remaining = [...answers];
  let out = "";
  let err = "";
  return {
    text: () => `${out}${err}`,
    run: () => runRepl({
      cwd: repo,
      env,
      animate: false,
      colour: false,
      stdout: (text) => { out += text; },
      stderr: (text) => { err += text; },
      ask: async () => remaining.shift() ?? null,
      executor: workers.shadow,
      writeExecutor: workers.writer,
      discoverAll: async () => [
        snapshot("anthropic", ["claude-sonnet-5", "claude-haiku-4-5"], "2.1.270"),
        snapshot("google", ["gemini-3.8-flash-medium"], "1.2.2"),
        snapshot("openai", ["gpt-6-astra"], "0.153.4"),
        snapshot("xai", ["grok-4.6", "grok-4.5"], "1.0.24"),
      ],
      // Each build's own reading: the two that report their ids have no pinning flag, and the probe
      // is asked for whichever feature the provider's policy names.
      probeCapabilities: async (providerId: string) => ({
        features: {
          sessionIdPinning: { supported: providerId === "anthropic" || providerId === "xai" },
          sessionResume: { supported: true },
        },
      }),
      measureCapabilities: async () => measured,
      verifyGrokIsolation: async (item: ProviderSnapshot) => ({
        providerId: "xai" as const, source: "sandbox-event-self-test" as const,
        version: item.version.value ?? "0.0.0", platform: "darwin" as const,
        profileHash: "test-profile", policyHash: "test-policy",
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        readableRoots: [], networkRestricted: true, configSurfaces: [],
      }),
      verifyCodexIsolation: async (item: ProviderSnapshot) => ({
        providerId: "openai" as const, source: "sandbox-self-test" as const,
        version: item.version.value ?? "0.0.0", platform: "darwin" as const,
        profileHash: "test-profile", policyHash: "test-policy",
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        unrecognisedKeys: [], droppedKeys: [], droppedFeatureKeys: [],
      }),
    }),
  };
}

test("one goal, one workspace, four native workers: reads everywhere, DIRECT writes that land", async () => {
  const f = fixture("acceptance");
  const workers = new FakeWorkers();
  const session = sessionOf(f.repo, f.env, workers, [
    // 1. Claude reads the document.
    "/use anthropic/claude-sonnet-5",
    "Summarize the test document in this workspace.", "y",
    // 2. Antigravity is asked for the same read and refused, with the measurement as the reason.
    "/use google/gemini-3.8-flash-medium",
    "Read the same file from the current workspace and tell me what the previous worker established.", "y",
    // 3. Codex inspects it, with no modification.
    "/use openai/gpt-6-astra",
    "Inspect the same file and report what the previous workers established.", "y",
    // 4. A second Codex turn: this one must continue the session Codex reported.
    "What did you find in the file?", "y",
    // 5. Grok verifies it independently.
    "/use xai/grok-4.6",
    "Verify the same file from disk and report its content.", "y",
    // 6. A DIRECT write from a non-Claude worker.
    "Append one inert marker comment to that file. Do not commit and do not create a branch.", "y",
    // 7. A second DIRECT write, from a different non-Claude worker.
    "/use openai/gpt-6-astra",
    "Append a second inert marker comment to the same file. Do not commit.", "y",
    // 8. Back to Claude, to summarize what every worker did.
    "/use anthropic/claude-sonnet-5",
    "Summarize what each worker did during this goal and verify the current file.", "y",
    "/exit",
  ]);
  try {
    assert.equal(await session.run(), 0, session.text());
    const text = session.text();
    const scope = executionScopeFor(new ProjectRegistry(f.home).loadFile(join(f.repo, ".brain", "project.json")), f.repo);
    const goals = new GoalStore(scope.project);
    const ledger = new TaskLedger(scope.project);
    try {
      const goal = goals.activeGoal();
      assert.notEqual(goal, null, "one goal holds the whole cross-provider sequence");

      // Every worker ran in the workspace itself, not in a copy of it, and each got the real cwd.
      const workspace = realpathSync.native(f.repo);
      for (const call of [...workers.reads, ...workers.writes]) {
        assert.equal(call.cwd, workspace, `${call.providerId} ran in the workspace`);
      }

      // All four providers were reached, and the two non-Claude writers wrote the real file.
      assert.equal(workers.readsFor("anthropic").length >= 2, true, "Claude read first and summarized last");
      // Antigravity cannot run a DIRECT read at all — measured, not assumed — so the honest
      // outcome is a refusal that names the measurement rather than an invocation that half-works.
      assert.equal(workers.readsFor("google").length, 0, "Antigravity is not invoked for a DIRECT read");
      // The pin is refused by the router (ROUTE_MANUAL_INELIGIBLE), and the advice line dogfood-cli
      // appends for a blocked pin carries the Antigravity measurement paragraph — exactly the
      // paragraph ADR 0021 Phase D moves behind `--json` and the error object. The terminal gets
      // one line naming the reason and the next step; `packages/shadow/src/native-direct.test.ts`
      // and `packages/router/src/automatic-routing.test.ts` prove the full text still exists.
      assert.match(text, /BrainGate ROUTE_MANUAL_INELIGIBLE: The worker you named cannot run this/, "and the operator is told the reason and where to read more");
      assert.doesNotMatch(text, /auto-denies every tool/, "the measurement paragraph moved behind --json");
      assert.equal(workers.readsFor("xai").length, 1, `Grok verified the file: reads=${JSON.stringify(workers.reads.map((c) => c.providerId))}\nPLANS:\n${[...text.matchAll(/(read-only|write) · [^\n]*/g)].map((m) => m[0]).join("\n")}\nTAIL:\n${text.slice(-700)}`);
      assert.equal(workers.writesFor("xai").length, 1, "Grok performed a DIRECT write");
      assert.equal(workers.writesFor("openai").length, 1, "and so did Codex");
      assert.equal(workers.writesFor("anthropic").length, 0, "Claude wrote nothing in this run");

      // Writes went to the workspace and only there: one worktree, no branch, no commit.
      const onDisk = readFileSync(f.readme, "utf8");
      assert.match(onDisk, /<!-- marker 1 by xai -->/, "the first marker is in the real file");
      assert.match(onDisk, /<!-- marker 2 by openai -->/, "and the second, from a different provider");
      assert.equal(git(f.repo, ["worktree", "list"]).split("\n").length, 1, "no worktree was created");
      assert.equal(git(f.repo, ["log", "--oneline"]).split("\n").length, 1, "no commit was made");
      assert.equal(git(f.repo, ["status", "--short"]).includes("README.md"), true, "the change is the working tree's");

      // Codex reported a thread id on its first turn; the second turn handed that exact id back.
      const codexReads = workers.readsFor("openai");
      assert.equal(codexReads.length, 2, "two Codex turns ran");
      assert.equal(codexReads[0]!.resumed, null, "the first could not resume anything");
      assert.notEqual(codexReads[1]!.resumed, null, "the second resumed the id Codex reported");
      assert.match(text, /resuming native session/, "and the terminal said so");

      // Claude and Grok pin their own ids, so their turns name a session rather than report one.
      assert.equal(workers.readsFor("anthropic")[0]!.pinned !== null, true, "Claude names its session");
      assert.equal(workers.writesFor("xai")[0]!.pinned !== null, true, "and Grok names the one it writes in");

      // The whole sequence is one conversation, and every task belongs to the one goal.
      // Seven turns, not eight: the refused Antigravity request is not a turn. A plan that never
      // became work leaves no history behind, which is the same rule a failed confirmation follows.
      const turns = goals.recentTurns(goal!.conversationId, 50);
      assert.equal(turns.length, 7, `every turn that ran is on the timeline, and only those\n${text}`);
      const tasks = ledger.listTasks().filter((task) => task.goalId === goal!.goalId);
      assert.equal(tasks.length, 7, "and every task recorded the goal it was a work unit of");
      assert.equal(tasks.some((task) => task.title.startsWith("Read the same file from the current workspace")), false, "the refused worker left no task");
      for (const task of tasks) assert.notEqual(task.route, null, `${task.taskId} recorded its route`);

      // Session decisions are on the record for each provider, with the envelope they ran under.
      const sessions = goals.listProviderSessions();
      for (const providerId of ["anthropic", "openai", "xai"]) {
        assert.equal(sessions.some((item) => item.providerId === providerId), true, `${providerId} has a session on record`);
      }
      // And the provider that never ran holds no session: a refusal is not a turn, so it leaves no
      // reference behind either.
      assert.equal(sessions.some((item) => item.providerId === "google"), false, "the refused provider holds no session");
      const reported = codexReads[1]!.resumed;
      const codexSession = sessions.find((item) => item.providerId === "openai" && item.sessionId === reported);
      assert.notEqual(codexSession, undefined, "the id Codex reported is on record");
      assert.equal(codexSession?.goalId, goal!.goalId, "and it belongs to this goal");
      // A write is a different job from a read, so the write did not continue the read's session:
      // it started one of its own, which is the same rule the accepted M20 flow pins for Claude.
      const codexWrite = workers.writesFor("openai")[0]!;
      assert.equal(codexWrite.resumed, null, "the write did not continue the read session");
      assert.equal(codexWrite.pinned, null, "and Codex pins nothing: it reported a second id");
      assert.equal(sessions.some((item) => item.providerId === "openai" && item.sessionId !== reported), true, "so a second Codex session exists for the write");
    } finally { ledger.close(); goals.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Antigravity joins the workspace when its own settings allow headless reads: a DIRECT read and a DIRECT write, with no bypass", async () => {
  // The same fixture, with one difference: the capability probe reports that the operator's
  // Antigravity settings allow headless reads. That is the whole gate, and it is read from their
  // file rather than granted by a flag — so the argv the fake worker receives has to carry no
  // permission bypass of any kind, and the write has to carry Antigravity's own edit posture.
  const f = fixture("antigravity");
  const workers = new FakeWorkers();
  const session = sessionOf(f.repo, f.env, workers, [
    "/use google/gemini-3.8-flash-medium",
    "Read the test document in this workspace and summarize it.", "y",
    "Append one inert marker comment to that file. Do not commit and do not create a branch.", "y",
    "/exit",
  ], { google: { toolDenial: "unknown", declaredSubagents: "unknown", sandbox: "unknown", sessionIdPinning: "unknown", headlessReads: true, headlessShell: true } });
  try {
    assert.equal(await session.run(), 0, session.text());
    const text = session.text();
    assert.doesNotMatch(text, /auto-denies every tool/, `no refusal: the settings opened the gate\n${text.slice(-600)}`);
    const workspace = realpathSync.native(f.repo);

    const reads = workers.readsFor("google");
    assert.equal(reads.length, 1, `Antigravity ran the DIRECT read\n${text.slice(-600)}`);
    assert.equal(reads[0]!.cwd, workspace, "in the workspace itself");
    for (const forbidden of ["--dangerously-skip-permissions", "--sandbox", "--add-dir", "--mode"]) {
      assert.equal(reads[0]!.args.includes(forbidden), false, `${forbidden} is not passed to a read`);
    }

    const writes = workers.writesFor("google");
    assert.equal(writes.length, 1, `and the DIRECT write\n${text.slice(-600)}`);
    assert.equal(writes[0]!.cwd, workspace, "in the workspace itself");
    assert.deepEqual(writes[0]!.args.slice(writes[0]!.args.indexOf("--mode"), writes[0]!.args.indexOf("--mode") + 2), ["--mode", "accept-edits"], "edits approved in Antigravity's own vocabulary");
    for (const forbidden of ["--dangerously-skip-permissions", "--sandbox", "--add-dir"]) {
      assert.equal(writes[0]!.args.includes(forbidden), false, `${forbidden} is not passed to a write`);
    }
    assert.match(readFileSync(f.readme, "utf8"), /<!-- marker 1 by google -->/, "the change landed in the real file");
    assert.equal(git(f.repo, ["log", "--oneline"]).split("\n").length, 1, "no commit was made");

    const scope = executionScopeFor(new ProjectRegistry(f.home).loadFile(join(f.repo, ".brain", "project.json")), f.repo);
    const goals = new GoalStore(scope.project);
    try {
      const goal = goals.activeGoal();
      assert.notEqual(goal, null);
      assert.equal(goals.recentTurns(goal!.conversationId, 50).length, 2, "both turns are on the timeline");
      // Antigravity reports its conversation id; the record keeps it, bound to this goal.
      const sessions = goals.listProviderSessions().filter((item) => item.providerId === "google");
      assert.equal(sessions.length >= 1, true, "the reported conversation is on record");
      assert.equal(sessions.every((item) => item.goalId === goal!.goalId), true, "and belongs to this goal");
    } finally { goals.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("/remember writes into the home this session was given, where /memory and memory promote read", async () => {
  const f = fixture("remember");
  const workers = new FakeWorkers();
  const session = sessionOf(f.repo, f.env, workers, ["/remember the codename is blue falcon", "/memory", "/exit"]);
  try {
    assert.equal(await session.run(), 0, session.text());
    const text = session.text();
    const id = /Recorded proposal ([0-9a-f-]{36})/.exec(text)?.[1];
    assert.notEqual(id, undefined, `a proposal was recorded\n${text.slice(-400)}`);
    assert.match(text, /blue falcon/, "/memory lists it back in the same session");
    // The proposal is in this session's home, not the process's default one.
    const memory = new ProjectMemory(new ProjectRegistry(f.home).loadFile(join(f.repo, ".brain", "project.json")));
    try {
      assert.equal(memory.listProposals().some((proposal) => proposal.proposalId === id), true, "the proposal is readable from the session's own home");
    } finally { memory.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
