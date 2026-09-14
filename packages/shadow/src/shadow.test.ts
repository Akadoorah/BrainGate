import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrainGateInvariantError,
  InMemoryObservationWriter,
  recordedExecutionAttribution,
  ProjectRegistry,
  ResultStore,
  TaskLedger,
  budgetFor,
  classifyTask,
  createFinalizer,
  parseProjectConfig,
  type RegisteredProject,
  type TaskClassification,
  type TaskFinalizer,
  type ExecutionProject,
  executionScopeFor,
} from "@braingate/core";
import { redactSecrets } from "@braingate/security";
import { executionAttribution, finalizedSnapshotOf } from "@braingate/core";
import type { TaskSnapshotProvider } from "./snapshot-provider.js";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, ModelRegistry, type ModelRef } from "@braingate/router";
import type { AgentRequest } from "@braingate/workflows";
import {

  CODEX_REVIEW_DISABLED_FEATURES,
  STAGE_PATH_TOKEN,
  CodexIsolationVerifier,
  NodeShadowProcessExecutor,
  ShadowDogfoodRunner,
  SubscriptionShadowAgentInvoker,
  acceptedFeatureKeys,
  CODEX_PROBE_VERSION,
  snapshotPrimaryEligibility,
  GROK_SNAPSHOT_PROBE_VERSION,
  GROK_STAGED_PROBE_VERSION,
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
  providerTokenUsage,
  validCodexIsolationAttestation,
  validGrokIsolationAttestation,
  grokIsolationProfileHash,
  grokSnapshotReadProfileHash,
  GROK_SNAPSHOT_READ_SANDBOX,
  createIsolatedGrokHome,
  validGrokSnapshotReadAttestation,
  grokConfigSurfaces,
  grokSandboxProfileToml,
  extractAntigravityResult,
  jsonSchemaFor,
  lastBalancedJsonObject,
  readStreamLine,
  resolveToolGrant,
  type ToolGrant,
  STAGED_SCHEMA_FILE,
  latestProfileApplied,
  unexpectedRoots,
  GROK_SANDBOX_PROFILE,
  type GrokIsolationAttestation,
  type CodexIsolationAttestation,
  type OperatorProviderAcceptance,
  type CodexSandboxRunner,
  type ShadowInvocationPlan,
  type ShadowProcessExecutor,
  type ShadowProcessResult,
  type ShadowRolePayload,
  type SubscriptionAttestation,
} from "./index.js";

/**
 * Execution state is workspace-scoped: the fixture's own directory is a workspace like any other.
 * A test that builds a project through this registry is asking for that directory's execution state,
 * which is exactly what `executionScopeFor` resolves for a real command.
 */
function workspace(project: RegisteredProject): ExecutionProject {
  return executionScopeFor(project, project.repositories[0]!).project;
}

/**
 * The finalization seam the runner requires.
 *
 * A runner cannot be constructed without one, which is the point: an execution package that could
 * silently skip its record is how a task ends up in the ledger with nothing said about it.
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
  const project = workspace(registry.register(parseProjectConfig({ project_id: "sample", name: "Sample", repositories: [repo] })));
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
    { available: true, quotaState: "healthy", quotaHint: 0.2, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-07T00:00:00Z" },
  );
  return registry;
}

function registryWithClaudeAndCodex(): ModelRegistry {
  const registry = registryWithClaude();
  registry.register(
    { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription", capabilities: { coder: 100, reviewer: 100, judge: 100 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 100, underlyingFamily: null },
    { available: true, quotaState: "healthy", quotaHint: 0.1, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-07T00:00:00Z" },
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
    probeVersion: CODEX_PROBE_VERSION,
    profileHash: codexIsolationProfileHash(),
    droppedFeatureKeys: [],
    observedAt: new Date(reference - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(reference + 60 * 60 * 1000).toISOString(),
    ...values,
  };
}

function readOnlyGrant(providerId: ProviderId, workspaceMode: "project" | "staged-clean" | "staged-read-snapshot" = "project"): ToolGrant {
  return resolveToolGrant({
    role: "primary", providerId, workspaceMode, writeMode: false,
    surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: false, enforcedSandbox: false },
    attested: true, operatorAccepted: false,
  });
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

test("Codex runs the staged roles and nothing that needs the checkout, with a current attestation", { skip: process.platform === "win32" }, () => {
  const { repo } = setupProject();
  const openai = snapshot("openai");
  const codexModel: ModelRef = { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription" };
  assert.equal(shadowProviderStatus("openai").enabled, true);
  // `primary` is the one role a staged workspace cannot fill: it would have to read the real
  // checkout, which the stage deliberately does not contain.
  assert.equal(shadowProviderRoleStatus("openai", "primary").enabled, false);
  for (const role of ["planner", "reviewer", "judge"] as const) {
    assert.equal(shadowProviderRoleStatus("openai", role).enabled, true, role);
  }
  assert.throws(() => planShadowInvocation({ snapshot: openai, model: codexModel, cwd: repo, payload }), /staged roles only/);
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
  assert.ok(plan.args.includes(STAGE_PATH_TOKEN));
  assert.ok(!plan.args.includes("--sandbox"));
  assert.ok(!plan.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  const command = plan.args.join(" ");
  for (const feature of CODEX_REVIEW_DISABLED_FEATURES) assert.match(command, new RegExp(`features\\.${feature}=false`));
  assert.doesNotMatch(command, /private task body|private context body/);
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

test("Antigravity is closed until the operator accepts what BrainGate cannot check", () => {
  const { repo } = setupProject();
  // agy keeps settings and credentials under one HOME, so BrainGate cannot hand it an isolated
  // one the way it can Codex and Grok. Nothing about that is provable, so nothing here tries:
  // the provider stays closed until the operator records the decision themselves.
  const status = shadowProviderStatus("google");
  assert.equal(status.enabled, false);
  assert.ok((status.reason ?? "").length > 40, "google must explain why it is blocked");
  assert.throws(
    () => planShadowInvocation({ snapshot: snapshot("google"), model: { providerId: "google", modelId: "model-x", quotaPool: "google-pool" }, cwd: repo, payload: { ...payload, role: "planner" } }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_PROVIDER_BLOCKED",
  );
});

test("an accepted Antigravity reaches staged roles and no others", () => {
  const { repo } = setupProject();
  const accepted = acceptance("google");
  assert.equal(shadowProviderRoleStatus("google", "planner", { acceptance: accepted }).enabled, true);
  assert.equal(shadowProviderRoleStatus("google", "planner", { acceptance: accepted }).acceptedByOperator, true);
  // Acceptance widens which providers may be asked. It does not widen what a provider may see:
  // executing means reading the checkout, and the staged workspace is the whole guarantee.
  assert.equal(shadowProviderRoleStatus("google", "primary", { acceptance: accepted }).enabled, false);

  const plan = planShadowInvocation({
    snapshot: snapshot("google"),
    model: { providerId: "google", modelId: "gemini-test", quotaPool: "antigravity-subscription" },
    cwd: repo,
    payload: { ...payload, role: "planner" },
    acceptance: accepted,
  });
  assert.equal(plan.workspaceMode, "staged-clean");
  // The one profile BrainGate publishes that cannot claim an isolated user config, said out
  // loud rather than quietly asserted alongside the others.
  assert.equal(plan.guarantees.isolatedUserConfig, false);
  assert.doesNotMatch(plan.args.join(" "), /dangerously-skip-permissions/);
});

test("an unaccepted provider names the command that would open it", () => {
  const reason = shadowProviderRoleStatus("google", "planner").reason ?? "";
  // A refusal that does not say what to do next is a dead end; this one is the whole UI for
  // ADR 0008.
  assert.match(reason, /braingate providers accept google/);
});


test("Codex sandbox self-test proves allow-inside deny-outside deny-write without model calls", async () => {
  // One allowed read, then denials for everything the sandbox must refuse: the outside read, and the
  // five write attempts (create/overwrite/delete inside the workspace, create/overwrite outside it).
  const runner = new FakeSandboxRunner([
    { exitCode: 0, stdout: "BRAINGATE_INSIDE_CANARY" },
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "denied" },
    // The ADR 0006 control-key probe: no unknown field reported, so every declared key stands.
    { exitCode: 1, stderr: "stream error: unauthorized" },
  ]);
  const attestation = await new CodexIsolationVerifier({ runner, platform: "linux", env: { PATH: process.env.PATH } }).verify(snapshot("openai"), new Date("2026-09-07T01:00:00Z"));
  assert.equal(runner.calls.length, 8, "one read, one denied read, five denied writes, one key probe");
  assert.deepEqual(attestation.droppedFeatureKeys, []);
  assert.equal(attestation.profileHash, codexIsolationProfileHash());
  assert.equal(attestation.platform, "linux");
  const sandboxCalls = runner.calls.slice(0, 7);
  assert.ok(sandboxCalls.every((args) => args[0] === "sandbox" && args.includes("--permission-profile")));
  // The five writes are attempted, not assumed: create, overwrite and delete inside the workspace,
  // and create and overwrite outside it.
  const writes = sandboxCalls.slice(2).map((args) => args.join(" "));
  assert.ok(writes.some((call) => call.includes("printf blocked >") && call.includes("write-denied.txt")), "create inside the workspace");
  assert.ok(writes.some((call) => call.includes("printf tampered >>") && call.includes("inside.txt")), "overwrite inside the workspace");
  assert.ok(writes.some((call) => call.includes("rm -f")), "delete inside the workspace");
  assert.ok(writes.some((call) => call.includes("checkout-write-denied.txt")), "create in the checkout");
  assert.ok(writes.some((call) => call.includes("checkout-canary.txt")), "overwrite in the checkout");
  assert.ok(runner.calls.every((args) => !args.includes("--model")), "the probe must never pin a model");
});

test("the control-key probe drops only keys this Codex build rejects, and rebinds the profile hash", async () => {
  // Codex 0.153.4 removed features.worktrees; --strict-config reports one unknown key per run,
  // so the probe drops it and retries.
  const runner = new FakeSandboxRunner([
    { exitCode: 0, stdout: "BRAINGATE_INSIDE_CANARY" },
    { exitCode: 1, stderr: "denied" },
    // create / overwrite / delete inside the workspace, then create / overwrite outside it.
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "denied" },
    { exitCode: 1, stderr: "denied" },
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
  readonly response: (plan: ShadowInvocationPlan) => string | { readonly stdout: string; readonly exitCode: number };
  constructor(response: (plan: ShadowInvocationPlan) => string | { readonly stdout: string; readonly exitCode: number }) { this.response = response; }
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    const answer = this.response(input.plan);
    const stdout = typeof answer === "string" ? answer : answer.stdout;
    const exitCode = typeof answer === "string" ? this.exitCode : answer.exitCode;
    return { spawned: true, exitCode, stdout, stderr: "", timedOut: false, durationMs: 12, removedEnvironmentKeys: ["OPENAI_API_KEY"] };
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
  // The old assertion pinned the profile's clamp at 12, which is what silently reimposed the
  // limit the budget was meant to lift. The clamp is a runaway bound now, well above any tier.
  assert.ok(deep <= 60, "the budget must stay within the profile's runaway ceiling");
});

test("the runner spends the budget's turns rather than a fixed ceiling", async () => {
  const { repo, project } = setupProject();
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "answer" }) }));
  const taskText = "What does the README file say?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  const ledger = new TaskLedger(project);
  await new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registryWithClaude()), snapshots: [snapshot("anthropic")], executor: fake, finalizer: finalizerFor(project, ledger) }).run({
    title: "Inspect readme", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
    context: {}, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 0, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
  });
  const turns = fake.calls[0]!.args[fake.calls[0]!.args.indexOf("--max-turns") + 1];
  assert.equal(turns, String(budget.maxInspectionTurns));
});

test("the role prompt never carries task text, and the reply shape is enforced rather than requested", () => {
  const { repo } = setupProject();
  const plan = planShadowInvocation({ snapshot: snapshot("anthropic"), model, cwd: repo, payload, now: new Date("2026-09-07T01:00:00Z") });
  const prompt = plan.args.join(" ");
  assert.doesNotMatch(prompt, /private task body|private context body/);
  assert.match(prompt, /Analyze only/);
  const schemaIndex = plan.args.indexOf("--json-schema");
  assert.ok(schemaIndex > 0, "the plan must carry a response schema");
  const schema = JSON.parse(plan.args[schemaIndex + 1]!) as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
  assert.deepEqual(schema.required, Object.keys(payload.responseContract));
  assert.equal(schema.additionalProperties, false);
});

test("node executor blocks cwd escapes, scrubs API env overrides and stages clean workspace", async () => {
  const { repo, project, root } = setupProject();
  const basePlan: ShadowInvocationPlan = {
    providerId: "anthropic", executable: process.execPath,
    args: ["-e", "process.stdout.write(String(process.env.OPENAI_API_KEY)+' sk-abcdefghijklmnopqrstuvwxyz012345')"],
    cwd: repo, workspaceMode: "project", modelId: "test", quotaPool: "test", inputMode: "stdin", stdin: "{}", attachmentContent: null, attachmentToken: null,
    allowedEnvKeys: [], envOverrides: {}, grant: readOnlyGrant("anthropic"), streamDialect: null, guarantees: { projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true }, minimumVersion: null,
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
    args: ["-e", "process.stdout.write(process.cwd()+'|'+process.argv[1])", STAGE_PATH_TOKEN],
  };
  const staged = await executor.run({ project, plan: stagedPlan, env: { PATH: process.env.PATH } });
  const [spawnCwd, tokenPath] = staged.stdout.split("|");
  assert.equal(spawnCwd, tokenPath);
  assert.notEqual(spawnCwd, repo);
  assert.equal(existsSync(spawnCwd!), false);
});

test("dogfood dry-run performs full T0 preflight with zero executor calls and records no task", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const router = new CapabilityRouter(registryWithClaude());
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "unused" }) }));
  const taskText = "Where is the theme config?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    const result = await new ShadowDogfoodRunner({ project, ledger, router, snapshots: [snapshot("anthropic")], executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Inspect theme config", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/theme.ts"] }, observation: observationFor(classification), contextSummary: { memoryRecords: 1, explicitCandidates: 1, includedItems: 2, estimatedTokens: 500, truncatedItems: 0 }, dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(fake.calls.length, 0);
    // A dry run reaches no provider, so it creates no task: a task row is a claim that work was
    // attempted, and the record would otherwise carry a success for work never done. The write
    // path already returns before creating one, and this aligns the read path with it.
    assert.equal(result.taskId, null);
    assert.equal(result.taskReceipt, null);
    assert.equal(ledger.listTasks().length, 0);
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
  const runner = new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registryWithClaude()), snapshots: [snapshot("anthropic")], executor: misbehaving, finalizer: finalizerFor(project, ledger) });

  await assert.rejects(
    () => runner.run({
      title: "Inspect readme", task: taskText, cwd: repo, classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 500,
      context: {}, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 0, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    }),
    // The guard now covers a workspace without a repository as well as a checkout with one, so the
    // code is the workspace-level one; the fact it reports is the same.
    /SHADOW_SOURCE_MUTATED|WORKSPACE_MUTATED|changed the workspace it was only supposed to read/,
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
    assert.throws(() => assertSourceCheckoutUnchanged(repo, before), /checkout changed while a read-only task was running/, label);
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
  assert.throws(() => assertSourceCheckoutUnchanged(repo, before), /checkout changed while a read-only task was running/);
});


// Superseded by the two tests below: "Claude primary plus Codex reviewer" was the arrangement while
// Codex was staged-only. A proven Codex now takes the primary and reads a snapshot, and the
// cross-provider reviewer it forces is the assertion worth keeping. The old expectation is not
// preserved as a test because it is no longer a behaviour BrainGate should have.

/**
 * A snapshot store for the tests: it hands out a real directory with real content, so the assertion
 * that matters — what the provider's working directory was — is checked against the filesystem rather
 * than against a string the caller passed in.
 */
