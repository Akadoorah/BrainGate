import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError, ProjectRegistry, TaskLedger, budgetFor, classifyTask, parseProjectConfig, type RegisteredProject } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, ModelRegistry } from "@braingate/router";
import { assertSourceCheckoutUnchanged, codexIsolationProfileHash, sourceCheckoutFingerprint, type CodexIsolationAttestation, type ShadowInvocationPlan, type ShadowProcessExecutor, type ShadowProcessResult } from "@braingate/shadow";
import { WriteDogfoodRunner, assertSourceCheckoutClean, buildWriteTaskPlan, planClaudeWriteInvocation, type WriteProviderExecutor, type WriteProviderPlan, type WriteProviderResult } from "./index.js";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout ?? "").trim();
}

function fixture(): { root: string; repo: string; project: RegisteredProject } {
  const root = mkdtempSync(join(tmpdir(), "braingate-write-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "app.txt"), "before\n");
  git(repo, ["add", "app.txt"]); git(repo, ["commit", "-m", "initial"]);
  const registry = new ProjectRegistry(join(root, "brain"));
  const project = registry.register(parseProjectConfig({ project_id: "write-test", name: "Write Test", repositories: [repo] }));
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
  registry.register({ providerId: "anthropic", modelId: "claude-write", quotaPool: "claude-subscription", capabilities: { coder: 95, reviewer: 80, judge: 80 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null }, { available: true, quotaState: "healthy", quotaPressure: 0.1, observedAt: new Date().toISOString() });
  if (withCodex) registry.register({ providerId: "openai", modelId: "codex-review", quotaPool: "chatgpt-subscription", capabilities: { coder: 100, reviewer: 100, judge: 100 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 100, underlyingFamily: null }, { available: true, quotaState: "healthy", quotaPressure: 0.1, observedAt: new Date().toISOString() });
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
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
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
    const result = await new WriteDogfoodRunner({ project, ledger, router: router(), providers: [snapshot("anthropic")], writer }).run({ task: "change the button label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, context: {}, review: false, dryRun: true });
    assert.equal(result.dryRun, true); assert.equal(writer.calls.length, 0); assert.equal(ledger.listTasks().length, 0); assert.equal(existsSync(join(project.storageDir, "worktrees")), false);
  } finally { ledger.close(); }
});

test("execute changes only the task worktree and never the source checkout", async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new FakeWriter((cwd) => writeFileSync(join(cwd, "app.txt"), "after\n"));
  const classification = classifyTask({ text: "change the button label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    const result = await new WriteDogfoodRunner({ project, ledger, router: router(), providers: [snapshot("anthropic")], writer }).run({ task: "change the button label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, context: {}, review: false });
    assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), "before\n"); assert.equal(git(repo, ["status", "--porcelain"]), "");
    assert.equal(readFileSync(join(result.worktree!.path, "app.txt"), "utf8"), "after\n"); assert.deepEqual(result.changedFiles, ["app.txt"]); assert.match(result.diff, /\+after/);
    assert.equal(result.verification[0]?.passed, true); assert.equal(result.approvalRequired, true); assert.equal(result.mergePerformed, false); assert.equal(result.taskReceipt?.task.state, "completed");
  } finally { ledger.close(); }
});

test("sensitive writes fail closed while preserving a clean source checkout", async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new FakeWriter((cwd) => writeFileSync(join(cwd, ".env"), "SECRET=blocked\n"));
  const classification = classifyTask({ text: "update a small config label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    await assert.rejects(() => new WriteDogfoodRunner({ project, ledger, router: router(), providers: [snapshot("anthropic")], writer }).run({ task: "update a small config label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, context: {}, review: false }), /sensitive path/i);
    assert.equal(git(repo, ["status", "--porcelain"]), ""); assert.equal(writer.calls.length, 1); assert.equal(ledger.listTasks()[0]?.state, "failed");
  } finally { ledger.close(); }
});

test("high-risk writes fail before task/worktree/provider creation", async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new FakeWriter(() => { throw new Error("must not run"); });
  const classification = classifyTask({ text: "fix auth login and session security", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    await assert.rejects(() => new WriteDogfoodRunner({ project, ledger, router: router(true), providers: [snapshot("anthropic"), snapshot("openai")], writer }).run({ task: "fix auth login and session security", repositoryPath: repo, classification, budget, requiredContextTokens: 500, context: {} }), /M11 permits only T0-T2/);
    assert.equal(writer.calls.length, 0); assert.equal(ledger.listTasks().length, 0); assert.equal(existsSync(join(project.storageDir, "worktrees")), false);
  } finally { ledger.close(); }
});

test("independent Codex reviewer receives the ephemeral worktree diff", { skip: process.platform === "win32" }, async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new FakeWriter((cwd) => writeFileSync(join(cwd, "app.txt"), "review-me\n")); const reviewer = new FakeReviewExecutor();
  const classification = classifyTask({ text: "change the button label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    const result = await new WriteDogfoodRunner({ project, ledger, router: router(true), providers: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), writer, reviewExecutor: reviewer }).run({ task: "change the button label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, context: {}, review: true });
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
