import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
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
  NodeShadowProcessExecutor,
  ShadowDogfoodRunner,
  SubscriptionShadowAgentInvoker,
  planShadowInvocation,
  previewShadowInvocation,
  shadowProviderStatus,
  type ShadowInvocationPlan,
  type ShadowProcessExecutor,
  type ShadowProcessResult,
  type ShadowRolePayload,
  type SubscriptionAttestation,
} from "./index.js";

function setupProject() {
  const root = mkdtempSync(join(tmpdir(), "braingate-shadow-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const registry = new ProjectRegistry(join(root, "registry"));
  const project = registry.register(parseProjectConfig({ project_id: "sample", name: "Sample", repositories: [repo] }));
  return { root, repo, project };
}

function snapshot(providerId: ProviderId, values: { auth?: "subscription" | "api" | "unknown"; state?: "authenticated" | "unauthenticated" | "unknown"; version?: string; binary?: string } = {}): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T, evidence: "native" | "unknown" = "native") => ({ value, evidence, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName: providerId,
    binary: values.binary ?? (providerId === "anthropic" ? "claude" : providerId === "github-copilot" ? "copilot" : providerId),
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

const model: ModelRef = { providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription" };
const payload: ShadowRolePayload = { schemaVersion: 1, role: "primary", phase: "initial", task: "private task body", findings: [], context: { secretContext: "private context body" }, responseContract: { kind: "work", output: "string" } };

test("Claude profile is restricted/read-only and keeps task/context out of argv", () => {
  const { repo } = setupProject();
  const plan = planShadowInvocation({ snapshot: snapshot("anthropic"), model, cwd: repo, payload, now: new Date("2026-09-07T01:00:00Z") });
  const command = plan.args.join(" ");
  assert.match(command, /--restricted/);
  assert.match(command, /--tools Read,Glob,Grep/);
  assert.match(command, /mcp__\*/);
  assert.match(command, /--no-session-persistence/);
  assert.doesNotMatch(command, /--bare|dangerously-skip|private task body|private context body/);
  assert.match(plan.stdin ?? "", /private task body/);
  const preview = JSON.stringify(previewShadowInvocation(plan));
  assert.doesNotMatch(preview, /private task body|private context body/);
});

test("Claude restricted profile enforces minimum version and rejects explicit API auth", () => {
  const { repo } = setupProject();
  assert.throws(() => planShadowInvocation({ snapshot: snapshot("anthropic", { version: "2.1.247" }), model, cwd: repo, payload }), /at least 2\.1\.248/);
  assert.throws(() => planShadowInvocation({ snapshot: snapshot("anthropic", { auth: "api" }), model, cwd: repo, payload }), (error: unknown) => error instanceof Error && /API billing/.test(error.message));
});

test("Copilot requires proven subscription or short-lived local attestation and exposes only read tools", () => {
  const { repo } = setupProject();
  const copilotModel: ModelRef = { providerId: "github-copilot", modelId: "claude-sonnet-4.6", quotaPool: "copilot" };
  const unknown = snapshot("github-copilot", { auth: "unknown", state: "unknown" });
  assert.throws(() => planShadowInvocation({ snapshot: unknown, model: copilotModel, cwd: repo, payload }), /attestation/);
  const attestation: SubscriptionAttestation = { providerId: "github-copilot", mode: "subscription", source: "user-confirmed-oauth", observedAt: "2026-09-07T00:00:00Z", expiresAt: "2026-09-08T00:00:00Z" };
  const plan = planShadowInvocation({ snapshot: unknown, model: copilotModel, cwd: repo, payload, attestation, now: new Date("2026-09-07T01:00:00Z") });
  const command = plan.args.join(" ");
  assert.match(command, /available-tools=view,grep,glob/);
  assert.match(command, /deny-tool=write/);
  assert.match(command, /deny-tool=shell/);
  assert.match(command, /disable-builtin-mcps/);
  assert.match(command, /no-custom-instructions/);
  assert.doesNotMatch(command, /private task body|private context body/);
  assert.match(plan.attachmentContent ?? "", /private task body/);
});

test("Codex, Grok and Antigravity automated shadow profiles fail closed", () => {
  const { repo } = setupProject();
  for (const providerId of ["openai", "xai", "google"] as const) {
    assert.equal(shadowProviderStatus(providerId).enabled, false);
    assert.throws(() => planShadowInvocation({ snapshot: snapshot(providerId), model: { providerId, modelId: "model-x", quotaPool: `${providerId}-pool` }, cwd: repo, payload }), /blocked|isolation|verified|read/i);
  }
});

class FakeExecutor implements ShadowProcessExecutor {
  calls: ShadowInvocationPlan[] = [];
  readonly response: (plan: ShadowInvocationPlan) => string;
  constructor(response: (plan: ShadowInvocationPlan) => string) { this.response = response; }
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    return { spawned: true, exitCode: 0, stdout: this.response(input.plan), stderr: "", timedOut: false, durationMs: 12, removedEnvironmentKeys: ["OPENAI_API_KEY"] };
  }
}

test("shadow invoker sends Claude payload through stdin while argv remains generic", async () => {
  const { repo, project } = setupProject();
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "safe answer" }) }));
  const invoker = new SubscriptionShadowAgentInvoker({ project, cwd: repo, snapshots: [snapshot("anthropic")], context: { relevant: "context" }, executor: fake });
  const request: AgentRequest = { role: "primary", model, phase: "initial", task: "private task body", findings: [] };
  const result = await invoker.invoke(request);
  assert.deepEqual(result, { kind: "work", output: "safe answer" });
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0]!.stdin ?? "", /private task body/);
  assert.doesNotMatch(fake.calls[0]!.args.join(" "), /private task body/);
});

