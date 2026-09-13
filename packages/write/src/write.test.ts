import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  BrainGateInvariantError,
  ProjectRegistry,
  TaskLedger,
  budgetFor,
  classifyTask,
  parseProjectConfig,
  type RegisteredProject,
  InMemoryObservationWriter,
  ResultStore,
  createFinalizer,
  type TaskClassification,
  type TaskFinalizer,
  type ExecutionProject,
  executionScopeFor,
} from "@braingate/core";
import { redactSecrets } from "@braingate/security";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, ModelRegistry } from "@braingate/router";
import { assertSourceCheckoutUnchanged, codexIsolationProfileHash, sourceCheckoutFingerprint, type CodexIsolationAttestation, type ShadowInvocationPlan, type ShadowProcessExecutor, type ShadowProcessResult } from "@braingate/shadow";
import { WriteDogfoodRunner, assertSourceCheckoutClean, buildWriteTaskPlan, planClaudeWriteInvocation, planWriteInvocation, sessionMissingFrom, type WriteProviderExecutor, type WriteProviderPlan, type WriteProviderResult } from "./index.js";

/**
 * Execution state is workspace-scoped: the fixture's own directory is a workspace like any other.
 * A test that builds a project through this registry is asking for that directory's execution state,
 * which is exactly what `executionScopeFor` resolves for a real command.
 */
function workspace(project: RegisteredProject): ExecutionProject {
  return executionScopeFor(project, project.repositories[0]!).project;
}


/**
 * The finalization seam the runner requires: a ledger, a result directory, and an observation
 * writer. A runner cannot be constructed without one, which is the point — an execution package
 * that could skip its record is how a task ends up with nothing said about it.
 */
function finalizerFor(project: ExecutionProject, ledger: TaskLedger): TaskFinalizer {
  return createFinalizer({
    ledger,
    results: new ResultStore(project.storageDir, { redact: redactSecrets }),
    observations: new InMemoryObservationWriter(),
  });
}

function observationFor(classification: TaskClassification): { predicted: TaskClassification; effective: TaskClassification; prior: null } {
  return { predicted: classification, effective: classification, prior: null };
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout ?? "").trim();
}