function fakeSnapshotStore(): TaskSnapshotProvider & { readonly roots: readonly string[]; readonly started: string[] } {
  const roots: string[] = [];
  const started: string[] = [];
  const byTask = new Map<string, string>();
  return {
    roots,
    started,
    beginTask({ taskId }: { readonly taskId: string }) { started.push(taskId); return "task-start-fingerprint"; },
    sweep() { return { removed: 0, kept: 0, unrecognised: 0 }; },
    ensure({ taskId }: { readonly taskId: string }) {
      let root = byTask.get(taskId);
      if (root === undefined) {
        root = realpathSync.native(mkdtempSync(join(tmpdir(), "braingate-test-snapshot-")));
        writeFileSync(join(root, "app.txt"), "snapshot content\n");
        byTask.set(taskId, root);
        roots.push(root);
      }
      return { snapshotId: `snapshot-${String(roots.length)}`, root, manifestHash: "a".repeat(64), fileCount: 1, totalBytes: 17, policyVersion: "test", sourceFingerprint: "b".repeat(64) };
    },
    verify() { return true; },
    discard(taskId: string) {
      const root = byTask.get(taskId);
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
      byTask.delete(taskId);
    },
  };
}

test("a proven Codex primary reads the snapshot, never the checkout, and keeps the reviewer independent", { skip: process.platform === "win32" }, async () => {
  // Before this milestone Codex could only be a staged reviewer: the primary role was closed to it
  // because it would have needed the operator's checkout. It is now eligible *and* safe, because the
  // workspace it is given is a copy — and this test is about those two facts at once.
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const snapshotsUnderTest = fakeSnapshotStore();
  const registry = new ModelRegistry();
  registry.register({ providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription", capabilities: { coder: 90, reviewer: 90, judge: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 90, underlyingFamily: null }, { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" });
  registry.register({ providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription", capabilities: { coder: 100, reviewer: 100, judge: 100 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 100, underlyingFamily: null }, { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" });
  const fake = new FakeExecutor((plan) => {
    // Codex answers in its JSONL envelope; the reviewer here is Claude, whose answer is a single
    // result object. Each provider's own shape, so the fake is testing the path rather than itself.
    if (plan.providerId === "openai") {
      // Checked while the call is in flight: the snapshot is released when the task ends, so this is
      // the only moment the copy exists to be inspected.
      assert.ok(plan.workspaceRoot !== undefined && existsSync(join(plan.workspaceRoot, "app.txt")), "the snapshot holds the project content while the provider reads it");
      const work = JSON.stringify({ kind: "work", output: "the answer, read from the snapshot" });
      return [JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "ignored" } }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: work } })].join("\n");
    }
    const review = JSON.stringify({ kind: "review", verdict: "approve", findings: [] });
    return JSON.stringify({ result: review });
  });
  // Reviewing a change is risky, so a cross-provider reviewer is required — which is what makes the
  // independence half of this test meaningful.
  const taskText = "Review the auth session handling change";
  const classification = classifyTask({ text: taskText, mode: "review" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    const result = await new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registry), snapshots: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), snapshotStore: snapshotsUnderTest, executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Read the project", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/auth.ts"] }, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    });
    // The stronger model is now eligible and wins the primary, which is the whole point.
    assert.equal(result.workflow?.primary.model.definition.providerId, "openai");
    const primaryCall = fake.calls[0]!;
    assert.equal(primaryCall.workspaceMode, "staged-read-snapshot");
    // The plan names the snapshot as the workspace, and nothing the provider receives names the
    // checkout: not the workspace, not one argument of it.
    assert.equal(primaryCall.workspaceRoot, snapshotsUnderTest.roots[0], "the provider's workspace is the snapshot");
    assert.equal(primaryCall.workspaceRoot?.includes(repo) ?? true, false, "the snapshot is not inside the checkout");
    assert.ok(primaryCall.args.every((argument) => !argument.includes(repo)), "no argument carries the checkout path");
    assert.equal(existsSync(snapshotsUnderTest.roots[0]!), false, "the snapshot is released when the task ends");
    // Independence is recomputed from the effective primary: Codex ran, so the cross-provider reviewer
    // cannot be Codex.
    assert.equal(result.workflow?.reviewer?.model.definition.providerId, "anthropic");
    // Claude is the one provider BrainGate points at the checkout, for every role it runs — that is
    // unchanged, and it is why the reviewer's mode is `project` rather than a stage. The new fact is
    // that the *snapshot-capable* provider never appears with that mode.
    assert.equal(fake.calls[1]?.workspaceMode, "project");
    assert.equal(fake.calls.some((plan) => plan.providerId === "openai" && plan.workspaceMode === "project"), false);
    assert.deepEqual(fake.calls.at(-1)!.cwd, fake.calls[1]!.cwd);
    assert.equal(snapshotsUnderTest.roots.length, 1, "one task, one snapshot, however many attempts");
  } finally { ledger.close(); }
});