test("node executor blocks cwd escapes, scrubs API env overrides and redacts captured secrets", async () => {
  const { repo, project, root } = setupProject();
  const plan: ShadowInvocationPlan = {
    providerId: "anthropic", executable: process.execPath,
    args: ["-e", "process.stdout.write(String(process.env.OPENAI_API_KEY)+' sk-abcdefghijklmnopqrstuvwxyz012345')"],
    cwd: repo, modelId: "test", quotaPool: "test", inputMode: "stdin", stdin: "{}", attachmentContent: null, attachmentToken: null,
    allowedEnvKeys: [], envOverrides: {}, guarantees: { projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true }, minimumVersion: null,
  };
  const executor = new NodeShadowProcessExecutor();
  const result = await executor.run({ project, plan, env: { PATH: process.env.PATH, OPENAI_API_KEY: "should-not-pass" } });
  assert.match(result.stdout, /^undefined /);
  assert.doesNotMatch(result.stdout, /should-not-pass|sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(result.stdout, /REDACTED/);
  await assert.rejects(() => executor.run({ project, plan: { ...plan, cwd: root } }), /outside the registered project/);
});

test("dogfood dry-run performs full T0 preflight with zero executor calls and zero usage", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const router = new CapabilityRouter(registryWithClaude());
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "unused" }) }));
  const taskText = "Where is the theme config?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  assert.equal(classification.complexity, "T0");
  assert.equal(classification.risk, "low");
  try {
    const result = await new ShadowDogfoodRunner({ project, ledger, router, snapshots: [snapshot("anthropic")], executor: fake }).run({
      title: "Inspect theme config", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/theme.ts"] }, contextSummary: { memoryRecords: 1, explicitCandidates: 1, includedItems: 2, estimatedTokens: 500, truncatedItems: 0 }, dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(fake.calls.length, 0);
    assert.equal(result.taskReceipt.usage.length, 0);
    assert.equal(result.taskReceipt.task.state, "completed");
    assert.ok(result.taskReceipt.events.some((event) => event.kind === "shadow.dry_run"));
  } finally { ledger.close(); }
});

test("real T0 shadow run uses one bounded provider call and records unknown token usage honestly", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const router = new CapabilityRouter(registryWithClaude());
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "theme config is in src/theme.ts" }) }));
  const taskText = "Where is the theme config?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  assert.equal(classification.complexity, "T0");
  assert.equal(classification.risk, "low");
  try {
    const result = await new ShadowDogfoodRunner({ project, ledger, router, snapshots: [snapshot("anthropic")], executor: fake }).run({
      title: "Inspect theme config", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
      context: { files: ["src/theme.ts"] }, contextSummary: { memoryRecords: 1, explicitCandidates: 1, includedItems: 2, estimatedTokens: 500, truncatedItems: 0 }, dryRun: false,
    });
    assert.equal(fake.calls.length, 1);
    assert.equal(result.workflow?.budget.providerCalls, 1);
    assert.equal(result.taskReceipt.task.state, "completed");
    assert.ok(result.taskReceipt.usage.some((usage) => usage.metric === "provider_call" && usage.evidence === "measured" && usage.value === 1));
    assert.ok(result.taskReceipt.usage.some((usage) => usage.metric === "provider_tokens" && usage.evidence === "unknown" && usage.value === null));
  } finally { ledger.close(); }
});

test("high-risk auth shadow preflight fails closed without an independent reviewer and spends zero calls", async () => {
  const { repo, project } = setupProject();
  const ledger = new TaskLedger(project);
  const router = new CapabilityRouter(registryWithClaude());
  const fake = new FakeExecutor(() => JSON.stringify({ result: JSON.stringify({ kind: "work", output: "must not run" }) }));
  const taskText = "Where is the auth session stored?";
  const classification = classifyTask({ text: taskText, mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  assert.equal(classification.risk, "high");
  assert.equal(classification.complexity, "T3");
  try {
    await assert.rejects(
      () => new ShadowDogfoodRunner({ project, ledger, router, snapshots: [snapshot("anthropic")], executor: fake }).run({
        title: "Inspect auth session", task: taskText, cwd: repo, classification, budget, requiredContextTokens: 500,
        context: { files: ["src/auth.ts"] }, contextSummary: { memoryRecords: 1, explicitCandidates: 1, includedItems: 2, estimatedTokens: 500, truncatedItems: 0 }, dryRun: true,
      }),
      /No eligible model for role reviewer/,
    );
    assert.equal(fake.calls.length, 0);
    assert.equal(ledger.listTasks().length, 0);
  } finally { ledger.close(); }
});