function fixture(): { root: string; repo: string; project: ExecutionProject } {
  const root = mkdtempSync(join(tmpdir(), "braingate-write-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "app.txt"), "before\n");
  git(repo, ["add", "app.txt"]); git(repo, ["commit", "-m", "initial"]);
  const registry = new ProjectRegistry(join(root, "brain"));
  const project = workspace(registry.register(parseProjectConfig({ project_id: "write-test", name: "Write Test", repositories: [repo] })));
  return { root, repo, project };
}

function observation<T>(value: T) { return { value, evidence: "native" as const, sourceCommand: null, observedAt: new Date().toISOString() }; }

function snapshot(providerId: "anthropic" | "openai"): ProviderSnapshot {
  return {
    providerId,
    displayName: providerId,
    binary: providerId === "anthropic" ? "claude" : "codex",
    available: observation(true),
    version: observation(providerId === "anthropic" ? "2.1.248" : "1.0.0"),
    authState: observation("authenticated"),
    authMode: observation("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt: new Date().toISOString() },
    capabilities: observation({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt: new Date().toISOString() },
    removedBillingOverrides: [], warnings: [],
  };
}

function router(withCodex = false): CapabilityRouter {
  const registry = new ModelRegistry();
  registry.register({ providerId: "anthropic", modelId: "claude-write", quotaPool: "claude-subscription", capabilities: { coder: 95, reviewer: 80, judge: 80 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null }, { available: true, quotaState: "healthy", quotaHint: 0.1, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: new Date().toISOString() });
  if (withCodex) registry.register({ providerId: "openai", modelId: "codex-review", quotaPool: "chatgpt-subscription", capabilities: { coder: 100, reviewer: 100, judge: 100 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 100, underlyingFamily: null }, { available: true, quotaState: "healthy", quotaHint: 0.1, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: new Date().toISOString() });
  return new CapabilityRouter(registry);
}

class FakeWriter implements WriteProviderExecutor {
  readonly calls: WriteProviderPlan[] = [];
  constructor(private readonly mutate: (cwd: string) => void) {}
  async run(input: { plan: WriteProviderPlan }): Promise<WriteProviderResult> {
    this.calls.push(input.plan); this.mutate(input.plan.cwd);
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "", timedOut: false, durationMs: 5, removedEnvironmentKeys: [] };
  }
}

class FakeReviewExecutor implements ShadowProcessExecutor {
  readonly calls: ShadowInvocationPlan[] = [];
  async run(input: { project: ExecutionProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    const review = JSON.stringify({ kind: "review", verdict: "approve", findings: [] });
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: review } }), stderr: "", timedOut: false, durationMs: 6, removedEnvironmentKeys: [] };
  }
}

function codexIsolation(): CodexIsolationAttestation {
  return { providerId: "openai", source: "sandbox-self-test", version: "1.0.0", platform: process.platform === "darwin" ? "darwin" : "linux", profileHash: codexIsolationProfileHash(), droppedFeatureKeys: [], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
}

test("Claude M11 write profile is restricted, worktree-scoped and keeps task out of argv", () => {
  const plan = planClaudeWriteInvocation({ snapshot: snapshot("anthropic"), model: { providerId: "anthropic", modelId: "claude-write", quotaPool: "claude-subscription" }, cwd: "/tmp/worktree", task: "UNIQUE_PRIVATE_WRITE", context: { file: "app.txt" } });
  const command = plan.args.join(" ");
  assert.match(command, /--restricted/); assert.match(command, /--safe-mode/); assert.match(command, /acceptEdits/); assert.match(command, /Read,Glob,Grep,Edit,Write/);
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB forces permission mode back to default, so the explicit
  // allowlist is what actually lets an edit through; without it every write is denied and the
  // task ends with no changes.
  assert.match(command, /--allowedTools Read,Glob,Grep,Edit,Write/);
  assert.match(command, /Bash,WebFetch,WebSearch/); assert.doesNotMatch(command, /dangerously|--bare|UNIQUE_PRIVATE_WRITE/);
  assert.match(plan.stdin, /UNIQUE_PRIVATE_WRITE/);
});

test("write dry-run makes zero provider calls and creates no worktree", async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new FakeWriter(() => { throw new Error("must not run"); });
  const classification = classifyTask({ text: "change the button label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    const result = await new WriteDogfoodRunner({ project, ledger, router: router(), providers: [snapshot("anthropic")], writer , finalizer: finalizerFor(project, ledger)}).run({ task: "change the button label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, observation: observationFor(classification), context: {}, review: false, dryRun: true });
    assert.equal(result.dryRun, true); assert.equal(writer.calls.length, 0); assert.equal(ledger.listTasks().length, 0); assert.equal(existsSync(join(project.storageDir, "worktrees")), false);
  } finally { ledger.close(); }
});

test("execute changes only the task worktree and never the source checkout", async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new FakeWriter((cwd) => writeFileSync(join(cwd, "app.txt"), "after\n"));
  const classification = classifyTask({ text: "change the button label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    const result = await new WriteDogfoodRunner({ project, ledger, router: router(), providers: [snapshot("anthropic")], writer , finalizer: finalizerFor(project, ledger)}).run({ task: "change the button label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, observation: observationFor(classification), context: {}, review: false });
    assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), "before\n"); assert.equal(git(repo, ["status", "--porcelain"]), "");
    assert.equal(readFileSync(join(result.worktree!.path, "app.txt"), "utf8"), "after\n"); assert.deepEqual(result.changedFiles, ["app.txt"]); assert.match(result.diff, /\+after/);
    assert.equal(result.verification[0]?.passed, true); assert.equal(result.approvalRequired, true); assert.equal(result.mergePerformed, false); assert.equal(result.taskReceipt?.task.state, "completed");
  } finally { ledger.close(); }
});

test("sensitive writes fail closed while preserving a clean source checkout", async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new FakeWriter((cwd) => writeFileSync(join(cwd, ".env"), "SECRET=blocked\n"));
  const classification = classifyTask({ text: "update a small config label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    await assert.rejects(() => new WriteDogfoodRunner({ project, ledger, router: router(), providers: [snapshot("anthropic")], writer , finalizer: finalizerFor(project, ledger)}).run({ task: "update a small config label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, observation: observationFor(classification), context: {}, review: false }), /sensitive path/i);
    assert.equal(git(repo, ["status", "--porcelain"]), ""); assert.equal(writer.calls.length, 1); assert.equal(ledger.listTasks()[0]?.state, "failed");
  } finally { ledger.close(); }
});

test("high-risk writes fail before task/worktree/provider creation", async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new FakeWriter(() => { throw new Error("must not run"); });
  const classification = classifyTask({ text: "fix auth login and session security", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    await assert.rejects(() => new WriteDogfoodRunner({ project, ledger, router: router(true), providers: [snapshot("anthropic"), snapshot("openai")], writer , finalizer: finalizerFor(project, ledger)}).run({ task: "fix auth login and session security", repositoryPath: repo, classification, budget, requiredContextTokens: 500, observation: observationFor(classification), context: {} }), /M11 permits only T0-T2/);
    assert.equal(writer.calls.length, 0); assert.equal(ledger.listTasks().length, 0); assert.equal(existsSync(join(project.storageDir, "worktrees")), false);
  } finally { ledger.close(); }
});

