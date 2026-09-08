import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrainGateInvariantError,
  ProjectRegistry,
  TaskLedger,
  budgetFor,
  classifyTask,
  parseProjectConfig,
  type RegisteredProject,
} from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, ModelRegistry, type ModelRef } from "@braingate/router";
import type { AgentRequest } from "@braingate/workflows";
import {
  CODEX_REVIEW_DISABLED_FEATURES,
  CODEX_STAGE_TOKEN,
  CodexIsolationVerifier,
  NodeShadowProcessExecutor,
  ShadowDogfoodRunner,
  SubscriptionShadowAgentInvoker,
  acceptedFeatureKeys,
  codexIsolationProfileHash,
  codexReviewerConfigArgs,
  extractCodexAgentMessage,
  assertSourceCheckoutUnchanged,
  sourceCheckoutFingerprint,
  planShadowInvocation,
  providerFailureReason,
  previewShadowInvocation,
  shadowProviderRoleStatus,
  validOperatorAcceptance,
  shadowProviderStatus,
  validCodexIsolationAttestation,
  type CodexIsolationAttestation,
  type OperatorProviderAcceptance,
  type CodexSandboxRunner,
  type ShadowInvocationPlan,
  type ShadowProcessExecutor,
  type ShadowProcessResult,
  type ShadowRolePayload,
  type SubscriptionAttestation,
} from "./index.js";

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr));
}

// A registered project is always a real checkout, so the fixture is one too: the read-only
// source guard fingerprints it with git, and a bare directory would not exercise that path.
function setupProject() {
  const root = mkdtempSync(join(tmpdir(), "braingate-shadow-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=BrainGate Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"]);
  const registry = new ProjectRegistry(join(root, "registry"));
  const project = registry.register(parseProjectConfig({ project_id: "sample", name: "Sample", repositories: [repo] }));
  return { root, repo, project };
}

function snapshot(providerId: ProviderId, values: { auth?: "subscription" | "api" | "unknown"; state?: "authenticated" | "unauthenticated" | "unknown"; version?: string; binary?: string } = {}): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T, evidence: "native" | "unknown" = "native") => ({ value, evidence, sourceCommand: null, observedAt });
  const binary = providerId === "anthropic" ? "claude" : providerId === "github-copilot" ? "copilot" : providerId === "openai" ? "codex" : providerId;
  return {
    providerId,
    displayName: providerId,
    binary: values.binary ?? binary,
    available: obs(true),
    version: obs(values.version ?? (providerId === "anthropic" ? "2.1.248" : "1.0.0")),
    authState: obs(values.state ?? "authenticated", values.state === "unknown" ? "unknown" : "native"),
    authMode: obs(values.auth ?? "subscription", values.auth === "unknown" ? "unknown" : "native"),
    models: obs(null, "unknown"),
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: obs(null, "unknown"),
    removedBillingOverrides: [], warnings: [],
  };
}