test("an unavailable snapshot is not a licence to read the checkout", { skip: process.platform === "win32" }, async () => {
  // Codex is snapshot-capable and attested, but no snapshot provider was supplied. The run must fail
  // rather than silently hand Codex the operator's working directory.
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const registry = new ModelRegistry();
  registry.register({ providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription", capabilities: { coder: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 90, underlyingFamily: null }, { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" });
  registry.register({ providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription", capabilities: { coder: 100 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 100, underlyingFamily: null }, { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" });
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "answer" }) }));
  const taskText = "Where is the auth session stored, and what reads it?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    await assert.rejects(() => new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registry), snapshots: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Read the project", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: {}, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    }), /snapshot provider/);
    assert.ok(fake.calls.every((plan) => plan.cwd !== repo || plan.workspaceMode === "project"), "the checkout is never used as a Codex workspace");
  } finally { ledger.close(); }
});

test("high-risk auth shadow preflight without Codex isolation spends zero provider calls", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const router = new CapabilityRouter(registryWithClaudeAndCodex());
  const fake = new FakeExecutor(() => "must not run");
  const taskText = "Review the auth session handling change";
  const classification = classifyTask({ text: taskText, mode: "review" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    await assert.rejects(() => new ShadowDogfoodRunner({ project, ledger, router, snapshots: [snapshot("anthropic"), snapshot("openai")], executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Inspect auth session", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/auth.ts"] }, observation: observationFor(classification), contextSummary: { memoryRecords: 1, explicitCandidates: 1, includedItems: 2, estimatedTokens: 500, truncatedItems: 0 }, dryRun: true,
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

const grokModel: ModelRef = { providerId: "xai", modelId: "grok-4.6", quotaPool: "grok-subscription" };

/** A snapshot-read proof: the snapshot policy, an isolated home and no writable root. */
function grokSnapshotProof(values: Partial<GrokIsolationAttestation> = {}, reference = Date.now()): GrokIsolationAttestation {
  return {
    providerId: "xai",
    source: "sandbox-event-self-test",
    version: "1.0.13",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    probeVersion: GROK_SNAPSHOT_PROBE_VERSION,
    profileHash: grokSnapshotReadProfileHash(),
    readableRoots: ["/usr"],
    writableRoots: [],
    isolatedHome: true,
    networkRestricted: process.platform === "linux",
    configSurfaces: [],
    observedAt: new Date(reference - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(reference + 60 * 60 * 1000).toISOString(),
    ...values,
  };
}

function grokIsolation(values: Partial<GrokIsolationAttestation> = {}, reference = Date.now()): GrokIsolationAttestation {
  return {
    providerId: "xai",
    source: "sandbox-event-self-test",
    version: "1.0.13",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    probeVersion: GROK_STAGED_PROBE_VERSION,
    profileHash: grokIsolationProfileHash(),
    readableRoots: ["/usr"],
    networkRestricted: process.platform === "linux",
    configSurfaces: [],
    observedAt: new Date(reference - 60_000).toISOString(),
    expiresAt: new Date(reference + 3_600_000).toISOString(),
    ...values,
  };
}

function acceptance(providerId: ProviderId, values: Partial<OperatorProviderAcceptance> = {}): OperatorProviderAcceptance {
  return { providerId, source: "operator-accepted-unscoped-provider", acceptedAt: new Date(Date.now() - 60_000).toISOString(), ...values } as OperatorProviderAcceptance;
}

// ADR 0008. Refusing to invoke a provider the operator already runs by hand removes nothing from
// their exposure; it only makes BrainGate less useful while the same work happens outside it.
// Eligibility and execution must agree. Declaring a role reachable for a provider that
// planShadowInvocation then refuses is worse than declaring it closed: the router selects the
// model, the operator reads it in the plan, and the failure arrives after they committed.
test("a staged Grok run gets its sandbox profile and its prompt, and neither survives the run", async () => {
  const { repo, project } = setupProject();
  const executor = new NodeShadowProcessExecutor();
  const plan: ShadowInvocationPlan = {
    providerId: "xai", executable: process.execPath,
    // Reports the staged workspace, the sandbox profile it was given, and the prompt file —
    // all three of which the executor, not the plan, is responsible for putting there.
    args: ["-e", "const fs=require('node:fs');process.stdout.write([process.cwd(),fs.readFileSync('.grok/sandbox.toml','utf8'),fs.readFileSync(process.argv[1],'utf8'),String(process.env.GROK_HOME),String(process.env.HOME)].join('\\u0000'))", `${STAGE_PATH_TOKEN}/braingate-request.txt`],
    cwd: repo, workspaceMode: "staged-clean", modelId: "grok-4.6", quotaPool: "grok-subscription",
    inputMode: "staged-file", stdin: null, attachmentContent: "REQUEST BODY", attachmentToken: "braingate-request.txt",
    allowedEnvKeys: [], envOverrides: {}, grant: readOnlyGrant("xai", "staged-clean"), streamDialect: null,
    guarantees: { projectOnlyRead: true, noProjectWrites: true, noShell: false, noNetworkTools: true, noMcp: true, noSessionPersistence: false, isolatedUserConfig: true },
    minimumVersion: null,
  };
  const result = await executor.run({ project, plan, env: { PATH: process.env.PATH, HOME: "/operator/home" } });
  const [stage, sandboxToml, prompt, grokHome, home] = result.stdout.split("\u0000");
  assert.match(sandboxToml!, new RegExp(`\\[profiles\\.${GROK_SANDBOX_PROFILE}\\]`));
  assert.equal(prompt, "REQUEST BODY");
  // Authentication comes from the operator's Grok home; the settings file another tool keeps
  // under HOME does not, because HOME is not theirs for this run.
  assert.equal(grokHome, "/operator/home/.grok");
  assert.notEqual(home, "/operator/home");
  assert.equal(existsSync(stage!), false, "the staged workspace, its profile and the prompt must not outlive the run");
});

test("a staged request file cannot be aimed anywhere but the staged workspace", async () => {
  const { repo, project } = setupProject();
  const plan: ShadowInvocationPlan = {
    providerId: "xai", executable: process.execPath, args: ["-e", "0"],
    cwd: repo, workspaceMode: "staged-clean", modelId: "m", quotaPool: "q",
    inputMode: "staged-file", stdin: null, attachmentContent: "body", attachmentToken: "../escaped.txt",
    allowedEnvKeys: [], envOverrides: {}, grant: readOnlyGrant("xai", "staged-clean"), streamDialect: null,
    guarantees: { projectOnlyRead: true, noProjectWrites: true, noShell: false, noNetworkTools: true, noMcp: true, noSessionPersistence: false, isolatedUserConfig: true },
    minimumVersion: null,
  };
  await assert.rejects(() => new NodeShadowProcessExecutor().run({ project, plan }), /plain file name inside the workspace/);
});

test("Grok runs staged roles on a proven sandbox, and nothing else", () => {
  const { repo } = setupProject();
  // Grok's sandbox is kernel-enforced and confined to the working directory, which is exactly
  // what a staged role needs and exactly what an executor cannot use.
  for (const role of ["planner", "reviewer", "judge"] as const) {
    assert.equal(shadowProviderRoleStatus("xai", role).enabled, true, `xai/${role} should be reachable`);
  }
  assert.equal(shadowProviderRoleStatus("xai", "primary").enabled, false);
  assert.match(shadowProviderRoleStatus("xai", "primary").reason ?? "", /staged roles only/i);

  // Eligibility is policy; the attestation is this machine, a moment ago. Without one the
  // invocation refuses rather than running unprotected.
  assert.throws(
    () => planShadowInvocation({ snapshot: snapshot("xai", { version: "1.0.13" }), model: grokModel, cwd: repo, payload: { ...payload, role: "planner" } }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_GROK_ISOLATION_REQUIRED",
  );

  const plan = planShadowInvocation({
    snapshot: snapshot("xai", { version: "1.0.13" }),
    model: grokModel,
    cwd: repo,
    payload: { ...payload, role: "planner" },
    grokIsolation: grokIsolation(),
  });
  assert.equal(plan.workspaceMode, "staged-clean");
  assert.equal(plan.inputMode, "staged-file");
  const command = plan.args.join(" ");
  // A built-in profile only warns when it cannot be applied; a custom one refuses to start.
  assert.match(command, new RegExp(`--sandbox ${GROK_SANDBOX_PROFILE}`));
  assert.doesNotMatch(command, /--sandbox (strict|workspace|read-only|devbox)\b/);
  assert.doesNotMatch(command, /always-approve|dangerously/);
  // The task body travels in a file inside the staged workspace, never on the command line.
  assert.doesNotMatch(command, /private task body|private context body/);
  assert.ok(plan.args.some((argument) => argument.includes(STAGE_PATH_TOKEN)));
});

test("a Grok build older than the refusing-sandbox release is rejected", () => {
  const { repo } = setupProject();
  // Below 1.0.13 a missing custom profile was a warning and the run continued unsandboxed, so
  // `--sandbox` was a request rather than a guarantee.
  assert.throws(
    () => planShadowInvocation({ snapshot: snapshot("xai", { version: "1.0.12" }), model: grokModel, cwd: repo, payload: { ...payload, role: "planner" }, grokIsolation: grokIsolation({ version: "1.0.12" }) }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_VERSION_TOO_OLD",
  );
});

test("a Grok attestation is bound to the version, platform and profile it was earned under", () => {
  const current = snapshot("xai", { version: "1.0.13" });
  assert.equal(validGrokIsolationAttestation(grokIsolation(), current), true);
  assert.equal(validGrokIsolationAttestation(grokIsolation({ version: "1.0.12" }), current), false, "an attestation from another build says nothing about this one");
  assert.equal(validGrokIsolationAttestation(grokIsolation({ profileHash: "0".repeat(64) }), current), false);
  assert.equal(validGrokIsolationAttestation(grokIsolation({ expiresAt: new Date(Date.now() - 1_000).toISOString() }), current), false);
  assert.equal(validGrokIsolationAttestation(undefined, current), false);
});

// The self-test reads Grok's own record of the policy the kernel applied, because BrainGate's
// copy of the config file proves nothing when a same-named profile in the operator's own
// sandbox.toml silently takes precedence over the project one.
test("the applied sandbox policy is read back from Grok's event log", () => {
  const log = [
    JSON.stringify({ event_type: "ProfileApplied", profile: GROK_SANDBOX_PROFILE, workspace: "/elsewhere", enforced: true, read_only_paths: ["/usr"] }),
    JSON.stringify({ event_type: "ProfileApplied", profile: GROK_SANDBOX_PROFILE, workspace: "/stage", enforced: true, read_only_paths: ["/usr", "/stage"], read_write_paths: ["/stage"] }),
  ].join("\n");
  const event = latestProfileApplied(log, "/stage");
  assert.equal(event?.workspace, "/stage");
  assert.deepEqual(unexpectedRoots(event!, ["/stage"]), []);
  assert.equal(latestProfileApplied(log, "/nowhere"), null);
});

test("a shadowing profile that grants the home directory is caught by the roots it applied", () => {
  const event = latestProfileApplied(
    JSON.stringify({ event_type: "ProfileApplied", profile: GROK_SANDBOX_PROFILE, workspace: "/stage", enforced: true, read_write_paths: ["/stage", "/Users/someone"] }),
    "/stage",
  );
  // `extends = "devbox"` in the operator's own sandbox.toml would look exactly like this, and
  // BrainGate would otherwise report an isolation it never had.
  assert.deepEqual(unexpectedRoots(event!, ["/stage"]), ["/Users/someone"]);
});

test("the sandbox profile BrainGate writes is the narrowest base, with the network shut", () => {
  const toml = grokSandboxProfileToml();
  assert.match(toml, new RegExp(`\\[profiles\\.${GROK_SANDBOX_PROFILE}\\]`));
  assert.match(toml, /extends = "strict"/);
  assert.match(toml, /restrict_network = true/);
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

// The clamp in the profile silently reimposed the limit the budget had just lifted. A ceiling
// that the layer below quietly lowers is not a ceiling.
test("the invocation profile honours the budget's turn allowance instead of capping it", () => {
  const { repo } = setupProject();
  for (const complexity of ["T0", "T4"] as const) {
    const budget = budgetFor({ ...classifyTask({ text: "any task", mode: "ask" }), complexity }, { writeRequested: false });
    const plan = planShadowInvocation({ snapshot: snapshot("anthropic"), model, cwd: repo, payload, maxTurns: budget.maxInspectionTurns, now: new Date("2026-09-07T01:00:00Z") });
    const granted = Number(plan.args[plan.args.indexOf("--max-turns") + 1]);
    assert.equal(granted, budget.maxInspectionTurns, `${complexity} was clamped from ${String(budget.maxInspectionTurns)} to ${String(granted)}`);
  }
});

// "Which model burned what" is the question routing across subscriptions exists to answer, and
// the ledger was recording `unknown` for every call while two providers were reporting it.
test("a provider's own token count is recorded as native, including what it read from cache", () => {
  const claude = providerTokenUsage("anthropic", JSON.stringify({ result: "ok", usage: { input_tokens: 6, output_tokens: 264, cache_read_input_tokens: 12_000 } }));
  // `input_tokens` alone reads as six tokens for a request that carried twelve thousand.
  assert.deepEqual(claude, { input: 6, output: 264, cacheRead: 12_000 });

  const grok = providerTokenUsage("xai", JSON.stringify({ text: "{}", usage: { input_tokens: 14_856, output_tokens: 509, cache_read_input_tokens: 13_440 } }));
  assert.equal(grok?.output, 509);

  const agy = providerTokenUsage("google", JSON.stringify({ status: "SUCCESS", response: "{}", usage: { input_tokens: 6_484, output_tokens: 572, cache_read_tokens: 8_097 } }));
  assert.equal(agy?.cacheRead, 8_097);
});

test("a count that is absent, malformed or from a provider that reports none stays unknown", () => {
  // An invented number labelled `native` is worse than no number: the whole point of the
  // evidence label is that a reader can tell measurement from inference.
  assert.equal(providerTokenUsage("anthropic", "not json"), null);
  assert.equal(providerTokenUsage("anthropic", JSON.stringify({ usage: { input_tokens: "many", output_tokens: 1 } })), null);
  assert.equal(providerTokenUsage("anthropic", JSON.stringify({ usage: { input_tokens: -1, output_tokens: 1 } })), null);
  assert.equal(providerTokenUsage("openai", JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } })), null, "Codex reports usage in a JSONL stream this parser does not read");
  assert.equal(providerTokenUsage("anthropic", JSON.stringify({ result: "ok" })), null);
});

test("Codex receives its schema as a file inside the only directory it can open", () => {
  const { repo } = setupProject();
  const reference = new Date("2026-09-07T01:00:00Z");
  const reviewPayload: ShadowRolePayload = { ...payload, role: "reviewer", responseContract: { kind: "review", verdict: ["approve", "request_changes", "disagree"], findings: "string[]" } };
  const plan = planShadowInvocation({
    snapshot: snapshot("openai"),
    model: { providerId: "openai", modelId: "codex-model", quotaPool: "openai" },
    cwd: repo,
    payload: reviewPayload,
    codexIsolation: codexIsolation({}, reference.getTime()),
    now: reference,
  });
  const index = plan.args.indexOf("--output-schema");
  assert.ok(index > 0);
  assert.equal(plan.args[index + 1], `${STAGE_PATH_TOKEN}/${STAGED_SCHEMA_FILE}`);
  const staged = plan.stagedFiles?.[STAGED_SCHEMA_FILE];
  assert.ok(staged !== undefined, "the schema must travel with the plan");
  assert.deepEqual(JSON.parse(staged), jsonSchemaFor(reviewPayload.responseContract));
});

test("helpers appear only when the grant and the budget both allow them, and they are BrainGate's own", () => {
  const { repo } = setupProject();
  const reference = new Date("2026-09-07T01:00:00Z");
  const withoutFanOut = planShadowInvocation({ snapshot: snapshot("anthropic"), model, cwd: repo, payload, now: reference });
  assert.ok(!withoutFanOut.args.includes("--agents"), "a budget that allows one agent gets no helpers");
  assert.equal(withoutFanOut.args[withoutFanOut.args.indexOf("--tools") + 1], "Read,Glob,Grep");

  const withFanOut = planShadowInvocation({ snapshot: snapshot("anthropic"), model, cwd: repo, payload, fanOut: true, now: reference });
  assert.equal(withFanOut.args[withFanOut.args.indexOf("--tools") + 1], "Read,Glob,Grep,Agent");
  const definitions = JSON.parse(withFanOut.args[withFanOut.args.indexOf("--agents") + 1]!) as Record<string, { tools: string[] }>;
  assert.deepEqual(Object.keys(definitions), ["braingate-explorer"]);
  for (const definition of Object.values(definitions)) {
    assert.deepEqual(definition.tools, ["Read", "Grep", "Glob"], "a helper may never hold a tool its lead was not granted");
  }
});

test("Grok's own subagents stay banned unless BrainGate wrote the definitions", () => {
  const { repo } = setupProject();
  const reference = new Date("2026-09-07T01:00:00Z");
  const grokModel: ModelRef = { providerId: "xai", modelId: "grok-4.6", quotaPool: "grok-subscription" };
  const base = { snapshot: snapshot("xai", { version: "1.0.24" }), model: grokModel, cwd: repo, payload: { ...payload, role: "planner" as const }, grokIsolation: grokIsolation({ version: "1.0.24" }, reference.getTime()), now: reference };
  const alone = planShadowInvocation(base);
  assert.ok(alone.args.includes("--no-subagents"));
  const fannedOut = planShadowInvocation({ ...base, fanOut: true });
  assert.ok(!fannedOut.args.includes("--no-subagents"));
  // Measured against grok 1.0.24: an array is refused with "expected a map".
  const definitions = JSON.parse(fannedOut.args[fannedOut.args.indexOf("--agents") + 1]!) as Record<string, unknown>;
  assert.equal(Array.isArray(definitions), false);
  assert.ok(Object.keys(definitions).length > 0);
});

test("a plan carries what it was refused, so the operator reads it before the run rather than after", () => {
  const { repo } = setupProject();
  const plan = planShadowInvocation({ snapshot: snapshot("anthropic"), model, cwd: repo, payload: { ...payload, role: "planner" }, now: new Date("2026-09-07T01:00:00Z") });
  const web = plan.grant.refused.find((item) => item.capability === "web");
  assert.ok(web !== undefined, "a planner asks for the network");
  assert.match(web.reason, /allow-web/);
  assert.equal(plan.guarantees.noNetworkTools, true);
});

test("Antigravity's request goes through stdin, so a large context is no longer refused", () => {
  const { repo } = setupProject();
  const large = { notes: "x".repeat(200_000) };
  const plan = planShadowInvocation({
    snapshot: snapshot("google"),
    model: { providerId: "google", modelId: "gemini-3.8-flash-medium", quotaPool: "antigravity-subscription" },
    cwd: repo,
    payload: { ...payload, role: "planner", context: large },
    acceptance: acceptance("google", { acceptedAt: new Date("2026-09-07T00:00:00Z").toISOString() }),
    now: new Date("2026-09-07T01:00:00Z"),
  });
  assert.equal(plan.inputMode, "stdin");
  assert.equal(plan.args[plan.args.indexOf("--input-format") + 1], "stream-json");
  assert.ok(!plan.args.some((argument) => argument.includes("x".repeat(1_000))), "the payload must not travel as an argument");
  const line = JSON.parse(plan.stdin!.trim()) as { event: string; message: { role: string; content: string } };
  // Measured: the key is `event`, and a `type` key is reported as an unknown event that
  // silently produces no turn at all.
  assert.equal(line.event, "user");
  assert.ok(line.message.content.includes("x".repeat(1_000)));
});

test("an Antigravity stream is read from its final result, preferring the object the CLI enforced", () => {
  const stream = [
    '{"event":"init","conversation_id":"a"}',
    '{"event":"result","result":{"status":"SUCCESS","response":"ready\\n{\\"kind\\":\\"work\\"}","structured_output":{"kind":"work","output":"ready"},"usage":{"input_tokens":43439,"output_tokens":73,"cache_read_tokens":0}}}',
  ].join("\n");
  assert.equal(extractAntigravityResult(stream), '{"kind":"work","output":"ready"}');
  // The same run's accounting, which used to be recorded as unknown because only the outer
  // object was read.
  assert.deepEqual(providerTokenUsage("google", stream), { input: 43439, output: 73, cacheRead: 0 });

  const withoutSchema = '{"event":"result","result":{"status":"SUCCESS","response":"plain answer"}}';
  assert.equal(extractAntigravityResult(withoutSchema), "plain answer");
  assert.equal(extractAntigravityResult('{"event":"init"}'), null, "a stream with no result is not an answer");
  assert.equal(extractAntigravityResult("not json at all"), null);
});

test("a narrated answer is parsed from its own object, not from the braces in the prose", () => {
  // What a tool-using provider actually streams: an explanation with code in it, then the answer.
  const narrated = 'Let me look. The handler is `if (x) { return {ok: false}; }` in router.ts.\n{"kind":"work","output":"the router decides which model fills a role"}';
  assert.deepEqual(
    lastBalancedJsonObject(narrated),
    { kind: "work", output: "the router decides which model fills a role" },
  );
  // The outermost span would have started at the snippet's brace and parsed as nothing.
  assert.throws(() => JSON.parse(narrated.slice(narrated.indexOf("{"), narrated.lastIndexOf("}") + 1)));
});

test("a brace inside a string is not a brace", () => {
  assert.deepEqual(lastBalancedJsonObject('{"kind":"work","output":"use {} for an empty set"}'), { kind: "work", output: "use {} for an empty set" });
  assert.deepEqual(lastBalancedJsonObject('{"kind":"work","output":"a quote \\" and a brace }"}'), { kind: "work", output: 'a quote " and a brace }' });
});

test("text with no complete object yields nothing rather than a guess", () => {
  assert.equal(lastBalancedJsonObject("no object here"), null);
  assert.equal(lastBalancedJsonObject('{"kind":"work"'), null);
});

test("a new text block starts the answer again, so narration is not part of it", () => {
  const start = '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}';
  assert.equal(readStreamLine("anthropic", start).restart, true);
  const thinkingBlock = '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}';
  assert.notEqual(readStreamLine("anthropic", thinkingBlock).restart, true);
});

test("search reaches a provider only where the operator granted the network", () => {
  const { repo } = setupProject();
  const reference = new Date("2026-09-07T01:00:00Z");
  const base = { snapshot: snapshot("anthropic"), model, cwd: repo, payload: { ...payload, role: "planner" as const }, now: reference };

  const withoutWeb = planShadowInvocation(base);
  assert.equal(withoutWeb.args[withoutWeb.args.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(withoutWeb.guarantees.noNetworkTools, true);

  const networkAcceptance = acceptance("anthropic", {
    source: "operator-accepted-network-access",
    acceptedAt: new Date("2026-09-07T00:00:00Z").toISOString(),
  });
  const withWeb = planShadowInvocation({ ...base, networkAcceptance });
  assert.equal(withWeb.args[withWeb.args.indexOf("--tools") + 1], "Read,Glob,Grep,WebSearch,WebFetch");
  assert.ok(withWeb.grant.granted.includes("web"));
  // The guarantee stops claiming what is no longer true.
  assert.equal(withWeb.guarantees.noNetworkTools, false);

  // The other decision is not this decision.
  const unscopedOnly = planShadowInvocation({ ...base, acceptance: acceptance("anthropic", { acceptedAt: new Date("2026-09-07T00:00:00Z").toISOString() }) });
  assert.equal(unscopedOnly.args[unscopedOnly.args.indexOf("--tools") + 1], "Read,Glob,Grep");
});

// A provider CLI is a child process. A terminal Ctrl-C reaches the whole foreground process group,
// so the provider gets it too; a signal sent to BrainGate alone does not, and the run would die with
// the task unfinished and a subscription still being spent. This is the only part of that path a
// test can drive: a real child, and a real kill.
test("a signal sent to BrainGate alone still reaches the provider it spawned", async () => {
  const { trackChild, trackedChildCount, abortTrackedChildren } = await import("./child-registry.js");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  const exited = new Promise<void>((resolveExit) => { child.on("exit", () => { resolveExit(); }); });
  trackChild(child);
  assert.equal(trackedChildCount(), 1);

  const killed = abortTrackedChildren();
  assert.equal(killed, 1);
  assert.equal(trackedChildCount(), 0);
  await exited;
  assert.notEqual(child.exitCode, 0, "the child must have been killed, not left running");
  assert.equal(child.signalCode, "SIGKILL");
  // Aborting again is not an error: a second signal on the way out must not throw.
  assert.equal(abortTrackedChildren(), 0);
});

// The failure this closes, in the operator's own words: an exhausted Anthropic pool was dispatched
// to, refused in a few seconds, and nothing was recorded — no refusal, no quota reading, no reason.
// The readings were collected after the exit-code check that throws on a refusal, so the one call
// where the provider states its own limit was the one call that recorded nothing.
test("a refused call records what the provider said about its own limit", async () => {
  const { repo, project } = setupProject();
  const refusal = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: 1789015200,
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1789015200 }, seven_day: { utilization: 0.93, resetsAt: 1789200000 } },
    },
  });
  const fake = new FakeExecutor(() => `${refusal}\n{"type":"result","subtype":"error_during_execution"}`);
  fake.exitCode = 1;
  const readings: { window: string | null; utilization: number | null; blocked: boolean; quotaPool: string }[] = [];
  const invoker = new SubscriptionShadowAgentInvoker({
    project, cwd: repo, snapshots: [snapshot("anthropic")], context: {},
    executor: fake, onQuotaReading: (reading) => { readings.push({ window: reading.window, utilization: reading.utilization, blocked: reading.blocked, quotaPool: reading.quotaPool }); },
  });
  const request: AgentRequest = { role: "primary", model, phase: "initial", task: "summarise the readme", findings: [] };
  await assert.rejects(() => invoker.invoke(request), /failed with exit 1/);
  // Both windows, with the provider's own numbers, attributed to the pool that was spent.
  assert.deepEqual(readings.map((reading) => reading.window).sort(), ["five_hour", "seven_day"]);
  assert.equal(readings.every((reading) => reading.blocked), true);
  assert.equal(readings.every((reading) => reading.quotaPool === "claude-subscription"), true);
  assert.equal(readings.find((reading) => reading.window === "seven_day")?.utilization, 0.93);
});

test("an empty answer is refused rather than recorded as work that produced nothing", async () => {
  const { repo, project } = setupProject();
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "   " }) }));
  const invoker = new SubscriptionShadowAgentInvoker({ project, cwd: repo, snapshots: [snapshot("anthropic")], context: {}, executor: fake });
  const request: AgentRequest = { role: "primary", model, phase: "initial", task: "summarise the readme", findings: [] };
  await assert.rejects(() => invoker.invoke(request), /empty result/);
});

