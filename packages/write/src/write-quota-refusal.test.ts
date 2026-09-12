import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError, ProjectRegistry, TaskLedger, budgetFor, classifyTask, parseProjectConfig, recordedExecutionAttribution, type RegisteredProject, InMemoryObservationWriter, ResultStore, createFinalizer, type TaskClassification, type TaskFinalizer } from "@braingate/core";
import { redactSecrets } from "@braingate/security";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, ModelRegistry } from "@braingate/router";
import { assertSourceCheckoutUnchanged, codexIsolationProfileHash, sourceCheckoutFingerprint, type CodexIsolationAttestation, type ShadowInvocationPlan, type ShadowProcessExecutor, type ShadowProcessResult } from "@braingate/shadow";
import { WriteDogfoodRunner, assertSourceCheckoutClean, buildWriteTaskPlan, planClaudeWriteInvocation, type WriteProviderExecutor, type WriteProviderPlan, type WriteProviderResult } from "./index.js";
import { providerQuotaRefusal } from "@braingate/shadow";

/**
 * The finalization seam the runner requires: a ledger, a result directory, and an observation
 * writer. A runner cannot be constructed without one, which is the point — an execution package
 * that could skip its record is how a task ends up with nothing said about it.
 */
function finalizerFor(project: RegisteredProject, ledger: TaskLedger): TaskFinalizer {
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
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    const review = JSON.stringify({ kind: "review", verdict: "approve", findings: [] });
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: review } }), stderr: "", timedOut: false, durationMs: 6, removedEnvironmentKeys: [] };
  }
}

function codexIsolation(): CodexIsolationAttestation {
  return { providerId: "openai", source: "sandbox-self-test", version: "1.0.0", platform: process.platform === "darwin" ? "darwin" : "linux", profileHash: codexIsolationProfileHash(), droppedFeatureKeys: [], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
}


/**
 * A write is not retried on a quota refusal, and this is the test that keeps it that way.
 *
 * The section a write runs in has already been created, and a provider process may already have
 * changed it before it failed. Retrying the *same* role on another provider would risk applying a
 * second agent's work on top of a first agent's partial changes, with no way to tell which wrote
 * what — so the refusal is recorded, the task fails closed, and the worktree is released. Failover
 * becomes possible only for a call that provably left nothing behind, which the record below does not
 * yet establish for a write.
 */
const REFUSAL_STDOUT = [
  JSON.stringify({ type: "assistant", is_api_error_message: true, error: "rate_limit", content: [{ type: "text", text: "You've hit your session limit · resets 4:10am (Europe/Istanbul)" }] }),
  JSON.stringify({ type: "result", subtype: "success", is_error: true, num_turns: 1, api_error_status: 429, terminal_reason: "api_error", result: "You've hit your session limit · resets 4:10am (Europe/Istanbul)" }),
].join("\n");

/** A writer whose provider refuses on quota, exactly as the real CLI did. */
class RefusingWriter implements WriteProviderExecutor {
  readonly calls: WriteProviderPlan[] = [];
  async run(input: { plan: WriteProviderPlan }): Promise<WriteProviderResult> {
    this.calls.push(input.plan);
    return { spawned: true, exitCode: 1, stdout: REFUSAL_STDOUT, stderr: "", timedOut: false, durationMs: 8, removedEnvironmentKeys: [] };
  }
}

test("a refused write primary fails closed, records the refusal, and is never failed over", async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new RefusingWriter();
  const classification = classifyTask({ text: "change the button label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    await assert.rejects(() => new WriteDogfoodRunner({ project, ledger, router: router(), providers: [snapshot("anthropic")], writer, finalizer: finalizerFor(project, ledger) }).run({ task: "change the button label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, observation: observationFor(classification), context: {}, review: false }));
    const taskId = ledger.listTasks()[0]!.taskId;
    const receipt = ledger.receipt(taskId);
    // One attempt. No second provider was asked to write into a workspace the first may have touched.
    assert.equal(writer.calls.length, 1);
    assert.equal(receipt.events.filter((event) => event.kind === "shadow.provider.started").length, 1);
    assert.deepEqual(receipt.events.filter((event) => event.kind.startsWith("role.failover.")), [], "the write path has no failover");
    // The refusal itself is recognised and recorded, with the pool and no invented reset.
    const failed = receipt.events.find((event) => event.kind === "shadow.provider.failed")!;
    const refusal = (failed.payload as { readonly quotaRefusal: ReturnType<typeof providerQuotaRefusal> }).quotaRefusal;
    assert.ok(refusal, "the refusal is part of the failure record");
    assert.equal(refusal!.quotaPool, "claude-subscription");
    assert.equal(refusal!.reason, "rate_limit");
    assert.equal(refusal!.resetAt, null);
    // The run failed, the source checkout is untouched, and the worktree is gone.
    assert.equal(receipt.task.state, "failed");
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    // The worktree is left in place, as it is on every write path: it is the evidence of what the
    // agent did, and `WorktreeGuard.cleanup` is the (unused) call that would remove it. Retaining it
    // is exactly why an automatic write failover would be unsafe — there is state to reconcile.
    assert.ok(existsSync(join(project.storageDir, "worktrees")), "the attempted work is kept for inspection");
  } finally { ledger.close(); }
});

test("attribution names the primary that was dispatched and never claims an unexecuted reviewer ran", async () => {
  const { project, repo } = fixture(); const ledger = new TaskLedger(project); const writer = new RefusingWriter();
  const classification = classifyTask({ text: "change the button label", mode: "write" }); const budget = budgetFor(classification, { writeRequested: true });
  try {
    // A review is planned, so the reviewer is part of the plan — but the primary is refused, so the
    // reviewer is never dispatched. The record must say planned, not completed.
    await assert.rejects(() => new WriteDogfoodRunner({ project, ledger, router: router(true), providers: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), writer, reviewExecutor: new FakeReviewExecutor(), finalizer: finalizerFor(project, ledger) }).run({ task: "change the button label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, observation: observationFor(classification), context: {}, review: true }));
    const taskId = ledger.listTasks()[0]!.taskId;
    const receipt = ledger.receipt(taskId);
    const execution = recordedExecutionAttribution(receipt.events);
    assert.ok(execution, "the run records its own attribution");
    const primary = execution!.find((role) => role.role === "primary");
    assert.equal(primary?.status, "attempted", "a refused call started and did not complete");
    assert.equal(primary?.providerId, "anthropic");
    const reviewer = execution!.find((role) => role.role === "reviewer");
    assert.equal(reviewer?.status, "planned", "the reviewer was routed and never dispatched");
  } finally { ledger.close(); }
});