function registryWithClaude(): ModelRegistry {
  const registry = new ModelRegistry();
  registry.register(
    { providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription", capabilities: { coder: 90, reviewer: 90, judge: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 90, underlyingFamily: null },
    { available: true, quotaState: "healthy", quotaPressure: 0.2, observedAt: "2026-09-07T00:00:00Z" },
  );
  return registry;
}

function registryWithClaudeAndCodex(): ModelRegistry {
  const registry = registryWithClaude();
  registry.register(
    { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription", capabilities: { coder: 100, reviewer: 100, judge: 100 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 100, underlyingFamily: null },
    { available: true, quotaState: "healthy", quotaPressure: 0.1, observedAt: "2026-09-07T00:00:00Z" },
  );
  return registry;
}

const model: ModelRef = { providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription" };
const payload: ShadowRolePayload = { schemaVersion: 1, role: "primary", phase: "initial", task: "private task body", findings: [], context: { secretContext: "private context body" }, responseContract: { kind: "work", output: "string" } };

// Times are relative to `reference` so the fixture stays a *current* attestation. Hard-coded
// instants silently turn this into a time bomb: the suite passes until the wall clock crosses
// the literal expiry, then fails everywhere at once for reasons unrelated to the code.
// Call sites that pin `now` must pass the same instant here.
function codexIsolation(values: Partial<CodexIsolationAttestation> = {}, reference = Date.now()): CodexIsolationAttestation {
  return {
    providerId: "openai",
    source: "sandbox-self-test",
    version: "1.0.0",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    profileHash: codexIsolationProfileHash(),
    droppedFeatureKeys: [],
    observedAt: new Date(reference - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(reference + 60 * 60 * 1000).toISOString(),
    ...values,
  };
}

test("Claude profile is restricted/read-only and keeps task/context out of argv", () => {
  const { repo } = setupProject();
  const plan = planShadowInvocation({ snapshot: snapshot("anthropic"), model, cwd: repo, payload, now: new Date("2026-09-07T01:00:00Z") });
  const command = plan.args.join(" ");
  assert.equal(plan.workspaceMode, "project");
  assert.match(command, /--restricted/);
  assert.match(command, /--tools Read,Glob,Grep/);
  assert.match(command, /mcp__\*/);
  assert.match(command, /--no-session-persistence/);
  assert.doesNotMatch(command, /--bare|dangerously-skip|private task body|private context body/);
  assert.match(plan.stdin ?? "", /private task body/);
  assert.doesNotMatch(JSON.stringify(previewShadowInvocation(plan)), /private task body|private context body/);
});

test("Claude restricted profile enforces minimum version and rejects explicit API auth", () => {
  const { repo } = setupProject();
  assert.throws(() => planShadowInvocation({ snapshot: snapshot("anthropic", { version: "2.1.247" }), model, cwd: repo, payload }), /at least 2\.1\.248/);
  assert.throws(() => planShadowInvocation({ snapshot: snapshot("anthropic", { auth: "api" }), model, cwd: repo, payload }), /API billing/);
});

test("Copilot requires proven subscription or short-lived local attestation and exposes only read tools", () => {
  const { repo } = setupProject();
  const copilotModel: ModelRef = { providerId: "github-copilot", modelId: "claude-sonnet-4.6", quotaPool: "copilot" };
  const unknown = snapshot("github-copilot", { auth: "unknown", state: "unknown" });
  assert.throws(() => planShadowInvocation({ snapshot: unknown, model: copilotModel, cwd: repo, payload }), /attestation/);
  const attestation: SubscriptionAttestation = { providerId: "github-copilot", mode: "subscription", source: "user-confirmed-oauth", observedAt: "2026-09-07T00:00:00Z", expiresAt: "2026-09-08T00:00:00Z" };
  const plan = planShadowInvocation({ snapshot: unknown, model: copilotModel, cwd: repo, payload, attestation, now: new Date("2026-09-07T01:00:00Z") });
  assert.equal(plan.workspaceMode, "project");
  const command = plan.args.join(" ");
  assert.match(command, /available-tools=view,grep,glob/);
  assert.match(command, /deny-tool=write/);
  assert.match(command, /deny-tool=shell/);
  assert.match(command, /disable-builtin-mcps/);
  assert.doesNotMatch(command, /private task body|private context body/);
});

test("Codex is enabled only for reviewer role and requires current isolation attestation", { skip: process.platform === "win32" }, () => {
  const { repo } = setupProject();
  const openai = snapshot("openai");
  const codexModel: ModelRef = { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription" };
  assert.equal(shadowProviderStatus("openai").enabled, true);
  assert.equal(shadowProviderRoleStatus("openai", "primary").enabled, false);
  assert.equal(shadowProviderRoleStatus("openai", "reviewer").enabled, true);
  assert.throws(() => planShadowInvocation({ snapshot: openai, model: codexModel, cwd: repo, payload }), /reviewer-only/);
  const reviewPayload: ShadowRolePayload = { ...payload, role: "reviewer", responseContract: { kind: "review", verdict: ["approve", "request_changes", "disagree"], findings: "string[]" } };
  assert.throws(() => planShadowInvocation({ snapshot: openai, model: codexModel, cwd: repo, payload: reviewPayload }), /isolation/);
  const plan = planShadowInvocation({ snapshot: openai, model: codexModel, cwd: repo, payload: reviewPayload, codexIsolation: codexIsolation({}, new Date("2026-09-07T01:00:00Z").getTime()), now: new Date("2026-09-07T01:00:00Z") });
  assert.equal(plan.workspaceMode, "staged-clean");
  assert.equal(plan.inputMode, "stdin");
  assert.ok(plan.args.includes("--ephemeral"));
  assert.ok(plan.args.includes("--ignore-user-config"));
  assert.ok(plan.args.includes("--ignore-rules"));
  assert.ok(plan.args.includes("--strict-config"));
  assert.ok(plan.args.includes("--skip-git-repo-check"));
  assert.ok(plan.args.includes(CODEX_STAGE_TOKEN));
  assert.ok(!plan.args.includes("--sandbox"));
  assert.ok(!plan.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  const command = plan.args.join(" ");
  for (const feature of CODEX_REVIEW_DISABLED_FEATURES) assert.match(command, new RegExp(`features\\.${feature}=false`));
  assert.doesNotMatch(command, /private task body|private context body/);
});

test("Grok and Antigravity automated shadow profiles remain fail closed", () => {
  const { repo } = setupProject();
  for (const providerId of ["xai", "google"] as const) {
    const status = shadowProviderStatus(providerId);
    assert.equal(status.enabled, false);
    // The reason is what a user acts on, so it must say something specific rather than
    // restate that the provider is blocked. It is prose and will be reworded; assert that it
    // exists and is substantive rather than matching its current wording.
    assert.ok((status.reason ?? "").length > 40, `${providerId} must explain why it is blocked`);
    assert.throws(
      () => planShadowInvocation({ snapshot: snapshot(providerId), model: { providerId, modelId: "model-x", quotaPool: `${providerId}-pool` }, cwd: repo, payload }),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_PROVIDER_BLOCKED",
    );
  }
});

class FakeSandboxRunner implements CodexSandboxRunner {
  readonly calls: readonly string[][] = [];
  #index = 0;
  constructor(private readonly results: readonly { exitCode: number; stdout?: string; stderr?: string }[]) {}
  async run(input: { binary: string; args: readonly string[] }): Promise<{ spawned: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    (this.calls as string[][]).push([...input.args]);
    const result = this.results[this.#index++] ?? { exitCode: 1 };
    return { spawned: true, exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: false };
  }
}

test("Codex sandbox self-test proves allow-inside deny-outside deny-write without model calls", async () => {
  const runner = new FakeSandboxRunner([
    { exitCode: 0, stdout: "BRAINGATE_INSIDE_CANARY" },
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "denied" },
    // The ADR 0006 control-key probe: no unknown field reported, so every declared key stands.
    { exitCode: 1, stderr: "stream error: unauthorized" },
  ]);
  const attestation = await new CodexIsolationVerifier({ runner, platform: "linux", env: { PATH: process.env.PATH } }).verify(snapshot("openai"), new Date("2026-09-07T01:00:00Z"));
  assert.equal(runner.calls.length, 4);
  assert.deepEqual(attestation.droppedFeatureKeys, []);
  assert.equal(attestation.profileHash, codexIsolationProfileHash());
  assert.equal(attestation.platform, "linux");
  const sandboxCalls = runner.calls.slice(0, 3);
  assert.ok(sandboxCalls.every((args) => args[0] === "sandbox" && args.includes("--permission-profile")));
  assert.ok(runner.calls.every((args) => !args.includes("--model")), "the probe must never pin a model");
});

test("the control-key probe drops only keys this Codex build rejects, and rebinds the profile hash", async () => {
  // Codex 0.153.4 removed features.worktrees; --strict-config reports one unknown key per run,
  // so the probe drops it and retries.
  const runner = new FakeSandboxRunner([
    { exitCode: 0, stdout: "BRAINGATE_INSIDE_CANARY" },
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "Error loading config.toml: unknown configuration field `features.hooks` in -c/--config override" },
    { exitCode: 1, stderr: "stream error: unauthorized" },
  ]);
  const attestation = await new CodexIsolationVerifier({ runner, platform: "linux", env: { PATH: process.env.PATH } }).verify(snapshot("openai"), new Date("2026-09-07T01:00:00Z"));

  assert.deepEqual(attestation.droppedFeatureKeys, ["hooks"]);
  assert.notEqual(attestation.profileHash, codexIsolationProfileHash(), "a different control set must not reuse the full-set hash");
  assert.equal(attestation.profileHash, codexIsolationProfileHash(acceptedFeatureKeys(["hooks"])));
  assert.ok(validCodexIsolationAttestation(attestation, snapshot("openai"), { platform: "linux", now: new Date("2026-09-07T02:00:00Z") }));

  // The dropped key is gone from the reviewer invocation; everything else still ships.
  const args = codexReviewerConfigArgs("/stage", acceptedFeatureKeys(attestation.droppedFeatureKeys)).join(" ");
  assert.doesNotMatch(args, /features\.hooks=/);
  assert.match(args, /features\.shell_tool=false/);
});

test("an attestation naming a key BrainGate never declared is refused", () => {
  const forged = { ...codexIsolation(), droppedFeatureKeys: ["not_a_braingate_key"] };
  assert.equal(validCodexIsolationAttestation(forged, snapshot("openai"), { platform: "linux", now: new Date("2026-09-07T00:30:00Z") }), false);
});

test("Codex sandbox self-test fails closed if outside read succeeds and native Windows is blocked", async () => {
  const leaking = new FakeSandboxRunner([
    { exitCode: 0, stdout: "BRAINGATE_INSIDE_CANARY" },
    { exitCode: 0, stdout: "BRAINGATE_OUTSIDE_CANARY" },
  ]);
  await assert.rejects(() => new CodexIsolationVerifier({ runner: leaking, platform: "linux", env: { PATH: process.env.PATH } }).verify(snapshot("openai")), /outside/);
  const windows = new FakeSandboxRunner([]);
  await assert.rejects(() => new CodexIsolationVerifier({ runner: windows, platform: "win32", env: { PATH: process.env.PATH } }).verify(snapshot("openai")), /Native Windows/);
  assert.equal(windows.calls.length, 0);
});

test("Codex JSONL parser extracts only completed agent_message and ignores reasoning", () => {
  const answer = JSON.stringify({ kind: "review", verdict: "approve", findings: [] });
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private reasoning" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }),
  ].join("\n");
  assert.equal(extractCodexAgentMessage(stdout), answer);
  assert.throws(() => extractCodexAgentMessage(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: answer } })), /agent_message/);
});

class FakeExecutor implements ShadowProcessExecutor {
  exitCode = 0;
  calls: ShadowInvocationPlan[] = [];
  readonly response: (plan: ShadowInvocationPlan) => string;
  constructor(response: (plan: ShadowInvocationPlan) => string) { this.response = response; }
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    return { spawned: true, exitCode: this.exitCode, stdout: this.response(input.plan), stderr: "", timedOut: false, durationMs: 12, removedEnvironmentKeys: ["OPENAI_API_KEY"] };
  }
}

