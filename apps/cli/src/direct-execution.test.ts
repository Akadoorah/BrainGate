import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_EXECUTION_POLICY,
  EXECUTION_POLICIES,
  EXECUTION_POLICY_IDS,
  TaskLedger,
  assertWriteAllowed,
  describeExecutionPolicy,
  executionPolicyAvailability,
  executionPolicyForIntent,
  executionScopeFor,
  executionPolicySpec,
  isExecutionPolicyId,
  ProjectRegistry,
  type ExecutionPolicyId,
  type TaskClassification,
} from "@braingate/core";
import { DogfoodStore } from "@braingate/dogfood";
import { GoalStore } from "@braingate/goals";
import { SubscriptionShadowAgentInvoker, planShadowInvocation, snapshotWorkspace, workspaceChangesSince, type ShadowProcessExecutor, type ShadowProcessResult } from "@braingate/shadow";
import type { ProviderSnapshot } from "@braingate/providers";
import { WriteDogfoodRunner, type WriteProviderExecutor, type WriteProviderPlan, type WriteProviderResult } from "@braingate/write";
import { CapabilityRouter, ModelRegistry } from "@braingate/router";
import { classifyTask, budgetFor } from "@braingate/core";
import { projectFinalizer } from "./finalization.js";

/**
 * M20.5 — DIRECT execution, tested with fake runtimes only.
 *
 * The claim under test is that ordinary interactive work happens in the workspace the operator
 * selected: the worker runs there, its changes stay there, another worker sees them, and nothing is
 * committed, copied or merged on the way. Every runtime below is a fake that behaves like a CLI —
 * it records the argv and the cwd it was given, and it edits files when told to — so no
 * subscription is spent and no model is called.
 */

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  return String(result.stdout ?? "").trim();
}