test("independent Codex reviewer receives the ephemeral worktree diff", { skip: process.platform === "win32" }, async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new FakeWriter((cwd) => writeFileSync(join(cwd, "app.txt"), "review-me\n")); const reviewer = new FakeReviewExecutor();
  const classification = classifyTask({ text: "change the button label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    const result = await new WriteDogfoodRunner({ project, ledger, router: router(true), providers: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), writer, reviewExecutor: reviewer , finalizer: finalizerFor(project, ledger)}).run({ task: "change the button label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, observation: observationFor(classification), context: {}, review: true });
    assert.equal(result.review?.providerId, "openai"); assert.equal(result.review?.verdict, "approve"); assert.equal(reviewer.calls.length, 1); assert.match(reviewer.calls[0]?.stdin ?? "", /review-me/); assert.equal(reviewer.calls[0]?.workspaceMode, "staged-clean");
    const receipt = JSON.stringify(result.taskReceipt); assert.doesNotMatch(receipt, /review-me/); assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), "before\n");
  } finally { ledger.close(); }
});

test("write plan is deterministic, zero-call and has no merge surface", () => {
  const classification = classifyTask({ text: "change the button label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  const plan = buildWriteTaskPlan({ router: router(), providers: [snapshot("anthropic")], classification, budget, requiredContextTokens: 500, repositoryPath: "/repo", baseRef: "HEAD", review: false });
  assert.equal(plan.providerCallsOnPlan, 0); assert.equal(plan.createsWorktree, false); assert.equal(plan.mergeAvailable, false); assert.equal(plan.roles[0]?.model.providerId, "anthropic");
});

test("a write task compares the checkout against a fingerprint, not against being clean", async () => {
  // The distinction that matters: an ignored file rewritten during a run leaves `git status`
  // empty and the file changed. Only a fingerprint over content notices.
  const repo = mkdtempSync(join(tmpdir(), "braingate-fingerprint-"));
  const run = (...args: readonly string[]): void => {
    const result = spawnSync("git", [...args], { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, ".env"), "TOKEN=first\n");
  writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
  run("add", ".gitignore", "app.ts");
  run("commit", "-m", "initial");

  const before = sourceCheckoutFingerprint(repo);
  assert.doesNotThrow(() => assertSourceCheckoutClean(repo), "an ignored file does not make a tree dirty");

  writeFileSync(join(repo, ".env"), "TOKEN=second\n");
  // `git status` still sees nothing, which is exactly why it was the wrong guard.
  assert.doesNotThrow(() => assertSourceCheckoutClean(repo));
  assert.throws(
    () => assertSourceCheckoutUnchanged(repo, before),
    (error: unknown) => error instanceof BrainGateInvariantError,
    "the fingerprint must notice a rewritten ignored file",
  );
});

// ---------------------------------------------------------------- the write-scope gate, both ways

/**
 * The M11 guard is unchanged: it still refuses T3+, high and critical risk. What changed is the
 * classification that feeds it, so the tests here run *through the guard* — a request that reaches
 * the runner and is refused, or reaches it and is planned.
 */
test("H: the write-scope gate still refuses real migration, auth and payment work", async () => {
  const highRisk = [
    "Apply this to migrations/001_add_users.sql: ALTER TABLE users ADD COLUMN email TEXT;",
    "Change the authentication acceptance logic in auth/login.ts.",
    "Change the charge and refund behaviour in payments/processor.ts.",
  ];
  for (const task of highRisk) {
    const f = fixture(); const writer = new FakeWriter(() => { throw new Error("must not run"); });
    const classification = classifyTask({ text: task, mode: "write" });
    try {
      await assert.rejects(
        () => new WriteDogfoodRunner({ project: f.project, ledger: new TaskLedger(f.project), router: router(), providers: [snapshot("anthropic")], writer, finalizer: finalizerFor(f.project, new TaskLedger(f.project)) })
          .run({ task, repositoryPath: f.repo, classification, budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 500, context: {}, observation: observationFor(classification), review: false }),
        // The code, not the prose: the message is the operator's explanation and may be reworded.
        (error: unknown) => (error as { readonly code?: string }).code === "WRITE_SCOPE_BLOCKED",
        task,
      );
      assert.equal(writer.calls.length, 0, `${task}: no provider may be reached`);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("A/C/E: an inert documentation edit is admitted, including the dogfood target", async () => {
  const f = fixture(); const writer = new FakeWriter(() => { throw new Error("dry run must not run"); });
  const ledger = new TaskLedger(f.project);
  const task = [
    "Apply the agreed harmless comment-only change to the selected README file:",
    "flutter_migration/tabaq_onboarding/ios/Runner/Assets.xcassets/LaunchImage.imageset/README.md",
    "",
    "Append one inert comment line.",
    "",
    "Modify only that file, do not commit, do not create a branch,",
    "do not use git reset, do not use git clean, do not use git stash, do not use git checkout.",
  ].join("\n");
  const classification = classifyTask({ text: task, mode: "write" });
  assert.equal(classification.complexity, "T2");
  assert.equal(classification.risk, "low");
  try {
    // A dry run is enough to prove the guard admitted it: the plan is built, which is where the
    // scope check lives, and nothing is dispatched.
    const result = await new WriteDogfoodRunner({ project: f.project, ledger, router: router(), providers: [snapshot("anthropic")], writer, finalizer: finalizerFor(f.project, ledger) })
      .run({ task, repositoryPath: f.repo, policy: "direct", classification, budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 500, context: {}, observation: observationFor(classification), review: false, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(writer.calls.length, 0);
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the real DIRECT permission contract

/**
 * The workspace profile must leave the runtime's own permission mode in force.
 *
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is a BrainGate hardening, and Claude Code reacts to it by
 * forcing the permission mode back to `default` — so `--permission-mode acceptEdits` stops taking
 * effect and every Edit waits for an approval a headless run cannot give. Real dogfood produced the
 * CLI's own warning, and a write that could not edit. The worktree profile compensates with an
 * explicit allowlist; the DIRECT profile has none on purpose, so it must not set the scrub.
 */
test("DIRECT does not set the subprocess env scrub, and the worktree profile still does", () => {
  const snapshotAnthropic = snapshot("anthropic");
  const model = { providerId: "anthropic" as const, modelId: "claude-sonnet-5", quotaPool: "claude-subscription" };
  const direct = planWriteInvocation({
    snapshot: snapshotAnthropic, model, cwd: "/workspace", nativeHarness: true,
    task: "add a comment", context: {},
    session: { kind: "fresh", sessionId: "session-1", persistent: true },
  });
  assert.equal(direct.envOverrides.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined, "the workspace keeps the CLI's permission mode");
  assert.equal(direct.allowedEnvKeys.includes("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"), false);
  assert.ok(direct.args.includes("--permission-mode") && direct.args.includes("acceptEdits"), "and the approved write is auto-approved");
  assert.ok(direct.args.includes("--session-id") && direct.args.includes("session-1"), "a fresh write names its session");
  assert.equal(direct.args.includes("--no-session-persistence"), false, "and is allowed to persist it");

  const worktree = planWriteInvocation({
    snapshot: snapshotAnthropic, model, cwd: "/worktree", task: "add a comment", context: {},
    session: { kind: "resumed", sessionId: "session-1", persistent: true },
  });
  assert.equal(worktree.envOverrides.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1", "the isolated mode keeps the hardening it was earned under");
  assert.ok(worktree.args.includes("--tools"), "and compensates with its explicit allowlist");
  assert.ok(worktree.args.includes("--resume") && worktree.args.includes("session-1"));
});

test("a resumed session the runtime no longer has is retried with a fresh one", async () => {
  assert.equal(sessionMissingFrom("No conversation found with session ID: abc"), true);
  assert.equal(sessionMissingFrom("all good"), false);

  const f = fixture(); const ledger = new TaskLedger(f.project);
  let call = 0;
  const writer: WriteProviderExecutor = {
    run: async (input) => {
      call += 1;
      if (call === 1) {
        return { spawned: true, exitCode: 1, timedOut: false, durationMs: 5, removedEnvironmentKeys: Object.freeze([]), stdout: "", stderr: "No conversation found with session ID: gone-1" };
      }
      writeFileSync(join(input.plan.cwd, "app.txt"), "after\n");
      return { spawned: true, exitCode: 0, timedOut: false, durationMs: 5, removedEnvironmentKeys: Object.freeze([]), stdout: JSON.stringify({ result: JSON.stringify({ summary: "changed app.txt" }) }), stderr: "" };
    },
  };
  const classification = classifyTask({ text: "change the button label", mode: "write" });
  try {
    const result = await new WriteDogfoodRunner({
      project: f.project, ledger, router: router(), providers: [snapshot("anthropic")], writer,
      finalizer: finalizerFor(f.project, ledger),
      nativeSession: async () => ({
        decision: { providerId: "anthropic", modelId: "claude-sonnet-5", kind: "resumed", sessionId: "gone-1", resumeMode: "available", reason: null, persistent: true },
        note: "resumed",
      }),
    }).run({
      task: "change the button label", repositoryPath: f.repo, policy: "direct", classification,
      budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 500, context: {},
      observation: { predicted: classification, effective: classification, prior: null }, review: false,
    });
    assert.equal(call, 2, "the write was retried once");
    assert.equal(result.changedFiles.includes("app.txt"), true, "and the retry did the work");
    const events = ledger.receipt(result.taskId!).events;
    assert.ok(events.some((event) => event.kind === "session.unavailable"), "the missing session is recorded rather than swallowed");
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});