test("shadow invoker sends Claude payload through stdin while argv remains generic", async () => {
  const { repo, project } = setupProject();
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "safe answer" }) }));
  const invoker = new SubscriptionShadowAgentInvoker({ project, cwd: repo, snapshots: [snapshot("anthropic")], context: { relevant: "context" }, executor: fake });
  const request: AgentRequest = { role: "primary", model, phase: "initial", task: "private task body", findings: [] };
  assert.deepEqual(await invoker.invoke(request), { kind: "work", output: "safe answer" });
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0]!.stdin ?? "", /private task body/);
  assert.doesNotMatch(fake.calls[0]!.args.join(" "), /private task body/);
});

// Both shapes below were produced by real provider CLIs, not invented: Codex omits the literal
// `kind` key while answering the reviewer contract correctly.
test("reviewer response missing the literal kind key is accepted, and a mismatched kind still fails closed", async () => {
  const { repo, project } = setupProject();
  const reviewerRequest: AgentRequest = { role: "reviewer", model: { providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription" }, phase: "review", task: "review this", findings: [] };

  const withoutKind = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ verdict: "approve", findings: [] }) }));
  const accepted = await new SubscriptionShadowAgentInvoker({ project, cwd: repo, snapshots: [snapshot("anthropic")], context: {}, executor: withoutKind }).invoke(reviewerRequest);
  assert.deepEqual(accepted, { kind: "review", verdict: "approve", findings: [] });

  const wrongKind = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", verdict: "approve", findings: [] }) }));
  await assert.rejects(
    () => new SubscriptionShadowAgentInvoker({ project, cwd: repo, snapshots: [snapshot("anthropic")], context: {}, executor: wrongKind }).invoke(reviewerRequest),
    /invalid verdict/,
  );
});

