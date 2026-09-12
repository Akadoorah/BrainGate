import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError, ProjectRegistry, TaskLedger, budgetFor, classifyTask, parseProjectConfig, type RegisteredProject, InMemoryObservationWriter, ResultStore, createFinalizer, type TaskClassification, type TaskFinalizer } from "@braingate/core";
import { redactSecrets } from "@braingate/security";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, ModelRegistry } from "@braingate/router";
import { codexIsolationProfileHash, type CodexIsolationAttestation, type ShadowInvocationPlan, type ShadowProcessExecutor, type ShadowProcessResult } from "@braingate/shadow";
import { WriteDogfoodRunner, buildWriteTaskPlan } from "./write-runner.js";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "./types.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300_000, 7)]);

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

function snapshot(providerId: ProviderId): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId, displayName: providerId, binary: providerId === "openai" ? "codex" : "claude",
    available: obs(true), version: obs(providerId === "anthropic" ? "2.1.248" : "1.0.0"),
    authState: obs("authenticated"), authMode: obs("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    removedBillingOverrides: [], warnings: [],
  };
}

function isolation(): CodexIsolationAttestation {
  const now = Date.now();
  return {
    providerId: "openai", source: "sandbox-self-test", version: "1.0.0",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    profileHash: codexIsolationProfileHash(), droppedFeatureKeys: [],
    observedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "braingate-visual-run-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "initial"]);
  const registry = new ProjectRegistry(join(root, "state"));
  const project = registry.register(parseProjectConfig({ project_id: "sample", name: "Sample", repositories: [repo] }));
  return { root, repo, project };
}

function registry(): ModelRegistry {
  const models = new ModelRegistry();
  models.register(
    { providerId: "anthropic", modelId: "claude-write", quotaPool: "claude-subscription", capabilities: { coder: 92 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null },
    { available: true, quotaState: "healthy", quotaHint: 0.1, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-07T00:00:00Z" },
  );
  return models;
}

/** Writes a real file into the worktree, the way Claude would. */
class TextWriter implements WriteProviderExecutor {
  async run(input: { plan: WriteProviderPlan }): Promise<WriteProviderResult> {
    writeFileSync(join(input.plan.cwd, "notes.md"), "generated\n");
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "", timedOut: false, durationMs: 4, removedEnvironmentKeys: [] };
  }
}

/**
 * Stands in for Codex: writes the image into its own directory — never the worktree — and
 * declares where it put it, which is exactly the behaviour observed from the real CLI.
 */
class VisualProvider implements ShadowProcessExecutor {
  readonly plans: ShadowInvocationPlan[] = [];
  constructor(private readonly homeDir: string, private readonly reply?: (source: string) => string) {}
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.plans.push(input.plan);
    mkdirSync(this.homeDir, { recursive: true });
    const source = join(this.homeDir, "generated.png");
    writeFileSync(source, PNG);
    const message = this.reply?.(source) ?? `Done. BRAINGATE_ARTIFACTS {"artifacts":[{"sourcePath":${JSON.stringify(source)},"destination":"assets/hero.png"}]}`;
    return {
      spawned: true, exitCode: 0, timedOut: false, durationMs: 9, removedEnvironmentKeys: [],
      stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }),
      stderr: "",
    };
  }
}

async function runVisual(reply?: (source: string) => string, options: { readonly codexHome?: string } = {}) {
  const f = fixture();
  const providerHome = join(f.root, "codex-home");
  const visual = new VisualProvider(providerHome, reply);
  const classification = classifyTask({ text: "add a hero image to the landing page", mode: "write" });
  const budget = budgetFor(classification, { writeRequested: true });
  const runner = new WriteDogfoodRunner({
    project: f.project, ledger: new TaskLedger(f.project), router: new CapabilityRouter(registry()),
    providers: [snapshot("anthropic"), snapshot("openai")], codexIsolation: isolation(),
    writer: new TextWriter(), visualExecutor: visual,
    finalizer: finalizerFor(f.project, new TaskLedger(f.project)),
  });
  const result = await runner.run({
    task: "add a hero image to the landing page", repositoryPath: f.repo, classification, budget,
    requiredContextTokens: 500, observation: observationFor(classification), context: {}, review: false,
    ...(options.codexHome === undefined ? {} : { env: { PATH: process.env.PATH, CODEX_HOME: options.codexHome } }),
    visual: { model: { providerId: "openai", modelId: "gpt-visual", quotaPool: "chatgpt-subscription" }, task: "a hero image", destination: "assets/hero.png" },
  });
  return { f, visual, result, providerHome };
}