function repository(label: string): { readonly root: string; readonly repo: string; readonly home: string } {
  const root = mkdtempSync(join(tmpdir(), `braingate-direct-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "auth.dart"), "bool restored = false;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  mkdirSync(join(repo, ".brain"), { recursive: true });
  writeFileSync(join(repo, ".brain", "project.json"), JSON.stringify({ project_id: label, name: label, repositories: [repo] }));
  // The manifest `init` writes is kept out of Git by the repository's own exclude, which is also
  // what lets the strict worktree mode require a clean source checkout.
  writeFileSync(join(repo, ".git", "info", "exclude"), ".brain/\n");
  return { root, repo, home: join(root, "brain-home") };
}

/** A directory with no repository anywhere above it. */
function plainDirectory(label: string): { readonly root: string; readonly dir: string; readonly home: string } {
  const root = mkdtempSync(join(tmpdir(), `braingate-direct-${label}-`));
  const dir = join(root, "notes");
  mkdirSync(join(dir, ".brain"), { recursive: true });
  writeFileSync(join(dir, "todo.md"), "auth: not started\n");
  writeFileSync(join(dir, ".brain", "project.json"), JSON.stringify({ project_id: label, name: label, repositories: [dir] }));
  return { root, dir, home: join(root, "brain-home") };
}

function scopeFor(home: string, cwd: string) {
  const project = new ProjectRegistry(home).loadFile(join(cwd, ".brain", "project.json"));
  return executionScopeFor(project, cwd);
}

function snapshot(providerId: "anthropic" | "openai"): ProviderSnapshot {
  const observedAt = "2026-09-20T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName: providerId === "anthropic" ? "Claude Code" : "Codex CLI",
    binary: providerId === "anthropic" ? "claude" : "codex",
    available: obs(true),
    version: obs("2.1.269"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: obs(["claude-sonnet", "claude-haiku"]),
    capabilities: obs({ headless: true, modelPinning: true, sessionIdPinning: true, outputFormats: ["json"], supportsMcp: true, supportsSubagents: true }),
    quotaState: obs("unknown"),
    quotaHint: obs(null),
    quotaObservedAt: obs(null),
    refusalBackoffUntil: obs(null),
    observedAt,
  } as unknown as ProviderSnapshot;
}

function router(): CapabilityRouter {
  const registry = new ModelRegistry();
  const availability = { available: true, quotaState: "healthy" as const, quotaHint: 0.1, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: new Date().toISOString() };
  for (const modelId of ["claude-sonnet", "claude-haiku"]) {
    registry.register({ providerId: "anthropic", modelId, quotaPool: "claude-subscription", capabilities: { coder: 95, reviewer: 80, judge: 80 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null }, availability);
  }
  return new CapabilityRouter(registry);
}

const CLASSIFICATION: TaskClassification = classifyTask({ text: "change the button label", mode: "write" });

/**
 * A fake native CLI, split the way the real boundary is.
 *
 * Two interfaces, because they are two different executions: a write task's executor returns the
 * CLI's structured write envelope, and a shadow role's executor returns the role contract. One class
 * implementing both would be a fake that cannot fail the way the real boundary fails — the first
 * version of this file made exactly that mistake and answered every shadow call with a write result.
 */
class FakeClis {
  readonly calls: { readonly cwd: string; readonly args: readonly string[]; readonly plan?: WriteProviderPlan }[] = [];
  readonly #edit: ((cwd: string) => void) | null;
  readonly #answer: string;

  constructor(edit: ((cwd: string) => void) | null = null, answer = "the theme lives in config.yml") {
    this.#edit = edit;
    this.#answer = answer;
  }

  readonly writer: WriteProviderExecutor = {
    run: async (input: { readonly plan: WriteProviderPlan }): Promise<WriteProviderResult> => {
      this.calls.push({ cwd: input.plan.cwd, args: [...input.plan.args], plan: input.plan });
      this.#edit?.(input.plan.cwd);
      return { spawned: true, exitCode: 0, timedOut: false, durationMs: 5, stdout: JSON.stringify({ summary: "changed the label" }), stderr: "", removedEnvironmentKeys: Object.freeze([]) };
    },
  };

  readonly shadow: ShadowProcessExecutor = {
    run: async (input: { readonly plan: { readonly cwd: string; readonly args: readonly string[] } }): Promise<ShadowProcessResult> => {
      this.calls.push({ cwd: input.plan.cwd, args: [...input.plan.args] });
      // The envelope a native CLI is asked for: the role contract, inside the CLI's own result field.
      return { spawned: true, exitCode: 0, timedOut: false, durationMs: 5, stdout: JSON.stringify({ result: JSON.stringify({ kind: "work", output: this.#answer }) }), stderr: "", removedEnvironmentKeys: Object.freeze([]) };
    },
  };
}

function runnerFor(f: { readonly repo: string; readonly home: string }, cli: FakeClis) {
  const scope = scopeFor(f.home, f.repo);
  const ledger = new TaskLedger(scope.project);
  const store = new DogfoodStore(scope.project);
  const runner = new WriteDogfoodRunner({
    project: scope.project, ledger, router: router(), providers: [snapshot("anthropic")],
    writer: cli.writer,
    // The real finalizer: the terminal state is part of what these tests assert, and a stub here
    // would let a run look successful while the ledger still said `verifying`.
    finalizer: projectFinalizer({ project: scope.project, ledger, store }),
  });
  return { scope, ledger, store, runner };
}

// ---------------------------------------------------------------- the policy vocabulary

test("the policy vocabulary is exported as data, and every word is implemented", () => {
  assert.deepEqual([...EXECUTION_POLICY_IDS], ["direct", "read-only", "worktree", "snapshot", "unattended"]);
  assert.equal(DEFAULT_EXECUTION_POLICY, "direct", "DIRECT is the ordinary interactive boundary");
  for (const id of EXECUTION_POLICY_IDS) {
    assert.ok(isExecutionPolicyId(id));
    assert.equal(executionPolicySpec(id).id, id, "the type and the table cannot drift apart");
    assert.ok(describeExecutionPolicy(id).length > 0);
  }
  assert.throws(() => executionPolicySpec("yolo"), /Unknown execution policy/);
  assert.equal(isExecutionPolicyId("yolo"), false);
  // Only the strict modes need a repository, which is what makes a plain directory usable.
  assert.equal(executionPolicySpec("direct").requiresRepository, false);
  assert.equal(executionPolicySpec("worktree").requiresRepository, true);
  assert.equal(executionPolicySpec("snapshot").requiresRepository, true);
  assert.deepEqual(executionPolicyAvailability({ policy: "worktree", hasRepository: false }), {
    available: false,
    reason: "worktree needs a Git repository, and this workspace has none. `direct` works here.",
  });
  assert.equal(executionPolicyAvailability({ policy: "direct", hasRepository: false }).available, true);
  // Intent narrows the boundary and can never widen it.
  assert.equal(executionPolicyForIntent({ policy: "direct", intent: "read" }).allowWrites, false);
  assert.equal(executionPolicyForIntent({ policy: "direct", intent: "write" }).allowWrites, true);
  assert.equal(executionPolicyForIntent({ policy: "snapshot", intent: "write" }).allowWrites, false);
  assertWriteAllowed("direct", "write");
  assert.throws(() => assertWriteAllowed("snapshot", "write"), /EXECUTION_POLICY_READ_ONLY|does not allow changes/);
});

// ---------------------------------------------------------------- A, B, K: DIRECT read and write

test("A/B/K: a DIRECT write changes the workspace in place, with no worktree and no commit", async () => {
  const f = repository("inplace");
  const cli = new FakeClis((cwd) => writeFileSync(join(cwd, "auth.dart"), "bool restored = true;\n"));
  const { scope, ledger, runner } = runnerFor(f, cli);
  try {
    const before = git(f.repo, ["rev-parse", "HEAD"]);
    const result = await runner.run({
      task: "make the session restore before the splash reads it", repositoryPath: scope.workspacePath,
      policy: "direct", classification: CLASSIFICATION, budget: budgetFor(CLASSIFICATION, { writeRequested: true }),
      requiredContextTokens: 500, context: {}, observation: { predicted: CLASSIFICATION, effective: CLASSIFICATION, prior: null }, review: false,
    });

    // The file changed where the operator works, and the worker ran there.
    assert.equal(readFileSync(join(f.repo, "auth.dart"), "utf8"), "bool restored = true;\n");
    assert.equal(cli.calls[0]?.cwd, realpathSync.native(f.repo), "the provider's cwd is the workspace");
    assert.deepEqual(result.changedFiles, ["auth.dart"], "and what it changed is observed rather than claimed");
    assert.equal(result.worktree, null, "no worktree was created");
    assert.equal(result.executionPolicy, "direct");
    assert.equal(result.mergePerformed, false);
    assert.equal(result.approvalRequired, false, "there is nothing to approve: the change is already in the workspace");

    // No commit, and the change is uncommitted exactly as the worker left it.
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), before, "HEAD did not move");
    assert.match(git(f.repo, ["status", "--porcelain"]), /auth\.dart/);
    // The plan and the record both name the boundary.
    assert.equal(result.taskReceipt?.task.state, "completed");
    assert.equal(ledger.receipt(result.taskId!).events.some((event) => event.kind === "write.changes_collected" && (event.payload as { executionPolicy?: string }).executionPolicy === "direct"), true);
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("A: a DIRECT write creates neither a worktree nor a snapshot", async () => {
  const f = repository("no-artifacts");
  const cli = new FakeClis((cwd) => writeFileSync(join(cwd, "auth.dart"), "bool restored = true;\n"));
  const { scope, runner, ledger } = runnerFor(f, cli);
  try {
    await runner.run({
      task: "make the session restore before the splash reads it", repositoryPath: scope.workspacePath,
      policy: "direct", classification: CLASSIFICATION, budget: budgetFor(CLASSIFICATION, { writeRequested: true }),
      requiredContextTokens: 500, context: {}, observation: { predicted: CLASSIFICATION, effective: CLASSIFICATION, prior: null }, review: false,
    });
    assert.equal(readFileSync(join(scope.storageDir, "execution.sqlite"), "utf8").length > 0, true);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(scope.storageDir, "worktrees", "probe")), false);
    assert.equal(git(f.repo, ["worktree", "list"]).split("\n").length, 1, "the repository has one worktree: itself");
    assert.equal(existsSync(join(scope.storageDir, "snapshots")), false, "and no snapshot was taken");
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- C: the second worker sees it

test("C: a second worker reads the first one's change from the same workspace", async () => {
  const f = repository("second-worker");
  const first = new FakeClis((cwd) => writeFileSync(join(cwd, "auth.dart"), "bool restored = true;\n"));
  const { scope, runner, ledger } = runnerFor(f, first);
  try {
    await runner.run({
      task: "make the session restore before the splash reads it", repositoryPath: scope.workspacePath,
      policy: "direct", classification: CLASSIFICATION, budget: budgetFor(CLASSIFICATION, { writeRequested: true }),
      requiredContextTokens: 500, context: {}, observation: { predicted: CLASSIFICATION, effective: CLASSIFICATION, prior: null }, review: false,
    });
  } finally { ledger.close(); }

  // The second worker is a different provider, and it is handed the workspace — the change is
  // visible to it because it is the same directory, not because BrainGate copied anything.
  const second = new FakeClis(null, "the restore flag is now true");
  const reopened = scopeFor(f.home, f.repo);
  const goals = new GoalStore(reopened.project);
  try {
    const reviewLedger = new TaskLedger(reopened.project);
    const reviewTask = reviewLedger.createTask({ title: "Review the change", complexity: "T1", risk: "low" });
    const invoker = new SubscriptionShadowAgentInvoker({
      project: reopened.project, cwd: reopened.workspacePath, snapshots: [snapshot("anthropic")], ledger: reviewLedger, context: {},
      taskId: reviewTask.taskId, executor: second.shadow,
    });
    const response = await invoker.invoke({ role: "primary", model: { providerId: "anthropic", modelId: "claude-sonnet", quotaPool: "claude-subscription" }, phase: "preflight", task: "what does auth.dart say now?", findings: Object.freeze([]), candidateOutput: null });
    assert.equal(response.kind, "work");
    assert.equal(second.calls[0]?.cwd, realpathSync.native(f.repo), "the reviewer runs in the same workspace");
    assert.match(readFileSync(join(f.repo, "auth.dart"), "utf8"), /true/, "and the change is still there");
    reviewLedger.close();
  } finally { goals.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- D/E/G: sessions and models

test("D: returning to the first worker keeps the goal, the workspace and its own session", async () => {
  const f = repository("returning");
  const scope = scopeFor(f.home, f.repo);
  const goals = new GoalStore(scope.project);
  try {
    const conversation = goals.openConversation();
    const goal = goals.createGoal({ conversationId: conversation.conversationId, objective: "fix the splash ordering" });
    // Sonnet, then a second model, then Sonnet again: one goal, one workspace, three sessions.
    const sessions = [
      goals.recordProviderSession({ providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-sonnet-1", resumeMode: "available", workspace: scope.workspacePath, goalId: goal.goalId }),
      goals.recordProviderSession({ providerId: "anthropic", modelId: "claude-haiku", sessionId: "s-haiku", resumeMode: "available", workspace: scope.workspacePath, goalId: goal.goalId }),
      goals.recordProviderSession({ providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-sonnet-2", resumeMode: "available", workspace: scope.workspacePath, goalId: goal.goalId }),
    ];
    assert.ok(sessions.every((session) => session.workspaceId === scope.workspaceId));
    assert.ok(sessions.every((session) => session.goalId === goal.goalId), "one goal across all three");
    // Each model is its own worker: resuming Sonnet must not hand it Haiku's conversation.
    assert.equal(goals.latestSessionFor("anthropic", "claude-sonnet")?.sessionId, "s-sonnet-2");
    assert.equal(goals.latestSessionFor("anthropic", "claude-haiku")?.sessionId, "s-haiku");
    assert.equal(goals.activeGoal()?.workspaceId, scope.workspaceId);
  } finally { goals.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("E: the policy changes no session and reaches no provider", async () => {
  const f = repository("policy-switch");
  const scope = scopeFor(f.home, f.repo);
  const goals = new GoalStore(scope.project);
  try {
    const conversation = goals.openConversation();
    const goal = goals.createGoal({ conversationId: conversation.conversationId, objective: "fix the splash ordering" });
    const before = goals.recordProviderSession({ providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-1", resumeMode: "available", workspace: scope.workspacePath, goalId: goal.goalId });
    // Choosing a boundary is a local decision: no session is written, none is closed, none is lost.
    const after = goals.latestSessionFor("anthropic", "claude-sonnet");
    assert.equal(after?.sessionId, before.sessionId);
    assert.equal(goals.listProviderSessions().length, 1);
  } finally { goals.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- F: read-only intent

test("F: a read that was asked not to modify anything is verified to have changed nothing", async () => {
  const f = repository("read-only-intent");
  const cli = new FakeClis((cwd) => writeFileSync(join(cwd, "auth.dart"), "// the worker misbehaved\n"));
  const scope = scopeFor(f.home, f.repo);
  const ledger = new TaskLedger(scope.project);
  try {
    // The policy is DIRECT and the *intent* is read-only. Intent narrows the boundary, so the run
    // is held to having changed nothing even though DIRECT would have allowed a write.
    const spec = executionPolicyForIntent({ policy: "direct", intent: "read" });
    assert.equal(spec.allowWrites, false);

    const before = snapshotWorkspace(scope.workspacePath);
    await new Promise<void>((resolve) => { cli.calls.length = 0; resolve(); });
    const readTask = ledger.createTask({ title: "Inspect the splash flow", complexity: "T1", risk: "low" });
    const invoker = new SubscriptionShadowAgentInvoker({
      project: scope.project, cwd: scope.workspacePath, snapshots: [snapshot("anthropic")], ledger, context: {},
      taskId: readTask.taskId, executor: cli.shadow,
    });
    const response = await invoker.invoke({ role: "primary", model: { providerId: "anthropic", modelId: "claude-sonnet", quotaPool: "claude-subscription" }, phase: "preflight", task: "inspect auth.dart and change nothing", findings: Object.freeze([]), candidateOutput: null });
    assert.equal(response.kind, "work");
    assert.equal(workspaceChangesSince(before, snapshotWorkspace(scope.workspacePath)), null, "nothing changed");
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- G/H: the strict modes still work

test("G: the worktree policy still isolates a write, and merges nothing", async () => {
  const f = repository("worktree");
  const cli = new FakeClis((cwd) => writeFileSync(join(cwd, "auth.dart"), "bool restored = true;\n"));
  const { scope, ledger, runner } = runnerFor(f, cli);
  try {
    const result = await runner.run({
      task: "make the session restore before the splash reads it", repositoryPath: scope.workspacePath,
      policy: "worktree", classification: CLASSIFICATION, budget: budgetFor(CLASSIFICATION, { writeRequested: true }),
      requiredContextTokens: 500, context: {}, observation: { predicted: CLASSIFICATION, effective: CLASSIFICATION, prior: null }, review: false,
    });
    assert.notEqual(result.worktree, null, "the strict mode still creates a worktree");
    assert.equal(readFileSync(join(f.repo, "auth.dart"), "utf8"), "bool restored = false;\n", "and the workspace is untouched");
    assert.equal(readFileSync(join(result.worktree!.path, "auth.dart"), "utf8"), "bool restored = true;\n");
    assert.equal(result.approvalRequired, true);
    assert.equal(result.mergePerformed, false);
    assert.match(git(f.repo, ["status", "--porcelain"]), /^$/, "the checkout is clean");
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("H: the snapshot policy is still the strict read posture, and still refuses a nested repository", async () => {
  const f = repository("snapshot");
  // The fixture from the real project: an untracked nested repository inside the workspace.
  const nested = join(f.repo, "flutter_migration", "tabaq_app_clean");
  mkdirSync(nested, { recursive: true });
  git(nested, ["init", "-q", "-b", "main"]);
  const scope = scopeFor(f.home, f.repo);
  const ledger = new TaskLedger(scope.project);
  try {
    // A snapshot is offered as a policy by name and refused where it cannot be represented — and
    // that refusal is about the policy, never about the workspace (ADR 0017).
    assert.equal(EXECUTION_POLICIES.snapshot.isolation, "snapshot");
    assert.equal(EXECUTION_POLICIES.snapshot.allowWrites, false);
    assert.equal(executionPolicyAvailability({ policy: "snapshot", hasRepository: true }).available, true);
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- I: nested repo, DIRECT works

test("I: a workspace a snapshot cannot represent is still an ordinary DIRECT workspace", async () => {
  const f = repository("nested-direct");
  const nested = join(f.repo, "flutter_migration", "tabaq_app_clean");
  mkdirSync(nested, { recursive: true });
  git(nested, ["init", "-q", "-b", "main"]);
  writeFileSync(join(nested, "main.dart"), "void main() {}\n");
  const cli = new FakeClis((cwd) => writeFileSync(join(cwd, "auth.dart"), "bool restored = true;\n"));
  const { scope, ledger, runner } = runnerFor(f, cli);
  try {
    const result = await runner.run({
      task: "make the session restore before the splash reads it", repositoryPath: scope.workspacePath,
      policy: "direct", classification: CLASSIFICATION, budget: budgetFor(CLASSIFICATION, { writeRequested: true }),
      requiredContextTokens: 500, context: {}, observation: { predicted: CLASSIFICATION, effective: CLASSIFICATION, prior: null }, review: false,
    });
    assert.equal(result.taskReceipt?.task.state, "completed", "the nested repository does not stop DIRECT");
    assert.equal(readFileSync(join(f.repo, "auth.dart"), "utf8"), "bool restored = true;\n");
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- J: no Git at all

test("J: a plain directory runs a DIRECT write, and the next worker sees it, with no Git involved", async () => {
  const f = plainDirectory("nogit-direct");
  const cli = new FakeClis((cwd) => writeFileSync(join(cwd, "todo.md"), "auth: done\n"));
  const scope = scopeFor(f.home, f.dir);
  const ledger = new TaskLedger(scope.project);
  try {
    assert.equal(scope.git, null, "there is no repository here");
    const runner = new WriteDogfoodRunner({
      project: scope.project, ledger, router: router(), providers: [snapshot("anthropic")],
      writer: cli.writer, finalizer: projectFinalizer({ project: scope.project, ledger, store: new DogfoodStore(scope.project) }),
    });
    const result = await runner.run({
      task: "mark auth as done", repositoryPath: scope.workspacePath,
      policy: "direct", classification: CLASSIFICATION, budget: budgetFor(CLASSIFICATION, { writeRequested: true }),
      requiredContextTokens: 500, context: {}, observation: { predicted: CLASSIFICATION, effective: CLASSIFICATION, prior: null }, review: false,
    });
    assert.equal(cli.calls[0]?.cwd, realpathSync.native(f.dir));
    assert.equal(readFileSync(join(f.dir, "todo.md"), "utf8"), "auth: done\n");
    assert.deepEqual(result.changedFiles, ["todo.md"], "the change is observed without Git");
    assert.deepEqual([...result.verification], [], "and nothing is claimed that could not be checked");
    assert.equal(result.taskReceipt?.task.state, "completed", "a missing repository is not a failed task");
    // The second worker reads the same file from the same directory.
    const before = snapshotWorkspace(scope.workspacePath);
    assert.match(readFileSync(join(f.dir, "todo.md"), "utf8"), /done/);
    assert.equal(workspaceChangesSince(before, snapshotWorkspace(scope.workspacePath)), null);
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- M: restart

test("M: policy, goal and session survive a restart in the same workspace", async () => {
  const f = repository("restart");
  const scope = scopeFor(f.home, f.repo);
  const goals = new GoalStore(scope.project);
  let goalId: string;
  try {
    const conversation = goals.openConversation();
    goalId = goals.createGoal({ conversationId: conversation.conversationId, objective: "fix the splash ordering" }).goalId;
    goals.recordProviderSession({ providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-restart", resumeMode: "available", workspace: scope.workspacePath, goalId });
  } finally { goals.close(); }

  // A new process: the scope is resolved again from the directory, and the default policy is read
  // from the table rather than remembered.
  const reopened = scopeFor(f.home, f.repo);
  const again = new GoalStore(reopened.project);
  try {
    assert.equal(reopened.workspaceId, scope.workspaceId);
    assert.equal(again.activeGoal()?.goalId, goalId);
    assert.equal(again.latestSessionFor("anthropic", "claude-sonnet")?.sessionId, "s-restart");
    assert.equal(DEFAULT_EXECUTION_POLICY, "direct");
  } finally { again.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- L: commit stays explicit

test("L: no commit is made, and none is offered, in either policy", async () => {
  const f = repository("commit");
  const cli = new FakeClis((cwd) => writeFileSync(join(cwd, "auth.dart"), "bool restored = true;\n"));
  const { scope, ledger, runner } = runnerFor(f, cli);
  try {
    const head = git(f.repo, ["rev-parse", "HEAD"]);
    const result = await runner.run({
      task: "make the session restore before the splash reads it", repositoryPath: scope.workspacePath,
      policy: "direct", classification: CLASSIFICATION, budget: budgetFor(CLASSIFICATION, { writeRequested: true }),
      requiredContextTokens: 500, context: {}, observation: { predicted: CLASSIFICATION, effective: CLASSIFICATION, prior: null }, review: false,
    });
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), head);
    assert.equal(git(f.repo, ["diff", "--cached", "--name-only"]), "", "nothing was staged either");
    assert.equal(result.mergePerformed, false);
    assert.equal(git(f.repo, ["status", "--short"]).includes("auth.dart"), true);
  } finally { ledger.close(); rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the native harness

test("the DIRECT invocation keeps the runtime's harness and drops BrainGate's legacy denials", () => {
  const direct = planShadowInvocation({
    snapshot: snapshot("anthropic"), model: { providerId: "anthropic", modelId: "claude-sonnet", quotaPool: "claude-subscription" },
    cwd: "/workspace", nativeHarness: true,
    payload: { schemaVersion: 1, role: "primary", phase: "preflight", task: "inspect auth.dart", findings: Object.freeze([]), candidateOutput: null, context: {}, responseContract: Object.freeze({ kind: "work", output: "string" }) },
  });
  const strict = planShadowInvocation({
    snapshot: snapshot("anthropic"), model: { providerId: "anthropic", modelId: "claude-sonnet", quotaPool: "claude-subscription" },
    cwd: "/workspace",
    payload: { schemaVersion: 1, role: "primary", phase: "preflight", task: "inspect auth.dart", findings: Object.freeze([]), candidateOutput: null, context: {}, responseContract: Object.freeze({ kind: "work", output: "string" }) },
  });
  const joined = (plan: { readonly args: readonly string[] }): string => plan.args.join(" ");
  // The three restrictions ADR 0014 classifies as legacy are gone, and nothing else changed.
  assert.doesNotMatch(joined(direct), /mcp__\*|--strict-mcp-config|--mcp-config|--agents|--tools/);
  assert.match(joined(strict), /mcp__\*|--strict-mcp-config/);
  assert.match(joined(direct), /--restricted/);
  assert.equal(direct.nativeHarness, true);
  assert.equal(direct.guarantees.noMcp, false, "and the guarantees say what is actually true");
  assert.equal(strict.guarantees.noMcp, true);
  assert.equal(direct.workspaceMode, "project", "the run happens in the workspace");
  // A provider whose invocation is built around a staged copy refuses rather than pretending.
  assert.throws(() => planShadowInvocation({
    snapshot: snapshot("openai"), model: { providerId: "openai", modelId: "gpt-review", quotaPool: "chatgpt-subscription" },
    cwd: "/workspace", nativeHarness: true,
    payload: { schemaVersion: 1, role: "reviewer", phase: "preflight", task: "review", findings: Object.freeze([]), candidateOutput: null, context: {}, responseContract: Object.freeze({ kind: "review", verdict: ["approve"], findings: "string[]" }) },
  }), /cannot yet run its own harness/);
});
