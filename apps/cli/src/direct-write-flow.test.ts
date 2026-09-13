import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRegistry, executionScopeFor } from "@braingate/core";
import { GoalStore } from "@braingate/goals";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "@braingate/write";
import { runRepl } from "./repl.js";

/**
 * The whole M20 loop, end to end, with fake runtimes.
 *
 * This is the acceptance test for what the product is supposed to be: one conversation and one goal
 * across several native CLIs, a read session that resumes with a delta from another worker, and a
 * DIRECT write that lands in the workspace, joins the same goal, creates its own compatible native
 * session, and calls nobody else. Every runtime below is a fake that behaves like a CLI — it records
 * the argv and cwd it was given and answers in that CLI's envelope — so no subscription is spent.
 */

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  return String(result.stdout ?? "").trim();
}

const README = "flutter_migration/tabaq_onboarding/ios/Runner/Assets.xcassets/LaunchImage.imageset/README.md";

function snapshot(providerId: "anthropic" | "openai", models: readonly string[]): ProviderSnapshot {
  const observedAt = "2026-09-13T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName: providerId === "anthropic" ? "Claude Code" : "Codex CLI",
    binary: providerId === "anthropic" ? "claude" : "codex",
    available: obs(true),
    version: obs("2.1.269"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: obs([...models]),
    capabilities: obs({ headless: true, modelPinning: true, sessionIdPinning: true, outputFormats: ["json"], supportsMcp: true, supportsSubagents: true }),
    quotaState: obs("unknown"),
    quotaHint: obs(null),
    quotaObservedAt: obs(null),
    refusalBackoffUntil: obs(null),
    observedAt,
  } as unknown as ProviderSnapshot;
}

/** A workspace with a real repository, a nested file worth editing, and a configured catalogue. */
function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `braingate-flow-${label}-`));
  const repo = join(root, "repo");
  const readme = join(repo, README);
  mkdirSync(join(readme, ".."), { recursive: true });
  writeFileSync(readme, "# Launch Screen Assets\n\nPlaceholder copy.\n");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  mkdirSync(join(repo, ".brain"), { recursive: true });
  writeFileSync(join(repo, ".brain", "project.json"), JSON.stringify({ project_id: label, name: label, repositories: [repo] }));
  writeFileSync(join(repo, ".git", "info", "exclude"), ".brain/\n");
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  // The catalogue path the operator state resolves, not a guess: a hand-made path left the session
  // reporting MODEL_CATALOG_EMPTY, which is how the real suite's environmental failures look too.
  const catalog = new ModelCatalog(resolveOperatorState({ BRAINGATE_HOME: home }, repo).modelCatalogPath);
  for (const [providerId, modelId, coder, speed] of [
    ["anthropic", "claude-sonnet-5", 95, "balanced"],
    ["anthropic", "claude-haiku-4-5", 85, "fast"],
    ["openai", "gpt-6-astra", 80, "balanced"],
  ] as const) {
    catalog.upsert({
      providerId, modelId, quotaPool: `${providerId}-subscription`,
      capabilities: { coder, reviewer: 70, judge: 65 }, speed,
      contextCapacity: 200_000, writeCapable: true, reasoning: coder, underlyingFamily: null,
    });
  }
  return { root, repo, readme, home, env };
}

/** The fake CLIs: one that answers as a read, one that writes a file when a write is dispatched. */
class FakeClis {
  readonly reads: { readonly cwd: string; readonly args: readonly string[] }[] = [];
  readonly writes: { readonly cwd: string; readonly args: readonly string[] }[] = [];
  #edit: ((cwd: string) => void) | null = null;
  #answer = "the launch image README is a safe file to touch";
  #report = "appended the marker comment";

