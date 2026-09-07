import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRegistry, type RegisteredProject } from "@braingate/core";
import { DogfoodStore, initializeDogfoodProject } from "@braingate/dogfood";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "@braingate/write";
import { runDogfoodCli } from "./dogfood-cli.js";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout ?? "").trim();
}

function snapshot(): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId: "anthropic",
    displayName: "Claude Code",
    binary: "claude",
    available: obs(true),
    version: obs("2.1.248"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    removedBillingOverrides: [],
    warnings: [],
  };
}

class FakeShadowExecutor implements ShadowProcessExecutor {
  readonly calls: ShadowInvocationPlan[] = [];
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    return {
      spawned: true,
      exitCode: 0,
      stdout: JSON.stringify({ result: JSON.stringify({ kind: "work", output: "safe dogfood answer" }) }),
      stderr: "",
      timedOut: false,
      durationMs: 5,
      removedEnvironmentKeys: [],
    };
  }
}

class FakeWriteExecutor implements WriteProviderExecutor {
  readonly calls: WriteProviderPlan[] = [];
  async run(input: { plan: WriteProviderPlan }): Promise<WriteProviderResult> {
    this.calls.push(input.plan);
    writeFileSync(join(input.plan.cwd, "app.txt"), "after\n");
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "", timedOut: false, durationMs: 8, removedEnvironmentKeys: [] };
  }
}

function fixture(projectId = "sample") {
  const root = mkdtempSync(join(tmpdir(), "braingate-m12-cli-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "app.txt"), "before\n");
  git(repo, ["add", "app.txt"]); git(repo, ["commit", "-m", "initial"]);
  const init = initializeDogfoodProject({ cwd: repo, projectId, name: "Sample" });
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const state = resolveOperatorState(env, repo);
  new ModelCatalog(state.modelCatalogPath).upsert({
    providerId: "anthropic",
    modelId: "claude-test",
    quotaPool: "claude-subscription",
    capabilities: { coder: 95, reviewer: 80, judge: 75 },
    speed: "balanced",
    contextCapacity: 200_000,
    writeCapable: true,
    reasoning: 90,
    underlyingFamily: null,
  });
  return { root, repo, manifest: init.manifestPath, home, env };
}

function io() {
  let stdout = ""; let stderr = "";
  return { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; }, out: () => stdout, err: () => stderr };
}

function projectFor(f: ReturnType<typeof fixture>): RegisteredProject {
  const registry = new ProjectRegistry(f.home);
  return registry.loadFile(f.manifest);
}

test("braingate init is idempotent and keeps the source checkout clean", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-m12-init-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.email", "test@example.invalid"]); git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "x.txt"), "x\n"); git(repo, ["add", "x.txt"]); git(repo, ["commit", "-m", "initial"]);
  const out = io();
  const deps = { cwd: repo, env: { BRAINGATE_HOME: join(root, "brain-home") }, stdout: out.stdout, stderr: out.stderr };
  assert.equal((await runDogfoodCli(["init", "--project-id", "waslo", "--name", "Waslo", "--json"], deps)).exitCode, 0);
  assert.equal((await runDogfoodCli(["init", "--project-id", "waslo", "--name", "Waslo", "--json"], deps)).exitCode, 0);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(JSON.parse(readFileSync(join(repo, ".brain", "project.json"), "utf8")).project_id, "waslo");
});

test("dogfood preflight uses metadata only and reports ask/write readiness", async () => {
  const f = fixture(); const shadow = new FakeShadowExecutor(); const writer = new FakeWriteExecutor(); const out = io();
  const result = await runDogfoodCli(["dogfood", "preflight", "--json"], { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: shadow, writeExecutor: writer, stdout: out.stdout, stderr: out.stderr });
  assert.equal(result.exitCode, 0);
  assert.equal(shadow.calls.length, 0); assert.equal(writer.calls.length, 0);
  assert.match(out.out(), /"providerModelCalls": 0/); assert.match(out.out(), /"ready": true/);
});