// A fixed six-turn ceiling made every T3 audit of a real repository fail with
// error_max_turns: the budget granted 96k context tokens but not the turns to reach them.
test("inspection turns scale with complexity so a deep task can reach its context budget", () => {
  const turnsFor = (text: string): number => {
    const classification = classifyTask({ text, mode: "ask" });
    return budgetFor(classification, { writeRequested: false }).maxInspectionTurns;
  };
  const trivial = turnsFor("What Node version does this need?");
  const deep = turnsFor("Audit how payment webhooks are verified and whether replay attacks are prevented");
  assert.ok(deep > trivial, `a deep audit must get more turns than a lookup (${String(deep)} vs ${String(trivial)})`);
  assert.ok(deep <= 12, "the profile clamps at 12 turns, so the budget must not exceed it");
});

test("the runner spends the budget's turns rather than a fixed ceiling", async () => {
  const { repo, project } = setupProject();
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "answer" }) }));
  const taskText = "What does the README file say?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  await new ShadowDogfoodRunner({ project, ledger: new TaskLedger(project), router: new CapabilityRouter(registryWithClaude()), snapshots: [snapshot("anthropic")], executor: fake }).run({
    title: "Inspect readme", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
    context: {}, contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 0, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
  });
  const turns = fake.calls[0]!.args[fake.calls[0]!.args.indexOf("--max-turns") + 1];
  assert.equal(turns, String(budget.maxInspectionTurns));
});