/**
 * Attribution: the run records every provider that actually ran, including the planner.
 *
 * The measured gap this closes: a real task dispatched its planner to Google, the planner answered,
 * its native tokens were recorded — and the task's roles named only the primary and the reviewer,
 * because the planner is routed by the workflow engine rather than by the runner. A later reader (the
 * corpus, a report, the dashboard) was told a two-call task had one role.
 */
function registryWithPlanner(): ModelRegistry {
  const registry = new ModelRegistry();
  const runtime = { available: true, quotaState: "unknown" as const, quotaHint: null, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-12T00:00:00Z" };
  // Two Anthropic models so the planner and the executor are distinguishable in the record, plus a
  // staged reviewer on another provider (the shape the real router uses).
  registry.register({ providerId: "anthropic", modelId: "claude-planner", quotaPool: "claude-subscription", capabilities: { planner: 95, coder: 40, reviewer: 40 }, speed: "deep", contextCapacity: 200_000, writeCapable: false, reasoning: 95, underlyingFamily: null }, runtime);
  registry.register({ providerId: "anthropic", modelId: "claude-coder", quotaPool: "claude-subscription", capabilities: { planner: 40, coder: 90, reviewer: 88 }, speed: "deep", contextCapacity: 200_000, writeCapable: false, reasoning: 90, underlyingFamily: null }, runtime);
  registry.register({ providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription", capabilities: { planner: 70, coder: 40, reviewer: 100, judge: 100 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 100, underlyingFamily: null }, runtime);
  return registry;
}

/** Answers by the model that was asked, so the test knows which role each response belongs to. */
function plannerFixture(): FakeExecutor {
  return new FakeExecutor((plan) => {
    if (plan.modelId === "claude-planner") return JSON.stringify({ result: JSON.stringify({ kind: "work", output: "the approach" }) });
    if (plan.modelId === "claude-coder") return JSON.stringify({ result: JSON.stringify({ kind: "work", output: "the answer" }) });
    // Codex speaks JSONL, and the invoker reads the last completed agent_message.
    return [JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "ignored" } }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "review", verdict: "approve", findings: [] }) } })].join("\n");
  });
}