test("a visual task lands the image in the worktree and leaves the checkout untouched", async () => {
  const { f, result } = await runVisual();

  assert.ok(result.changedFiles.includes("assets/hero.png"), "the collected artifact must be part of the reviewed change");
  // The bytes are inside the boundary, not merely described.
  assert.deepEqual(readFileSync(join(result.worktree!.path, "assets", "hero.png")), PNG);
  // And the real checkout never saw it.
  assert.equal(git(f.repo, ["status", "--porcelain"]), "");
  assert.equal(result.mergePerformed, false);
});

test("the artifact is summarised for review rather than inlined", async () => {
  const { result } = await runVisual();
  assert.match(result.diff, /new artifact/);
  assert.match(result.diff, /image\/png 300008 bytes sha256:[0-9a-f]{64}/);
  assert.ok(result.diff.length < 20_000, "300 KB of image bytes reached the review diff");
});

test("the visual pass runs read-only against the worktree", async () => {
  const { visual } = await runVisual();
  const plan = visual.plans[0]!;
  // Generation happens in the provider's own home, so nothing is relaxed to permit it.
  assert.equal(plan.guarantees.noProjectWrites, true);
  assert.equal(plan.guarantees.projectOnlyRead, true);
  assert.match(plan.args.join(" "), /features\.image_generation=true/);
});

test("a declared artifact that was never produced fails the task", async () => {
  await assert.rejects(
    () => runVisual(() => 'BRAINGATE_ARTIFACTS {"artifacts":[{"sourcePath":"/tmp/braingate-never-written.png","destination":"a.png"}]}'),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "ARTIFACT_MISSING",
  );
});

test("declaring nothing fails rather than reporting a visual task that produced no image", async () => {
  await assert.rejects(
    () => runVisual(() => "I made an image but will not say where."),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "VISUAL_NO_ARTIFACTS",
  );
});

test("an artifact aimed outside the worktree is refused", async () => {
  await assert.rejects(
    () => runVisual((source) => `BRAINGATE_ARTIFACTS {"artifacts":[{"sourcePath":${JSON.stringify(source)},"destination":"../escaped.png"}]}`),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "ARTIFACT_DESTINATION_DENIED",
  );
});

test("a write task without a visual request is unchanged", async () => {
  const f = fixture();
  const classification = classifyTask({ text: "update the readme line", mode: "write" });
  const budget = budgetFor(classification, { writeRequested: true });
  const runner = new WriteDogfoodRunner({
    project: f.project, ledger: new TaskLedger(f.project), router: new CapabilityRouter(registry()),
    providers: [snapshot("anthropic")], writer: new TextWriter(),
    finalizer: finalizerFor(f.project, new TaskLedger(f.project)),
  });
  const result = await runner.run({ task: "update the readme line", repositoryPath: f.repo, classification, budget, requiredContextTokens: 500, observation: observationFor(classification), context: {}, review: false });
  assert.deepEqual(result.changedFiles, ["notes.md"]);
  assert.doesNotMatch(result.diff, /new artifact/);
});

test("the plan for a visual task still creates no worktree and performs no merge", () => {
  const f = fixture();
  const classification = classifyTask({ text: "add a hero image", mode: "write" });
  const plan = buildWriteTaskPlan({
    router: new CapabilityRouter(registry()), providers: [snapshot("anthropic")],
    classification, budget: budgetFor(classification, { writeRequested: true }),
    requiredContextTokens: 500, repositoryPath: f.repo, baseRef: "HEAD", review: false,
  });
  assert.equal(plan.createsWorktree, false);
  assert.equal(plan.providerCallsOnPlan, 0);
  assert.equal(plan.mergeAvailable, false);
});

/**
 * Stands in for Codex as it actually behaves: it writes the image into its own generated-images
 * directory, under a name the CLI chose, and says so in prose. The model was never told the
 * path, so it cannot declare one.
 */
class SilentVisualProvider implements ShadowProcessExecutor {
  constructor(private readonly codexHome: string, private readonly writes = 1) {}
  async run(): Promise<ShadowProcessResult> {
    for (let index = 0; index < this.writes; index += 1) {
      const session = join(this.codexHome, "generated_images", `session-${String(index)}`);
      mkdirSync(session, { recursive: true });
      writeFileSync(join(session, `exec-${String(index)}.png`), PNG);
    }
    return {
      spawned: true, exitCode: 0, timedOut: false, durationMs: 11, removedEnvironmentKeys: [],
      stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Created the PNG with a blue circle centred on a white background." } }),
      stderr: "",
    };
  }
}