test("the role prompt never carries task text and tells the provider not to echo the request", () => {
  const { repo } = setupProject();
  const plan = planShadowInvocation({ snapshot: snapshot("anthropic"), model, cwd: repo, payload, now: new Date("2026-09-07T01:00:00Z") });
  const prompt = plan.args.join(" ");
  assert.doesNotMatch(prompt, /private task body|private context body/);
  assert.match(prompt, /responseContract/);
  assert.match(prompt, /Do not echo the request back/);
  assert.match(prompt, /no markdown code fences/);
});

test("node executor blocks cwd escapes, scrubs API env overrides and stages clean workspace", async () => {
  const { repo, project, root } = setupProject();
  const basePlan: ShadowInvocationPlan = {
    providerId: "anthropic", executable: process.execPath,
    args: ["-e", "process.stdout.write(String(process.env.OPENAI_API_KEY)+' sk-abcdefghijklmnopqrstuvwxyz012345')"],
    cwd: repo, workspaceMode: "project", modelId: "test", quotaPool: "test", inputMode: "stdin", stdin: "{}", attachmentContent: null, attachmentToken: null,
    allowedEnvKeys: [], envOverrides: {}, guarantees: { projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true }, minimumVersion: null,
  };
  const executor = new NodeShadowProcessExecutor();
  const result = await executor.run({ project, plan: basePlan, env: { PATH: process.env.PATH, OPENAI_API_KEY: "should-not-pass" } });
  assert.match(result.stdout, /^undefined /);
  assert.doesNotMatch(result.stdout, /should-not-pass|sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(result.stdout, /REDACTED/);
  await assert.rejects(() => executor.run({ project, plan: { ...basePlan, cwd: root } }), /outside the registered project/);

  const stagedPlan: ShadowInvocationPlan = {
    ...basePlan,
    providerId: "openai",
    workspaceMode: "staged-clean",
    args: ["-e", "process.stdout.write(process.cwd()+'|'+process.argv[1])", CODEX_STAGE_TOKEN],
  };
  const staged = await executor.run({ project, plan: stagedPlan, env: { PATH: process.env.PATH } });
  const [spawnCwd, tokenPath] = staged.stdout.split("|");
  assert.equal(spawnCwd, tokenPath);
  assert.notEqual(spawnCwd, repo);
  assert.equal(existsSync(spawnCwd!), false);
});

test("dogfood dry-run performs full T0 preflight with zero executor calls and zero usage", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const router = new CapabilityRouter(registryWithClaude());
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "unused" }) }));
  const taskText = "Where is the theme config?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    const result = await new ShadowDogfoodRunner({ project, ledger, router, snapshots: [snapshot("anthropic")], executor: fake }).run({
      title: "Inspect theme config", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/theme.ts"] }, contextSummary: { memoryRecords: 1, explicitCandidates: 1, includedItems: 2, estimatedTokens: 500, truncatedItems: 0 }, dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(fake.calls.length, 0);
    assert.equal(result.taskReceipt.usage.length, 0);
    assert.equal(result.taskReceipt.task.state, "completed");
  } finally { ledger.close(); }
});