test("dogfood ask plan and unexecuted run make zero provider calls and zero observations", async () => {
  const f = fixture(); const shadow = new FakeShadowExecutor(); const out = io();
  const deps = { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: shadow, stdout: out.stdout, stderr: out.stderr };
  const task = "Where is the theme config? UNIQUE_M12_PROMPT";
  assert.equal((await runDogfoodCli(["dogfood", "ask", "plan", "--task", task, "--json"], deps)).exitCode, 0);
  assert.equal((await runDogfoodCli(["dogfood", "ask", "run", "--task", task, "--json"], deps)).exitCode, 0);
  assert.equal(shadow.calls.length, 0); assert.doesNotMatch(out.out(), /UNIQUE_M12_PROMPT/);
  const store = new DogfoodStore(projectFor(f)); try { assert.equal(store.report().runs, 0); } finally { store.close(); }
});

test("dogfood ask execute records sanitized observation then feedback/report", async () => {
  const f = fixture(); const shadow = new FakeShadowExecutor(); const out = io();
  const deps = { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: shadow, stdout: out.stdout, stderr: out.stderr };
  const executed = await runDogfoodCli(["dogfood", "ask", "run", "--task", "Where is the theme config?", "--execute", "--json"], deps);
  assert.equal(executed.exitCode, 0); assert.equal(shadow.calls.length, 1);
  const taskId = (executed.data as { taskId: string }).taskId;
  assert.ok(taskId);
  const feedback = await runDogfoodCli(["dogfood", "feedback", "--task-id", taskId, "--actual-complexity", "T1", "--outcome", "success", "--json"], deps);
  assert.equal(feedback.exitCode, 0);
  const report = await runDogfoodCli(["dogfood", "report", "--json"], deps);
  assert.equal(report.exitCode, 0);
  assert.equal((report.data as { runs: number; feedback: number }).runs, 1); assert.equal((report.data as { feedback: number }).feedback, 1);
  assert.doesNotMatch(JSON.stringify(report.data), /safe dogfood answer|Where is the theme config/);
});

test("dogfood write execute mutates only worktree and records a run", async () => {
  const f = fixture(); const writer = new FakeWriteExecutor(); const out = io();
  const result = await runDogfoodCli(["dogfood", "write", "run", "--task", "change the button label", "--no-review", "--execute", "--json"], { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], writeExecutor: writer, stdout: out.stdout, stderr: out.stderr });
  assert.equal(result.exitCode, 0); assert.equal(writer.calls.length, 1);
  assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "before\n"); assert.equal(git(f.repo, ["status", "--porcelain"]), "");
  assert.equal((result.data as { readyForApproval: boolean; mergePerformed: boolean }).readyForApproval, true); assert.equal((result.data as { mergePerformed: boolean }).mergePerformed, false);
  const store = new DogfoodStore(projectFor(f)); try { assert.equal(store.report().runs, 1); } finally { store.close(); }
});

test("dogfood high-risk write is blocked before worktree/provider execution", async () => {
  const f = fixture(); const writer = new FakeWriteExecutor(); const out = io();
  const result = await runDogfoodCli(["dogfood", "write", "run", "--task", "fix auth login and session security", "--no-review", "--execute", "--json"], { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], writeExecutor: writer, stdout: out.stdout, stderr: out.stderr });
  assert.equal(result.exitCode, 1); assert.equal(writer.calls.length, 0); assert.match(out.err(), /WRITE_SCOPE_BLOCKED/); assert.equal(git(f.repo, ["status", "--porcelain"]), "");
});

test("dogfood export writes only sanitized regression metadata", async () => {
  const f = fixture(); const shadow = new FakeShadowExecutor(); const out = io();
  const deps = { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: shadow, stdout: out.stdout, stderr: out.stderr };
  const executed = await runDogfoodCli(["dogfood", "ask", "run", "--task", "Where is config?", "--execute", "--json"], deps);
  const taskId = (executed.data as { taskId: string }).taskId;
  await runDogfoodCli(["dogfood", "feedback", "--task-id", taskId, "--actual-complexity", "T2", "--actual-risk", "medium", "--outcome", "failed", "--regression", "--json"], deps);
  const exported = await runDogfoodCli(["dogfood", "export", "--json"], deps);
  assert.equal(exported.exitCode, 0);
  const text = readFileSync((exported.data as { path: string }).path, "utf8");
  assert.match(text, /"schemaVersion":1/); assert.doesNotMatch(text, /Where is config|safe dogfood answer|candidateOutput|reasoning|diff/);
});