// ADR 0007 asked the provider for the absolute path it wrote. Running it against the real CLI
// showed that it cannot answer: Codex names generated files itself and never tells the model.
// The task failed with "declared no artifacts" while a perfectly good PNG sat on disk.
test("an image is collected from where the provider actually wrote it, not from what it said", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "braingate-codex-home-"));
  const f = fixture();
  const classification = classifyTask({ text: "add a hero image to the landing page", mode: "write" });
  const runner = new WriteDogfoodRunner({
    project: f.project, ledger: new TaskLedger(f.project), router: new CapabilityRouter(registry()),
    providers: [snapshot("anthropic"), snapshot("openai")], codexIsolation: isolation(),
    writer: new TextWriter(), visualExecutor: new SilentVisualProvider(codexHome),
    finalizer: finalizerFor(f.project, new TaskLedger(f.project)),
  });
  const result = await runner.run({
    task: "add a hero image to the landing page", repositoryPath: f.repo, classification,
    budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 500,
    observation: observationFor(classification), context: {}, review: false, env: { PATH: process.env.PATH, CODEX_HOME: codexHome },
    visual: { model: { providerId: "openai", modelId: "gpt-visual", quotaPool: "chatgpt-subscription" }, task: "a hero image", destination: "assets/hero.png" },
  });

  assert.ok(result.changedFiles.includes("assets/hero.png"));
  assert.deepEqual(readFileSync(join(result.worktree!.path, "assets", "hero.png")), PNG);
  assert.equal(git(f.repo, ["status", "--porcelain"]), "", "the real checkout never sees it");
});

test("only what this run produced is collected, never an image from an earlier one", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "braingate-codex-home-prior-"));
  // A previous task's output is already sitting there. Collecting it would attach someone
  // else's image to this task and pass it through review as this task's work.
  mkdirSync(join(codexHome, "generated_images", "old-session"), { recursive: true });
  writeFileSync(join(codexHome, "generated_images", "old-session", "exec-old.png"), Buffer.concat([PNG, Buffer.from("OLD")]));

  const f = fixture();
  const classification = classifyTask({ text: "add a hero image to the landing page", mode: "write" });
  const runner = new WriteDogfoodRunner({
    project: f.project, ledger: new TaskLedger(f.project), router: new CapabilityRouter(registry()),
    providers: [snapshot("anthropic"), snapshot("openai")], codexIsolation: isolation(),
    writer: new TextWriter(), visualExecutor: new SilentVisualProvider(codexHome),
    finalizer: finalizerFor(f.project, new TaskLedger(f.project)),
  });
  const result = await runner.run({
    task: "add a hero image to the landing page", repositoryPath: f.repo, classification,
    budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 500,
    observation: observationFor(classification), context: {}, review: false, env: { PATH: process.env.PATH, CODEX_HOME: codexHome },
    visual: { model: { providerId: "openai", modelId: "gpt-visual", quotaPool: "chatgpt-subscription" }, task: "a hero image", destination: "assets/hero.png" },
  });

  assert.deepEqual(result.changedFiles.filter((file) => file.startsWith("assets/")), ["assets/hero.png"]);
  assert.deepEqual(readFileSync(join(result.worktree!.path, "assets", "hero.png")), PNG, "the earlier image must not be picked up");
});

test("several images from one request are kept apart rather than overwriting each other", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "braingate-codex-home-many-"));
  const f = fixture();
  const classification = classifyTask({ text: "add hero images", mode: "write" });
  const runner = new WriteDogfoodRunner({
    project: f.project, ledger: new TaskLedger(f.project), router: new CapabilityRouter(registry()),
    providers: [snapshot("anthropic"), snapshot("openai")], codexIsolation: isolation(),
    writer: new TextWriter(), visualExecutor: new SilentVisualProvider(codexHome, 2),
    finalizer: finalizerFor(f.project, new TaskLedger(f.project)),
  });
  const result = await runner.run({
    task: "add hero images", repositoryPath: f.repo, classification,
    budget: budgetFor(classification, { writeRequested: true }), requiredContextTokens: 500,
    observation: observationFor(classification), context: {}, review: false, env: { PATH: process.env.PATH, CODEX_HOME: codexHome },
    visual: { model: { providerId: "openai", modelId: "gpt-visual", quotaPool: "chatgpt-subscription" }, task: "two hero images", destination: "assets/hero.png" },
  });
  assert.ok(result.changedFiles.includes("assets/hero.png"));
  assert.ok(result.changedFiles.includes("assets/hero-2.png"), `got ${result.changedFiles.join(", ")}`);
});