// The read-only shadow profiles run with cwd set to the real checkout, and their read-only-ness
// is a provider declaration rather than something BrainGate enforces. Every other test drives a
// provider that behaves; these two drive one that does not.
test("a read-only run that mutates the source checkout fails closed and the task is recorded failed", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const misbehaving = new FakeExecutor((plan) => {
    writeFileSync(join(plan.cwd, "provider-escaped.txt"), "written outside the profile\n");
    return JSON.stringify({ result: JSON.stringify({ kind: "work", output: "answer" }) });
  });
  // Deliberately a low-risk read: a T3/T4 task would need a reviewer and fail at routing
  // before ever reaching the guard under test.
  const taskText = "What does the README file say?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const runner = new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registryWithClaude()), snapshots: [snapshot("anthropic")], executor: misbehaving });

  await assert.rejects(
    () => runner.run({
      title: "Inspect readme", task: taskText, cwd: repo, classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 500,
      context: {}, contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 0, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    }),
    /SHADOW_SOURCE_MUTATED|changed the source checkout/,
  );
  assert.equal(existsSync(join(repo, "provider-escaped.txt")), true, "the fixture must actually have written, or the guard proves nothing");
});

// Each of these was silently invisible to a porcelain-status-only fingerprint. They are the
// surfaces that leak credentials, rewrite BrainGate's own view of the project, or grant
// execution on the next git command, so each gets a case rather than a shared loop.
test("the source guard sees writes that git status hides: ignored paths and .git internals", () => {
  const { repo } = setupProject();
  writeFileSync(join(repo, ".gitignore"), ".env\n.brain/\nnode_modules/\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=BrainGate Test", "-c", "user.email=test@example.invalid", "commit", "-m", "ignores"]);
  mkdirSync(join(repo, ".brain"));
  mkdirSync(join(repo, "node_modules"));

  const caught = (label: string, mutate: () => void): void => {
    const before = sourceCheckoutFingerprint(repo);
    mutate();
    assert.throws(() => assertSourceCheckoutUnchanged(repo, before), /changed the source checkout/, label);
  };

  caught("a gitignored credential file", () => writeFileSync(join(repo, ".env"), "SECRET=1\n"));
  caught("BrainGate's own project manifest", () => writeFileSync(join(repo, ".brain", "project.json"), "{}\n"));
  caught("code dropped into an ignored dependency tree", () => writeFileSync(join(repo, "node_modules", "planted.js"), "//\n"));
  caught("a git hook, which runs on the next git command", () => writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n"));
  caught("git config, where core.fsmonitor is an executed command", () => writeFileSync(join(repo, ".git", "config"), "[core]\n\tfsmonitor = /tmp/planted\n"));
});