test("the executed planner appears in the task's own attribution record", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const fake = plannerFixture();
  const taskText = "Audit the authentication session storage across the whole application";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  assert.equal(classification.complexity, "T3", "this test is about the planning pass, so the tier must route one");
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    const result = await new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registryWithPlanner()), snapshots: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Audit auth storage", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/auth.ts"] }, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    });
    assert.equal(result.workflow?.outcome, "approved");
    const attribution = recordedExecutionAttribution(ledger.receipt(result.taskId!).events);
    assert.ok(attribution, "the task records who ran");
    const roles = (attribution ?? []).map((role) => `${role.role}:${role.providerId}/${role.modelId}:${role.status}`);
    assert.deepEqual(roles, [
      "planner:anthropic/claude-planner:completed",
      "primary:anthropic/claude-coder:completed",
      "reviewer:openai/codex-test:completed",
    ], "the planner which actually ran is named, and only roles that ran are called completed");
  } finally { ledger.close(); }
});

test("a reviewer that was dispatched and failed is recorded as attempted, never as completed", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const fake = new FakeExecutor((plan) => {
    if (plan.modelId === "claude-planner") return JSON.stringify({ result: JSON.stringify({ kind: "work", output: "the approach" }) });
    if (plan.providerId === "openai") throw new Error("the reviewer provider exploded");
    return JSON.stringify({ result: JSON.stringify({ kind: "work", output: "the answer" }) });
  });
  const taskText = "Audit the authentication session storage across the whole application";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    const error = await new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registryWithPlanner()), snapshots: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Audit auth storage", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/auth.ts"] }, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    }).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof Error, "the failed reviewer fails the task");
    const taskId = ledger.listTasks()[0]!.taskId;
    const attribution = recordedExecutionAttribution(ledger.receipt(taskId).events)!;
    const reviewer = attribution.find((role) => role.role === "reviewer");
    assert.equal(reviewer?.status, "attempted", "the reviewer was dispatched and did not answer");
    assert.equal(reviewer?.providerId, "openai");
    assert.equal(attribution.find((role) => role.role === "planner")?.status, "completed");
    assert.equal(attribution.find((role) => role.role === "primary")?.status, "completed");
  } finally { ledger.close(); }
});

