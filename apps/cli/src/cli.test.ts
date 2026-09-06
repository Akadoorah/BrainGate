import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import type { RegisteredProject } from "@braingate/core";
import { runCli } from "./cli.js";

function snapshot(): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId: "anthropic", displayName: "Claude Code", binary: "claude",
    available: obs(true), version: obs("2.1.248"), authState: obs("authenticated"), authMode: obs("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt }, removedBillingOverrides: [], warnings: [],
  };
}

class FakeExecutor implements ShadowProcessExecutor {
  readonly calls: ShadowInvocationPlan[] = [];
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ result: JSON.stringify({ kind: "work", output: "safe ephemeral answer" }) }), stderr: "", timedOut: false, durationMs: 5, removedEnvironmentKeys: [] };
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "braingate-cli-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const manifest = join(root, "project.json");
  writeFileSync(manifest, JSON.stringify({ project_id: "sample", name: "Sample", repositories: [repo] }));
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const state = resolveOperatorState(env, root);
  new ModelCatalog(state.modelCatalogPath).upsert({
    providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription",
    capabilities: { coder: 90, reviewer: 90, judge: 90 }, speed: "balanced", contextCapacity: 200_000,
    writeCapable: false, reasoning: 90, underlyingFamily: null,
  });
  return { root, repo, manifest, home, env };
}

function io() {
  let stdout = "";
  let stderr = "";
  return { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; }, out: () => stdout, err: () => stderr };
}

test("discover and doctor use injected metadata discovery and never invoke a model executor", async () => {
  const f = fixture();
  const fake = new FakeExecutor();
  const output = io();
  const deps = { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: fake, stdout: output.stdout, stderr: output.stderr };
  assert.equal((await runCli(["discover", "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["doctor", "--project", f.manifest, "--json"], deps)).exitCode, 0);
  assert.equal(fake.calls.length, 0);
  assert.doesNotMatch(output.out(), /safe ephemeral answer/);
});

test("shadow plan and run without --execute make zero provider calls and never print the raw task in JSON", async () => {
  const f = fixture();
  const fake = new FakeExecutor();
  const task = "Where is the theme config? UNIQUE_PRIVATE_PROMPT";
  const first = io();
  const deps = { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: fake, stdout: first.stdout, stderr: first.stderr };
  assert.equal((await runCli(["shadow", "plan", "--project", f.manifest, "--task", task, "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["shadow", "run", "--project", f.manifest, "--task", task, "--json"], deps)).exitCode, 0);
  assert.equal(fake.calls.length, 0);
  assert.doesNotMatch(first.out(), /UNIQUE_PRIVATE_PROMPT/);
});

test("shadow run requires explicit --execute to invoke and final answer is ephemeral from status", async () => {
  const f = fixture();
  const fake = new FakeExecutor();
  const executeOut = io();
  const deps = { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: fake, stdout: executeOut.stdout, stderr: executeOut.stderr };
  const executed = await runCli(["shadow", "run", "--project", f.manifest, "--task", "Where is the theme config?", "--execute"], deps);
  assert.equal(executed.exitCode, 0);
  assert.equal(fake.calls.length, 1);
  assert.match(executeOut.out(), /safe ephemeral answer/);

  const statusOut = io();
  const status = await runCli(["status", "--project", f.manifest, "--json"], { cwd: f.repo, env: f.env, stdout: statusOut.stdout, stderr: statusOut.stderr });
  assert.equal(status.exitCode, 0);
  assert.doesNotMatch(statusOut.out(), /safe ephemeral answer|Where is the theme config/);
});

test("shadow preflight rejects cwd outside registered repository before executor call", async () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  const fake = new FakeExecutor();
  const output = io();
  const result = await runCli(["shadow", "plan", "--project", f.manifest, "--task", "Where is the theme config?", "--json"], { cwd: outside, env: f.env, discoverAll: async () => [snapshot()], executor: fake, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 1);
  assert.equal(fake.calls.length, 0);
  assert.match(output.err(), /SHADOW_CWD_ESCAPE/);
});

test("models/status/dashboard safe paths do not invoke provider executor", async () => {
  const f = fixture();
  const fake = new FakeExecutor();
  const output = io();
  let dashboardStarts = 0;
  const deps = {
    cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: fake,
    stdout: output.stdout, stderr: output.stderr,
    startDashboard: async () => { dashboardStarts += 1; return { url: "http://127.0.0.1:4321/" }; },
  };
  assert.equal((await runCli(["models", "validate", "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["models", "list", "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["status", "--project", f.manifest, "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["dashboard", "--project", f.manifest, "--json"], deps)).exitCode, 0);
  assert.equal(dashboardStarts, 1);
  assert.equal(fake.calls.length, 0);
});