test("the source guard does not execute a planted core.fsmonitor while checking", () => {
  const { repo } = setupProject();
  const marker = join(repo, "..", "fsmonitor-ran.txt");
  writeFileSync(join(repo, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "sh -c 'touch ${marker}'"\n`);
  // The guard runs git against a checkout an untrusted provider just had write access to, so
  // it must not honour command-valued config it finds there.
  assert.doesNotThrow(() => sourceCheckoutFingerprint(repo));
  assert.equal(existsSync(marker), false, "a planted fsmonitor command must never run");
});

test("a read-only run is still allowed against an already-dirty checkout it does not change", () => {
  const { repo } = setupProject();
  writeFileSync(join(repo, "work-in-progress.txt"), "uncommitted\n");
  const before = sourceCheckoutFingerprint(repo);
  assert.doesNotThrow(() => assertSourceCheckoutUnchanged(repo, before));
  writeFileSync(join(repo, "work-in-progress.txt"), "changed by something else\n");
  assert.throws(() => assertSourceCheckoutUnchanged(repo, before), /changed the source checkout/);
});

test("high-risk workflow routes Claude primary plus Codex independent reviewer when isolation is proven", { skip: process.platform === "win32" }, async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const router = new CapabilityRouter(registryWithClaudeAndCodex());
  const fake = new FakeExecutor((plan) => {
    if (plan.providerId === "anthropic") return JSON.stringify({ result: JSON.stringify({ kind: "work", output: "auth session summary" }) });
    const review = JSON.stringify({ kind: "review", verdict: "approve", findings: [] });
    return [JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "ignored" } }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: review } })].join("\n");
  });
  const taskText = "Where is the auth session stored?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    const result = await new ShadowDogfoodRunner({ project, ledger, router, snapshots: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), executor: fake }).run({
      title: "Inspect auth session", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/auth.ts"] }, contextSummary: { memoryRecords: 1, explicitCandidates: 1, includedItems: 2, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    });
    assert.equal(result.workflow?.primary.model.definition.providerId, "anthropic");
    assert.equal(result.workflow?.reviewer?.model.definition.providerId, "openai");
    assert.equal(result.workflow?.outcome, "approved");
    assert.deepEqual(fake.calls.map((plan) => plan.providerId), ["anthropic", "openai"]);
    assert.equal(fake.calls[1]?.workspaceMode, "staged-clean");
  } finally { ledger.close(); }
});

test("high-risk auth shadow preflight without Codex isolation spends zero provider calls", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const router = new CapabilityRouter(registryWithClaudeAndCodex());
  const fake = new FakeExecutor(() => "must not run");
  const taskText = "Where is the auth session stored?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    await assert.rejects(() => new ShadowDogfoodRunner({ project, ledger, router, snapshots: [snapshot("anthropic"), snapshot("openai")], executor: fake }).run({
      title: "Inspect auth session", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/auth.ts"] }, contextSummary: { memoryRecords: 1, explicitCandidates: 1, includedItems: 2, estimatedTokens: 500, truncatedItems: 0 }, dryRun: true,
    }), /No eligible model for role reviewer/);
    assert.equal(fake.calls.length, 0);
    assert.equal(ledger.listTasks().length, 0);
  } finally { ledger.close(); }
});

// Ensure required deny list is not accidentally emptied by refactors.
test("Codex reviewer deny list and inline profile remain explicit", () => {
  assert.ok(CODEX_REVIEW_DISABLED_FEATURES.length >= 20);
  const args = codexReviewerConfigArgs().join(" ");
  assert.match(args, /:root/);
  assert.match(args, /:minimal/);
  assert.match(args, /enabled = false|enabled=false/);
});

// "failed with exit 1" told the operator nothing: a budget that was too small looked exactly
// like a broken provider. The CLI had already said which it was, and BrainGate discarded it.
test("a provider's own account of a failure is surfaced, with what to do about it", () => {
  const maxTurns = JSON.stringify({ is_error: true, subtype: "error_max_turns", errors: ["Reached maximum number of turns (6)"], result: null });
  assert.equal(providerFailureReason("anthropic", maxTurns, ""), "Reached maximum number of turns (6)");

  // A non-success subtype is a reason even when no message accompanies it.
  assert.equal(providerFailureReason("anthropic", JSON.stringify({ subtype: "error_during_execution" }), ""), "error_during_execution");

  // Providers that do not report structurally still have their first stderr line read.
  assert.equal(providerFailureReason("openai", "", "Error loading config.toml: unknown field\nsecond line"), "Error loading config.toml: unknown field");

  // A successful run has nothing to explain, and neither does silence.
  assert.equal(providerFailureReason("anthropic", JSON.stringify({ subtype: "success" }), ""), null);
  assert.equal(providerFailureReason("anthropic", "", ""), null);
});

test("a provider failure reaches the operator with the reason attached", async () => {
  const { repo, project } = setupProject();
  const exhausted = new FakeExecutor(() => JSON.stringify({ is_error: true, subtype: "error_max_turns", errors: ["Reached maximum number of turns (6)"] }));
  // The fake returns the shape a real run out of turns returns, and exits non-zero.
  exhausted.exitCode = 1;
  const invoker = new SubscriptionShadowAgentInvoker({ project, cwd: repo, snapshots: [snapshot("anthropic")], context: {}, executor: exhausted });
  await assert.rejects(
    () => invoker.invoke({ role: "primary", model, phase: "initial", task: "anything", findings: [] }),
    (error: unknown) => {
      if (!(error instanceof BrainGateInvariantError) || error.code !== "SHADOW_PROVIDER_FAILED") return false;
      // The reason, and a next step rather than a dead end.
      return /Reached maximum number of turns/.test(error.message) && /dogfood feedback/.test(error.message);
    },
  );
});

function acceptance(providerId: ProviderId, values: Partial<OperatorProviderAcceptance> = {}): OperatorProviderAcceptance {
  return { providerId, source: "operator-accepted-unscoped-provider", acceptedAt: new Date(Date.now() - 60_000).toISOString(), ...values } as OperatorProviderAcceptance;
}

// ADR 0008. Refusing to invoke a provider the operator already runs by hand removes nothing from
// their exposure; it only makes BrainGate less useful while the same work happens outside it.
// Eligibility and execution must agree. Declaring a role reachable for a provider that
// planShadowInvocation then refuses is worse than declaring it closed: the router selects the
// model, the operator reads it in the plan, and the failure arrives after they committed.
test("no role is offered for a provider that has no invocation profile", () => {
  const { repo } = setupProject();
  for (const providerId of ["xai", "google"] as const) {
    for (const role of ["planner", "reviewer", "judge"] as const) {
      const status = shadowProviderRoleStatus(providerId, role);
      assert.equal(status.enabled, false, `${providerId}/${role} was offered without a way to run it`);
      assert.match(status.reason ?? "", /not implemented yet/);
    }
    // And planning it really does fail, which is what the eligibility now admits up front.
    assert.throws(
      () => planShadowInvocation({ snapshot: snapshot(providerId), model: { providerId, modelId: "m", quotaPool: `${providerId}-pool` }, cwd: repo, payload }),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_PROVIDER_BLOCKED",
    );
  }
});

test("an acceptance is checked on its own terms: current, unexpired, and for this provider", () => {
  // The acceptance rules are policy that outlives any one provider's implementation status.
  assert.equal(validOperatorAcceptance(acceptance("xai"), "xai"), true);
  assert.equal(validOperatorAcceptance(acceptance("xai", { acceptedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString() }), "xai"), false, "a decision made months ago is not a decision about the provider in front of you");
  assert.equal(validOperatorAcceptance(acceptance("xai", { expiresAt: new Date(Date.now() - 1_000).toISOString() }), "xai"), false);
  assert.equal(validOperatorAcceptance(acceptance("google"), "xai"), false);
  assert.equal(validOperatorAcceptance(undefined, "xai"), false);
});

test("acceptance does not reopen a provider that is closed for a different reason", () => {
  // Codex is reviewer-only because generation and judgement must stay separate, not because of
  // isolation. Accepting risk does not change that.
  assert.equal(shadowProviderRoleStatus("openai", "primary", { acceptance: acceptance("openai") }).enabled, false);
});