test("a snapshot primary's process runs in the snapshot, with the checkout not even as its working directory", async () => {
  const { repo, project } = setupProject();
  // The snapshot lives where snapshots live — inside the project's own storage, which is the one
  // place outside the checkout the executor will accept as a workspace.
  const snapshotRoot = join(project.storageDir, "snapshots", "test-snapshot", "workspace");
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(snapshotRoot, "app.txt"), "snapshot content\n");
  const executor = new NodeShadowProcessExecutor();
  const plan: ShadowInvocationPlan = {
    providerId: "openai", executable: process.execPath,
    // The process reports its own working directory, so the assertion is about where the provider
    // actually ran rather than about an argument BrainGate meant to pass.
    args: ["-e", "process.stdout.write(process.cwd())"],
    cwd: repo, workspaceMode: "staged-read-snapshot", workspaceRoot: snapshotRoot,
    modelId: "codex-test", quotaPool: "chatgpt-subscription", inputMode: "stdin", stdin: "{}", attachmentContent: null, attachmentToken: null,
    allowedEnvKeys: [], envOverrides: {}, grant: readOnlyGrant("openai", "staged-read-snapshot"), streamDialect: null,
    guarantees: { projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true }, minimumVersion: null,
  };
  const result = await executor.run({ project, plan, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(result.exitCode, 0);
  assert.equal(realpathSync.native(result.stdout.trim()), realpathSync.native(snapshotRoot));
  assert.notEqual(realpathSync.native(result.stdout.trim()), realpathSync.native(repo));
  // And the workspace really was the copy: the checkout is not reachable as a relative path from it.
  assert.equal(existsSync(join(result.stdout.trim(), "..", "..", "repo")), false);
});

test("an active backoff on the Claude pool gives a proven Codex the primary without probing Claude", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const snapshotsUnderTest = fakeSnapshotStore();
  const registry = new ModelRegistry();
  registry.register(
    { providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription", capabilities: { coder: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 90, underlyingFamily: null },
    // BrainGate's own policy wait, not a provider statement: the pool is avoided for a while after a
    // refusal, so the next task may route elsewhere without spending a call to find out.
    { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: new Date(Date.now() + 5 * 60_000).toISOString(), observedAt: "2026-09-12T00:00:00Z" },
  );
  registry.register(
    { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription", capabilities: { coder: 100 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 100, underlyingFamily: null },
    { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" },
  );
  const fake = new FakeExecutor((plan) => {
    const work = JSON.stringify({ kind: "work", output: "answered from the snapshot" });
    if (plan.providerId === "openai") return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: work } });
    return JSON.stringify({ result: work });
  });
  const taskText = "Fix the off-by-one in the retry counter and keep the existing tests passing";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    const result = await new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registry), snapshots: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), snapshotStore: snapshotsUnderTest, executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Retry counter", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: {}, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    });
    assert.equal(result.workflow?.primary.model.definition.providerId, "openai", "the pool under backoff is not asked again");
    assert.deepEqual(fake.calls.map((plan) => plan.providerId), ["openai"], "zero calls to the backed-off pool");
    assert.equal(fake.calls[0]?.workspaceMode, "staged-read-snapshot");
  } finally { ledger.close(); }
});

test("a refused Claude primary fails over to Codex, which reads the snapshot", { skip: process.platform === "win32" }, async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const snapshotsUnderTest = fakeSnapshotStore();
  const registry = new ModelRegistry();
  // Claude is the stronger model, so it is routed first and it is the one that refuses.
  registry.register(
    { providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription", capabilities: { coder: 95 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 95, underlyingFamily: null },
    { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" },
  );
  registry.register(
    { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription", capabilities: { coder: 80 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 80, underlyingFamily: null },
    { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" },
  );
  const refusal = JSON.stringify({ type: "assistant", is_api_error_message: true, error: "rate_limit", api_error_status: 429, terminal_reason: "api_error", content: [{ type: "text", text: "You've hit your session limit · resets 4:10am" }] });
  const fake = new FakeExecutor((plan) => {
    const work = JSON.stringify({ kind: "work", output: "the second provider answered" });
    // The real CLI exits non-zero when its API call was refused; the refusal is read from what it
    // wrote, which is why the exit code and the words have to agree for the failover to trigger.
    if (plan.providerId === "anthropic") return { stdout: refusal, exitCode: 1 };
    return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: work } });
  });
  const taskText = "Fix the off-by-one in the retry counter and keep the existing tests passing";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    const result = await new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registry), snapshots: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), snapshotStore: snapshotsUnderTest, executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Retry counter", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: {}, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    });
    // Both attempts are in the record, in order, and the second one read a snapshot.
    assert.deepEqual(fake.calls.map((plan) => plan.providerId), ["anthropic", "openai"]);
    assert.equal(fake.calls[0]?.workspaceMode, "project", "the refused attempt had the checkout, as Claude always does");
    assert.equal(fake.calls[1]?.workspaceMode, "staged-read-snapshot", "the failover's provider reads a copy, not the checkout");
    assert.equal(result.workflow?.outcome, "completed_without_review");
    const roles = executionAttribution({ events: ledger.receipt(result.taskId!).events });
    const primary = roles.filter((role) => role.role === "primary");
    assert.equal(primary.length, 2, "both attempts are attributed, not only the one that answered");
    assert.deepEqual(primary.map((role) => role.providerId), ["anthropic", "openai"]);
    assert.deepEqual(primary.map((role) => role.status), ["attempted", "completed"]);
    assert.equal(primary[1]?.workspaceMode, "staged-read-snapshot");
    assert.equal(primary[0]?.workspaceMode, "project-checkout");
  } finally { ledger.close(); }
});