  onWrite(edit: (cwd: string) => void): this { this.#edit = edit; return this; }
  answering(answer: string): this { this.#answer = answer; return this; }
  reporting(report: string): this { this.#report = report; return this; }

  readonly shadow: ShadowProcessExecutor = {
    run: async (input: { readonly plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> => {
      this.reads.push({ cwd: input.plan.cwd, args: [...input.plan.args] });
      return {
        spawned: true, exitCode: 0, timedOut: false, durationMs: 5, stderr: "", removedEnvironmentKeys: Object.freeze([]),
        stdout: JSON.stringify({ result: JSON.stringify({ kind: "work", output: this.#answer }) }),
      };
    },
  };

  readonly writer: WriteProviderExecutor = {
    run: async (input: { readonly plan: WriteProviderPlan }): Promise<WriteProviderResult> => {
      this.writes.push({ cwd: input.plan.cwd, args: [...input.plan.args] });
      this.#edit?.(input.plan.cwd);
      return {
        spawned: true, exitCode: 0, timedOut: false, durationMs: 5, stderr: "", removedEnvironmentKeys: Object.freeze([]),
        stdout: JSON.stringify({ result: JSON.stringify({ summary: this.#report }) }),
      };
    },
  };
}

function sessionOf(repo: string, env: NodeJS.ProcessEnv, clis: FakeClis, answers: readonly string[]) {
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
      executor: clis.shadow,
      writeExecutor: clis.writer,
      discoverAll: async () => [
        snapshot("anthropic", ["claude-sonnet-5", "claude-haiku-4-5"]),
        snapshot("openai", ["gpt-6-astra"]),
      ],
      probeCapabilities: async () => ({ features: { sessionIdPinning: { supported: true } } }),
      measureCapabilities: async () => ({}),
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

function scopeOf(f: ReturnType<typeof fixture>) {
  return executionScopeFor(new ProjectRegistry(f.home).loadFile(join(f.repo, ".brain", "project.json")), f.repo);
}

// ---------------------------------------------------------------- the acceptance scenario

test("the whole loop: read S1 → read H1 → resume S1 with delta → DIRECT write S2 → verify → write S2 again", async () => {
  const f = fixture("acceptance");
  const clis = new FakeClis();
  // The write appends one inert comment line to the one file the request names — the real edit the
  // dogfood was trying to make, performed here by a fake that behaves like the CLI.
  clis.onWrite((cwd) => {
    const target = join(cwd, README);
    writeFileSync(target, `${readFileSync(target, "utf8")}<!-- DIRECT-mode test marker -->\n`);
  });
  const session = sessionOf(f.repo, f.env, clis, [
    "/use anthropic/claude-sonnet-5",
    "Which file in this repository is safest to change for a reversible test?", "y",
    "/use anthropic/claude-haiku-4-5",
    "Review the previous worker's recommendation. Do not modify files.", "y",
    "/use anthropic/claude-sonnet-5",
    "Tell me what you originally recommended and what Haiku verified.", "y",
    "Apply the agreed harmless comment-only change to the selected README file. Do not commit.", "y",
    "/use anthropic/claude-haiku-4-5",
    "Read that README from disk and confirm the comment is there.", "y",
    "/use anthropic/claude-sonnet-5",
    "Add a second comment line in the same style.", "y",
    "/exit",
  ]);
  try {
    assert.equal(await session.run(), 0, session.text());
    const text = session.text();
    const scope = scopeOf(f);
    const goals = new GoalStore(scope.project);
    const ledger = new (await import("@braingate/core")).TaskLedger(scope.project);
    try {
      // 5, 6, 7: the write was classified as a write, ran under direct, in the workspace, with no
      // worktree and no commit, and the reviewer was not called for a T2/low documentation edit.
      assert.match(text, /write · direct · in your workspace/, "the write runs under DIRECT");
      assert.equal(clis.writes.length, 2, "two writes ran: the request and its follow-up");
      assert.deepEqual(clis.writes.map((call) => call.cwd), [realpathSync.native(f.repo), realpathSync.native(f.repo)], "the worker ran in the real workspace");
      assert.match(readFileSync(f.readme, "utf8"), /DIRECT-mode test marker/, "the file changed on disk");
      assert.equal(git(f.repo, ["worktree", "list"]).split("\n").length, 1, "no worktree was created");
      assert.equal(git(f.repo, ["log", "--oneline"]).split("\n").length, 1, "no commit was made");
      assert.equal(git(f.repo, ["branch", "--list"]).includes("* main"), true);

      // 9, 10: one goal throughout, with the write task inside it and the turn timeline unbroken.
      const goal = goals.activeGoal();
      assert.notEqual(goal, null, "the goal is still active");
      const turns = goals.recentTurns(goal!.conversationId, 50);
      const sessionEvents = ledger.listTasks().flatMap((task) => ledger.receipt(task.taskId).events
        .filter((event) => event.kind === "session.invocation")
        .map((event) => `${task.title.slice(0, 24)}: ${JSON.stringify(event.payload)}`));
      assert.equal(turns.length, 6, `every turn is on the conversation timeline, writes included\n${sessionEvents.join("\n")}\n${text}`);
      const writeTask = ledger.listTasks().find((task) => task.goalId === goal!.goalId && task.title.startsWith("Apply the agreed"));
      assert.notEqual(writeTask, undefined, "the write task belongs to the goal");
      assert.notEqual(writeTask!.route, null, "and its route is recorded, so /status has one to show");

      // 5: READ→WRITE created its own write-compatible session rather than reusing the read one.
      const sessions = goals.listProviderSessions();
      const sonnet = sessions.filter((session) => session.modelId === "claude-sonnet-5");
      const reads = sonnet.filter((session) => session.envelope?.intent === "read");
      const writes = sonnet.filter((session) => session.envelope?.intent === "write");
      assert.equal(reads.length, 1, "the read session is kept");
      assert.equal(writes.length, 1, "and a write session exists beside it");
      assert.notEqual(reads[0]!.sessionId, writes[0]!.sessionId);
      assert.equal(writes[0]!.envelope?.policy, "direct");

      // The first write created the write session; the second write resumed it.
      assert.match(text, new RegExp(`new native session ${writes[0]!.sessionId.slice(0, 8)}`), "the write session was created, not inherited");
      assert.match(text, new RegExp(`resuming native session ${writes[0]!.sessionId.slice(0, 8)}`), "and the next compatible write resumed it");
    } finally { ledger.close(); goals.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a write that changes nothing is recorded truthfully, and no reviewer is called", async () => {
  const f = fixture("no-change");
  const clis = new FakeClis().reporting("I could not edit the file: the path appeared to be read-only.");
  const session = sessionOf(f.repo, f.env, clis, [
    "/use anthropic/claude-sonnet-5",
    "Append a comment line to the launch image README. Do not commit.", "y",
    "/exit",
  ]);
  try {
    assert.equal(await session.run(), 0, session.text());
    const text = session.text();
    assert.match(text, /No change was made/, "the operator is told there is no change");
    assert.match(text, /I could not edit the file/, "with the worker's own words");
    assert.equal(clis.writes.length, 1, "one worker, and no reviewer call");
    assert.equal(clis.reads.length, 0, "no read path ran either");
    assert.equal(readFileSync(f.readme, "utf8").includes("DIRECT-mode test marker"), false, "the file is untouched");

    const scope = scopeOf(f);
    const goals = new GoalStore(scope.project);
    const ledger = new (await import("@braingate/core")).TaskLedger(scope.project);
    try {
      const goal = goals.activeGoal();
      assert.equal(goals.recentTurns(goal!.conversationId, 10).length, 1, "the no-change attempt is still a turn on the timeline");
      const task = ledger.listTasks()[0]!;
      assert.equal(task.state, "failed", "the task is recorded as failed, not as a review refusal");
      const events = ledger.receipt(task.taskId).events.map((event) => event.kind);
      assert.ok(events.includes("write.no_changes"), "with a no-change event");
      assert.ok(events.includes("write.primary.reported"), "and the worker's report");
      assert.equal(events.some((kind) => kind.startsWith("write.review")), false, "and no review at all");
    } finally { ledger.close(); goals.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a pre-existing untracked file neither blocks the write nor is attributed to the worker", async () => {
  const f = fixture("dirty");
  // Ordinary project guidance the operator already had, untracked — the shape that made preflight
  // say `write=blocked` while the write then ran.
  writeFileSync(join(f.repo, "AGENTS.md"), "# Project guidance\n\nUse pnpm.\n");
  const clis = new FakeClis().onWrite((cwd) => {
    const target = join(cwd, README);
    writeFileSync(target, `${readFileSync(target, "utf8")}<!-- DIRECT-mode test marker -->\n`);
  });
  const session = sessionOf(f.repo, f.env, clis, [
    "/use anthropic/claude-sonnet-5",
    "Append a comment line to the launch image README. Do not commit.", "y",
    "/exit",
  ]);
  try {
    assert.equal(await session.run(), 0, session.text());
    const scope = scopeOf(f);
    const ledger = new (await import("@braingate/core")).TaskLedger(scope.project);
    try {
      const task = ledger.listTasks()[0]!;
      const collected = ledger.receipt(task.taskId).events.find((event) => event.kind === "write.changes_collected");
      assert.notEqual(collected, undefined, "the run collected its changes");
      assert.deepEqual((collected!.payload as { changedFiles: readonly string[] }).changedFiles, [README], "only the file the worker touched is attributed to it");
      assert.equal(readFileSync(join(f.repo, "AGENTS.md"), "utf8"), "# Project guidance\n\nUse pnpm.\n", "the operator's untracked file is untouched");
    } finally { ledger.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
