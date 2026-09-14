import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
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
import { codexIsolationProfileHash, type CodexIsolationAttestation, type ShadowInvocationPlan, type ShadowProcessExecutor, type ShadowProcessResult } from "@braingate/shadow";
import { WriteDogfoodRunner, type WriteProviderExecutor, type WriteProviderPlan, type WriteProviderResult } from "./index.js";

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

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

function observation<T>(value: T) { return { value, evidence: "native" as const, sourceCommand: null, observedAt: new Date().toISOString() }; }
function snapshot(providerId: "anthropic" | "openai"): ProviderSnapshot {
  return {
    providerId, displayName: providerId, binary: providerId === "anthropic" ? "claude" : "codex",
    available: observation(true), version: observation(providerId === "anthropic" ? "2.1.248" : "1.0.0"),
    authState: observation("authenticated"), authMode: observation("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt: new Date().toISOString() },
    capabilities: observation({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt: new Date().toISOString() }, removedBillingOverrides: [], warnings: [],
  };
}

class Writer implements WriteProviderExecutor {
  async run(input: { plan: WriteProviderPlan }): Promise<WriteProviderResult> {
    writeFileSync(join(input.plan.cwd, "app.txt"), "candidate\n");
    return { spawned: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, durationMs: 4, removedEnvironmentKeys: [] };
  }
}
class RejectingReviewer implements ShadowProcessExecutor {
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    const body = JSON.stringify({ kind: "review", verdict: "request_changes", findings: ["needs a regression test"] });
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: body } }), stderr: "", timedOut: false, durationMs: 5, removedEnvironmentKeys: [] };
  }
}

function isolation(): CodexIsolationAttestation {
  return { providerId: "openai", source: "sandbox-self-test", version: "1.0.0", platform: process.platform === "darwin" ? "darwin" : "linux", profileHash: codexIsolationProfileHash(), droppedFeatureKeys: [], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
}

test("review request_changes leaves worktree inspectable but marks task blocked", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-write-review-block-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.email", "test@example.invalid"]); git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "app.txt"), "before\n"); git(repo, ["add", "app.txt"]); git(repo, ["commit", "-m", "initial"]);
  const registry = new ProjectRegistry(join(root, "brain"));
  const project = workspace(registry.register(parseProjectConfig({ project_id: "review-block", name: "Review Block", repositories: [repo] })));
  const models = new ModelRegistry();
  models.register({ providerId: "anthropic", modelId: "claude", quotaPool: "claude", capabilities: { coder: 95, reviewer: 80, judge: 80 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null }, { available: true, quotaState: "healthy", quotaHint: 0.1, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: new Date().toISOString() });
  models.register({ providerId: "openai", modelId: "codex", quotaPool: "chatgpt", capabilities: { coder: 100, reviewer: 100, judge: 100 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 100, underlyingFamily: null }, { available: true, quotaState: "healthy", quotaHint: 0.1, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: new Date().toISOString() });
  const ledger = new TaskLedger(project);
  const classification = classifyTask({ text: "change the button label", mode: "write" });
  const budget = budgetFor(classification, { writeRequested: true });
  try {
    const result = await new WriteDogfoodRunner({ project, ledger, router: new CapabilityRouter(models), providers: [snapshot("anthropic"), snapshot("openai")], codexIsolation: isolation(), writer: new Writer(), reviewExecutor: new RejectingReviewer() , finalizer: finalizerFor(project, ledger)}).run({ task: "change the button label", repositoryPath: repo, classification, budget, requiredContextTokens: 500, observation: observationFor(classification), context: {}, review: true });
    assert.equal(result.review?.verdict, "request_changes");
    assert.equal(result.readyForApproval, false);
    assert.equal(result.mergePerformed, false);
    assert.equal(result.taskReceipt?.task.state, "failed");
    assert.ok(result.worktree?.path);
  } finally { ledger.close(); }
});