test("a T4 task with no eligible model fails closed rather than downgrading to a weaker provider", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const registry = new ModelRegistry();
  registry.register(
    { providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription", capabilities: { coder: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 90, underlyingFamily: null },
    { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: new Date(Date.now() + 5 * 60_000).toISOString(), observedAt: "2026-09-12T00:00:00Z" },
  );
  registry.register(
    // Below the T4 floor, so it may not take the role however available it is.
    { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription", capabilities: { coder: 70 }, speed: "balanced", contextCapacity: 1_000_000, writeCapable: false, reasoning: 70, underlyingFamily: null },
    { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" },
  );
  const fake = new FakeExecutor(() => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "work", output: "should never run" }) } }));
  const taskText = "Design the migration of the whole authentication subsystem to a new identity provider, across every service, with a staged rollout and rollback plan";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    await assert.rejects(() => new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registry), snapshots: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), snapshotStore: fakeSnapshotStore(), executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Identity migration", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: {}, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    }), /no eligible|cannot be routed|ROUTE_NO_ELIGIBLE/i);
    assert.deepEqual(fake.calls, [], "a floor that cannot be met is not a reason to spend a call");
  } finally { ledger.close(); }
});

test("a project that moved between the planner and the failover fails closed instead of mixing two states", { skip: process.platform === "win32" }, async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const registry = new ModelRegistry();
  registry.register(
    { providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription", capabilities: { coder: 95 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 95, underlyingFamily: null },
    { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" },
  );
  registry.register(
    { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription", capabilities: { coder: 80 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 80, underlyingFamily: null },
    { available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" },
  );
  // A store that stands in for "the project moved since this task started": the real fingerprint
  // arithmetic is proven in the execution package; this proves the *runner* refuses rather than
  // handing the failover a project the refused attempt never saw.
  const roots: string[] = [];
  let snapshotsTaken = 0;
  const store: TaskSnapshotProvider = {
    beginTask: () => "fingerprint-at-task-start",
    ensure: () => { snapshotsTaken += 1; throw new BrainGateInvariantError("SNAPSHOT_SOURCE_CHANGED_SINCE_TASK_START", "The project changed after this task started."); },
    verify: () => true,
    discard: () => { /* nothing was created */ },
    sweep: () => ({ removed: 0, kept: 0, unrecognised: 0 }),
  };
  void roots;
  const refusal = JSON.stringify({ type: "assistant", is_api_error_message: true, error: "rate_limit", content: [{ type: "text", text: "You've hit your session limit" }] });
  const fake = new FakeExecutor((plan) => (plan.providerId === "anthropic" ? { stdout: refusal, exitCode: 1 } : JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "work", output: "should never run" }) } })));
  const taskText = "Fix the off-by-one in the retry counter and keep the existing tests passing";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    await assert.rejects(() => new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registry), snapshots: [snapshot("anthropic"), snapshot("openai")], codexIsolation: codexIsolation(), snapshotStore: store, executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Retry counter", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: {}, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    }));
    // Exactly one provider call: the one that was refused. No provider was asked to read a project
    // state that the earlier attempt did not read.
    assert.equal(snapshotsTaken, 1, "the snapshot was attempted once, and refused");
    assert.deepEqual(fake.calls.map((plan) => plan.providerId), ["anthropic"], "the failover never reached a provider");
    const receipt = ledger.listTasks()[0]!;
    const events = ledger.receipt(receipt.taskId).events;
    assert.equal(events.some((event) => event.kind === "shadow.provider.failed" && (event.payload as { readonly provider?: string }).provider === "openai"), false);
    const snapshotRecord = finalizedSnapshotOf(events);
    assert.equal(snapshotRecord?.failureKind, "source-fingerprint-changed", `the record names the reason: ${JSON.stringify(snapshotRecord)}`);
  } finally { ledger.close(); }
});

test("an Anthropic-only task creates no snapshot data at all", { skip: process.platform === "win32" }, async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const store = fakeSnapshotStore();
  const fake = new FakeExecutor((plan) => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "answered" }) }));
  const taskText = "Fix the off-by-one in the retry counter and keep the existing tests passing";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  try {
    // No Codex or Grok attestation, so no copy can ever be needed and the run does no snapshot work:
    // no fingerprint pass over the project, no directory, nothing to clean up.
    const result = await new ShadowDogfoodRunner({ project, ledger, router: new CapabilityRouter(registryWithClaude()), snapshots: [snapshot("anthropic")], snapshotStore: store, executor: fake, finalizer: finalizerFor(project, ledger) }).run({
      title: "Retry counter", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: {}, observation: observationFor(classification), contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    });
    assert.equal(result.workflow?.primary.model.definition.providerId, "anthropic");
    assert.deepEqual(store.started, [], "no task-start fingerprint was taken for a task that cannot need one");
    assert.deepEqual(store.roots, [], "and no snapshot exists");
  } finally { ledger.close(); }
});

/**
 * The equivalence proof behind reusing one attestation for two roles.
 *
 * `snapshotPrimaryEligibility` accepts the sandbox self-test the staged roles earned, which is only
 * legitimate if the *policy* a read-primary run executes under is the same policy. Role names are not
 * policy; the workspace's content is not policy. Everything that decides what the provider can reach,
 * write, spawn or talk to *is*, and this compares all of it between a staged Grok role and a Grok
 * read-primary — so if any of it ever diverges, this fails before the reuse can silently broaden.
 */
function schemaValue(args: readonly string[]): string | null {
  const index = args.indexOf("--json-schema");
  return index === -1 ? null : args[index + 1] ?? null;
}

test("a Grok read-primary runs under its own profile from an isolated home, and a staged proof does not open it", () => {
  const { repo, project } = setupProject();
  const workspaceRoot = join(project.storageDir, "snapshots", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "workspace");
  const stagedPlan = planShadowInvocation({ snapshot: snapshot("xai", { version: "1.0.13" }), model: grokModel, cwd: repo, payload: { ...payload, role: "planner" }, grokIsolation: grokIsolation() });

  // A staged attestation is not a snapshot-primary attestation: the home and the policy differ, and
  // the difference is exactly what a plugin's reach would depend on.
  assert.throws(
    () => planShadowInvocation({ snapshot: snapshot("xai", { version: "1.0.13" }), model: grokModel, cwd: repo, payload: { ...payload, role: "primary" }, grokIsolation: grokIsolation(), snapshotPrimary: true, workspaceRoot }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_GROK_SNAPSHOT_ISOLATION_REQUIRED",
    "the staged proof does not cover the snapshot posture",
  );

  const primary = planShadowInvocation({
    snapshot: snapshot("xai", { version: "1.0.13" }), model: grokModel, cwd: repo, payload: { ...payload, role: "primary" },
    grokSnapshotIsolation: grokSnapshotProof(), snapshotPrimary: true, workspaceRoot,
  });
  // The profile is a different one, and its hash is what the snapshot attestation is bound to.
  assert.equal(primary.args[primary.args.indexOf("--sandbox") + 1], "braingate-snapshot-read");
  assert.equal(stagedPlan.args[stagedPlan.args.indexOf("--sandbox") + 1], GROK_SANDBOX_PROFILE);
  assert.notEqual(grokSnapshotReadProfileHash(), grokIsolationProfileHash());
  assert.equal(grokSnapshotReadProfileHash(), GROK_SNAPSHOT_READ_SANDBOX.hash);
  // What stays the same is everything that bounds the run: the read-only tool grant, the isolated
  // HOME, the network switch and the refusal of unsafe approval flags.
  assert.deepEqual([...primary.grant.granted].sort(), [...stagedPlan.grant.granted].sort());
  assert.equal(primary.grant.granted.includes("edit"), false);
  assert.equal(primary.grant.granted.includes("shell"), false);
  // The isolated HOME and the Grok home are applied by the executor at run time, not stated in the
  // plan; what the plan carries is the same MCP switches either way.
  assert.deepEqual(primary.envOverrides, stagedPlan.envOverrides);
  assert.equal(primary.args.includes("--disable-web-search"), stagedPlan.args.includes("--disable-web-search"));
  assert.doesNotMatch(primary.args.join(" "), /always-approve|dangerously/);
  assert.match(GROK_SNAPSHOT_READ_SANDBOX.toml, /extends = "strict"/);
  assert.match(GROK_SNAPSHOT_READ_SANDBOX.toml, /restrict_network = true/);
  assert.match(GROK_SNAPSHOT_READ_SANDBOX.toml, /\*\*\/\.env/, "a credential is unreadable rather than merely off-limits");
  assert.equal(primary.workspaceMode, "staged-read-snapshot");
  assert.equal(stagedPlan.workspaceMode, "staged-clean");
});

test("the isolated Grok home carries the credential by reference and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-grok-home-test-"));
  const realHome = join(root, "operator-grok");
  mkdirSync(realHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(realHome, "auth.json"), "{\"token\": \"referenced-not-copied\"}\n");
  // Everything the operator's home would otherwise contribute to a run.
  writeFileSync(join(realHome, "config.toml"), "[plugins]\nenabled = true\n");
  writeFileSync(join(realHome, "hooks-paths"), "/some/hook.json\n");
  mkdirSync(join(realHome, "installed-plugins"), { recursive: true });
  writeFileSync(join(realHome, "installed-plugins", "something.json"), "{}\n");
  try {
    assert.deepEqual(grokConfigSurfaces(realHome), ["plugins", "hooks"], "the operator's home is what the staged posture loads");
    const isolated = createIsolatedGrokHome({ root, realHome });
    assert.equal(isolated.credentialReferenced, true);
    assert.deepEqual(readdirSync(isolated.home).sort(), ["auth.json", "config.toml"], "only the reference and BrainGate's own configuration");
    assert.deepEqual(grokConfigSurfaces(isolated.home), [], "no plugins, no hooks, no MCP configuration");
    assert.equal(readFileSync(join(isolated.home, "config.toml"), "utf8").includes("plugins"), false);
    // Referenced, not copied: the entry is a link to the operator's own credential.
    assert.equal(lstatSync(join(isolated.home, "auth.json")).isSymbolicLink(), true);
    assert.equal(realpathSync(join(isolated.home, "auth.json")), realpathSync(join(realHome, "auth.json")));
    rmSync(join(isolated.home, "auth.json"));
    assert.equal(existsSync(join(realHome, "auth.json")), true, "and deleting the reference never touches the credential itself");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a Codex read-primary executes the identical argv, under the attested read-only profile", () => {
  const { repo, project } = setupProject();
  const workspaceRoot = join(project.storageDir, "snapshots", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "workspace");
  const codexModel: ModelRef = { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription" };
  const staged = planShadowInvocation({ snapshot: snapshot("openai"), model: codexModel, cwd: repo, payload: { ...payload, role: "reviewer" }, codexIsolation: codexIsolation() });
  const primary = planShadowInvocation({ snapshot: snapshot("openai"), model: codexModel, cwd: repo, payload: { ...payload, role: "primary" }, codexIsolation: codexIsolation(), snapshotPrimary: true, workspaceRoot });
  assert.deepEqual(primary.args, staged.args, "one argv, so one profile the attestation covers");
  assert.equal(primary.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(primary.args.includes("--sandbox"), false, "the sandbox comes from the accepted config keys, as before");
  assert.deepEqual(primary.allowedEnvKeys, staged.allowedEnvKeys);
  assert.deepEqual([...primary.grant.granted].sort(), [...staged.grant.granted].sort());
  assert.equal(primary.grant.granted.includes("edit"), false);
  assert.equal(staged.workspaceMode, "staged-clean");
  assert.equal(primary.workspaceMode, "staged-read-snapshot");
});

test("a Grok proof of a writable workspace is not a snapshot-primary proof", () => {
  // The shape the current CLI actually produces: the workspace is named read-only and read-write at
  // once, so the write grant is the one in force. This is the measurement that keeps xAI read-primary
  // closed, expressed as a property rather than a comment.
  const writable = grokSnapshotProof({ writableRoots: ["/private/tmp/workspace", "/tmp/workspace"] });
  assert.equal(validGrokSnapshotReadAttestation(writable, snapshot("xai", { version: "1.0.13" })), false, "a writable workspace is not read-only");
  const { isolatedHome: _omitted, ...withoutIsolation } = grokSnapshotProof();
  const notIsolated = withoutIsolation as GrokIsolationAttestation;
  assert.equal(validGrokSnapshotReadAttestation(notIsolated, snapshot("xai", { version: "1.0.13" })), false, "the posture includes where the run executed from");
  const stagedPolicy = grokSnapshotProof({ profileHash: grokIsolationProfileHash() });
  assert.equal(validGrokSnapshotReadAttestation(stagedPolicy, snapshot("xai", { version: "1.0.13" })), false, "and which profile it ran under");
  assert.equal(validGrokSnapshotReadAttestation(grokSnapshotProof(), snapshot("xai", { version: "1.0.13" })), true, "the proven posture passes");
});

/**
 * Proof identity is (profile, contract), and these are the cases where the two disagree.
 *
 * The stronger probe — five attempted writes instead of one — changed nothing about the *profile*: same
 * name, same CLI, same platform, same hash. An operator whose cache holds a proof earned under the
 * older contract therefore has an attestation that looks identical to a current one. These tests are
 * the difference, expressed as behaviour rather than as a note about deleting a cache.
 */
test("a Codex proof from an older self-test contract does not authorize a snapshot, whatever else matches", () => {
  const { repo, project } = setupProject();
  const workspaceRoot = join(project.storageDir, "snapshots", "cccccccccccccccccccccccccccccccc", "workspace");
  const codexModel: ModelRef = { providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription" };
  const plan = (attestation: CodexIsolationAttestation) => planShadowInvocation({ snapshot: snapshot("openai"), model: codexModel, cwd: repo, payload: { ...payload, role: "primary" }, codexIsolation: attestation, snapshotPrimary: true, workspaceRoot });

  // A: a record written before the field existed.
  const { probeVersion: _absent, ...legacy } = codexIsolation();
  const legacyAttestation = legacy as CodexIsolationAttestation;
  assert.equal(validCodexIsolationAttestation(legacyAttestation, snapshot("openai"), { minProbeVersion: CODEX_PROBE_VERSION }), false);
  assert.equal(snapshotPrimaryEligibility({ providerId: "openai", snapshot: snapshot("openai"), codexIsolation: legacyAttestation }).eligible, false, "no contract named means the snapshot mode cannot rely on it");
  assert.throws(() => plan(legacyAttestation), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_CODEX_ISOLATION_REQUIRED");

  // B: v1 by name — same profile hash, same version, same platform, unexpired.
  const v1 = codexIsolation({ probeVersion: "codex-sandbox-self-test-v1" });
  assert.equal(v1.profileHash, codexIsolation().profileHash, "the profile hash really is identical, which is the whole problem");
  assert.equal(validCodexIsolationAttestation(v1, snapshot("openai")), true, "the staged roles' check accepts it: their contract is the profile");
  assert.equal(snapshotPrimaryEligibility({ providerId: "openai", snapshot: snapshot("openai"), codexIsolation: v1 }).eligible, false, "and the snapshot mode does not");
  assert.throws(() => plan(v1), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_CODEX_ISOLATION_REQUIRED");

  // C: the current contract, and the mode opens.
  const current = codexIsolation();
  assert.equal(current.probeVersion, CODEX_PROBE_VERSION);
  assert.equal(validCodexIsolationAttestation(current, snapshot("openai"), { minProbeVersion: CODEX_PROBE_VERSION }), true);
  assert.equal(snapshotPrimaryEligibility({ providerId: "openai", snapshot: snapshot("openai"), codexIsolation: current }).eligible, true);
  assert.equal(plan(current).workspaceMode, "staged-read-snapshot");

  // D: expired, current contract.
  const expired = codexIsolation({ observedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
  assert.equal(snapshotPrimaryEligibility({ providerId: "openai", snapshot: snapshot("openai"), codexIsolation: expired }).eligible, false);

  // E: right contract, wrong machine.
  assert.equal(validCodexIsolationAttestation(codexIsolation({ version: "0.1.0" }), snapshot("openai"), { minProbeVersion: CODEX_PROBE_VERSION }), false);
  assert.equal(validCodexIsolationAttestation(codexIsolation({ platform: "linux" }), snapshot("openai"), { minProbeVersion: CODEX_PROBE_VERSION, platform: "darwin" }), false);
  assert.equal(validCodexIsolationAttestation(codexIsolation({ profileHash: "0".repeat(64) }), snapshot("openai"), { minProbeVersion: CODEX_PROBE_VERSION }), false);
});

test("a Grok proof has to name the posture and the contract that proved it", () => {
  const xai = snapshot("xai", { version: "1.0.13" });
  // F: a staged proof, whatever its contract.
  assert.equal(validGrokSnapshotReadAttestation(grokIsolation(), xai), false, "the staged posture is not the snapshot posture");
  assert.equal(validGrokSnapshotReadAttestation(grokSnapshotProof({ profileHash: grokIsolationProfileHash() }), xai), false);
  // G: a snapshot proof from an older contract, and the shape a failed probe leaves behind.
  assert.equal(validGrokSnapshotReadAttestation(grokSnapshotProof({ probeVersion: "grok-snapshot-read-self-test-v1" }), xai), false, "an older contract cannot become sufficient because the strings match");
  const { probeVersion: _omitted, ...withoutContract } = grokSnapshotProof();
  assert.equal(validGrokSnapshotReadAttestation(withoutContract as GrokIsolationAttestation, xai), false, "and a record with no contract named does not either");
  assert.equal(validGrokSnapshotReadAttestation(undefined, xai), false, "a probe that never produced an attestation proves nothing");
  assert.equal(snapshotPrimaryEligibility({ providerId: "xai", snapshot: xai, grokSnapshotIsolation: grokSnapshotProof({ probeVersion: "grok-snapshot-read-self-test-v1" }) }).eligible, false);
  assert.equal(snapshotPrimaryEligibility({ providerId: "xai", snapshot: xai, grokSnapshotIsolation: grokSnapshotProof() }).eligible, true, "the current snapshot-read contract opens it, if one is ever earnable");
});
