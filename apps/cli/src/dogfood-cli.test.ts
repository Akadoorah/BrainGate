import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRegistry, type RegisteredProject } from "@braingate/core";
import { DogfoodStore, initializeDogfoodProject } from "@braingate/dogfood";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "@braingate/write";
import { runDogfoodCli, suggestedProjectId, roleLine } from "./dogfood-cli.js";

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

function freshRepo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "braingate-firstrun-"));
  const repo = join(root, name); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.email", "test@example.invalid"]); git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "x.txt"), "x\n"); git(repo, ["add", "x.txt"]); git(repo, ["commit", "-m", "initial"]);
  return repo;
}

test("a project id is suggested from the directory name, or withheld when nothing usable remains", () => {
  assert.equal(suggestedProjectId("my-cool-app"), "my-cool-app");
  assert.equal(suggestedProjectId("My Cool App"), "my-cool-app");
  assert.equal(suggestedProjectId("Waslo_v2 (final)"), "waslo-v2-final");
  assert.equal(suggestedProjectId("...."), null);
  assert.equal(suggestedProjectId(""), null);
});

test("init proposes an identity and uses the answers, rather than deciding silently", async () => {
  const repo = freshRepo("my-cool-app");
  const out = io();
  const asked: string[] = [];
  const result = await runDogfoodCli(["init"], {
    cwd: repo,
    env: { BRAINGATE_HOME: join(repo, "..", "brain-home") },
    stdout: out.stdout, stderr: out.stderr,
    ask: async (question) => { asked.push(question); return ""; },
  });
  assert.equal(result.exitCode, 0);
  // Both answers were blank, so both suggestions stand.
  assert.match(asked[0] ?? "", /\[my-cool-app\]/);
  assert.match(asked[1] ?? "", /\[my-cool-app\]/);
  assert.equal(JSON.parse(readFileSync(join(repo, ".brain", "project.json"), "utf8")).project_id, "my-cool-app");
  // The identity is the isolation boundary, so say so, and say what to run next.
  assert.match(out.out(), /isolation boundary/);
  assert.match(out.out(), /braingate dogfood preflight/);
});

test("an answer overrides the suggestion", async () => {
  const repo = freshRepo("my-cool-app");
  const out = io();
  const answers = ["chosen-id", "Chosen Name"];
  const result = await runDogfoodCli(["init"], {
    cwd: repo, env: { BRAINGATE_HOME: join(repo, "..", "brain-home") },
    stdout: out.stdout, stderr: out.stderr,
    ask: async () => answers.shift() ?? "",
  });
  assert.equal(result.exitCode, 0);
  const manifest = JSON.parse(readFileSync(join(repo, ".brain", "project.json"), "utf8"));
  assert.equal(manifest.project_id, "chosen-id");
  assert.equal(manifest.name, "Chosen Name");
});

test("with no terminal to ask, init names the flags instead of blocking on stdin", async () => {
  const repo = freshRepo("my-cool-app");
  const out = io();
  // ask omitted: a pipe, CI, or an editor task. Reading stdin anyway would hang forever.
  const result = await runDogfoodCli(["init"], { cwd: repo, env: { BRAINGATE_HOME: join(repo, "..", "brain-home") }, stdout: out.stdout, stderr: out.stderr });
  assert.notEqual(result.exitCode, 0);
  assert.match(out.err(), /--project-id/);
  assert.match(out.err(), /suggested id: my-cool-app/);
});

test("explicit flags still skip the question entirely, so scripted use is unchanged", async () => {
  const repo = freshRepo("my-cool-app");
  const out = io();
  let asked = 0;
  const result = await runDogfoodCli(["init", "--project-id", "scripted", "--name", "Scripted"], {
    cwd: repo, env: { BRAINGATE_HOME: join(repo, "..", "brain-home") },
    stdout: out.stdout, stderr: out.stderr,
    ask: async () => { asked += 1; return ""; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(asked, 0);
  assert.equal(JSON.parse(readFileSync(join(repo, ".brain", "project.json"), "utf8")).project_id, "scripted");
});

// `braingate` is installed on PATH, so running it from the wrong directory is the ordinary
// mistake. It used to reach the catch-all and print CLI_UNEXPECTED with details suppressed,
// which tells the user nothing about what to do next.
test("running outside a registered project says so, instead of an unexpected failure", async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "braingate-no-project-"));
  const out = io();
  const result = await runDogfoodCli(["dogfood", "preflight"], { cwd: elsewhere, env: { BRAINGATE_HOME: join(elsewhere, "brain-home") }, stdout: out.stdout, stderr: out.stderr });
  assert.notEqual(result.exitCode, 0);
  const text = `${out.out()}${out.err()}`;
  assert.match(text, /CLI_PROJECT_NOT_FOUND/);
  assert.match(text, /braingate init/);
  assert.doesNotMatch(text, /CLI_UNEXPECTED/);
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

// The plan is what an operator reads before spending. A preview that showed only the executor
// would hide the model the task leads with, which is the routing decision worth seeing.
test("a plan for complex work names the planner as well as the executor", async () => {
  const f = fixture();
  const state = resolveOperatorState(f.env, f.repo);
  const catalog = new ModelCatalog(state.modelCatalogPath);
  catalog.upsert({ providerId: "anthropic", modelId: "planner-model", quotaPool: "claude-subscription", capabilities: { planner: 96, coder: 40 }, speed: "deep", contextCapacity: 1_000_000, writeCapable: true, reasoning: 96, underlyingFamily: null });
  // A reviewer as well, since anything reaching T3 requires one.
  catalog.upsert({ providerId: "anthropic", modelId: "reviewer-model", quotaPool: "claude-subscription", capabilities: { reviewer: 90 }, speed: "balanced", contextCapacity: 200_000, writeCapable: false, reasoning: 88, underlyingFamily: null });

  const out = io();
  const shadow = new FakeShadowExecutor();
  const result = await runDogfoodCli(
    ["dogfood", "ask", "plan", "--task", "Review the caching approach across the whole application and compare the options"],
    { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: shadow, stdout: out.stdout, stderr: out.stderr },
  );
  assert.equal(result.exitCode, 0, out.err());
  assert.match(out.out(), /planner=anthropic\/planner-model/);
  assert.match(out.out(), /primary=anthropic\/claude-test/);
  // A preview costs nothing, planner or not.
  assert.equal(shadow.calls.length, 0);
});

// The first thing anyone does is open BrainGate in a new folder. It asked for a project id and
// a display name, then failed with git's own error — so the answer arrived after the questions,
// in a vocabulary that belongs to a different tool.
test("a directory with no repository is offered one before the identity questions", async () => {
  const bare = mkdtempSync(join(tmpdir(), "braingate-cli-fresh-"));
  const asked: string[] = [];
  const output = io();
  const result = await runDogfoodCli(["init"], {
    cwd: bare,
    env: { BRAINGATE_HOME: join(bare, "brain-home") },
    stdout: output.stdout,
    stderr: output.stderr,
    ask: async (question: string) => {
      asked.push(question);
      if (/git init/.test(question)) return "y";
      return /id/i.test(question) ? "fresh" : "Fresh";
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(asked[0] ?? "", /git init/, "the repository question must come first");
  assert.match(output.out(), /needs a repository to work in/);
  assert.equal(existsSync(join(bare, ".git")), true);
  assert.equal(existsSync(join(bare, ".brain", "project.json")), true);
});

test("declining leaves the directory exactly as it was", async () => {
  const bare = mkdtempSync(join(tmpdir(), "braingate-cli-declined-"));
  const output = io();
  const result = await runDogfoodCli(["init"], {
    cwd: bare,
    env: { BRAINGATE_HOME: join(bare, "brain-home") },
    stdout: output.stdout,
    stderr: output.stderr,
    ask: async () => "n",
  });

  assert.equal(result.exitCode, 1);
  assert.match(output.err(), /PROJECT_NOT_A_REPOSITORY/);
  // Saying no has to mean nothing happened, including no half-registered project.
  assert.equal(existsSync(join(bare, ".git")), false);
  assert.equal(existsSync(join(bare, ".brain")), false);
});

test("with no terminal to ask, nothing is created on a guess", async () => {
  const bare = mkdtempSync(join(tmpdir(), "braingate-cli-noninteractive-"));
  const output = io();
  const result = await runDogfoodCli(["init", "--project-id", "fresh", "--name", "Fresh"], {
    cwd: bare,
    env: { BRAINGATE_HOME: join(bare, "brain-home") },
    stdout: output.stdout,
    stderr: output.stderr,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(join(bare, ".git")), false);

  // `--git-init` is how a script says yes, since there is nobody to ask.
  const explicit = await runDogfoodCli(["init", "--git-init", "--project-id", "fresh", "--name", "Fresh"], {
    cwd: bare,
    env: { BRAINGATE_HOME: join(bare, "brain-home") },
    stdout: output.stdout,
    stderr: output.stderr,
  });
  assert.equal(explicit.exitCode, 0);
  assert.equal(existsSync(join(bare, ".git")), true);
});

test("a role that appears twice is numbered, so two approaches read as two", () => {
  const line = roleLine([
    { role: "planner", model: { providerId: "anthropic", modelId: "opus" } },
    { role: "planner", model: { providerId: "google", modelId: "gemini" } },
    { role: "primary", model: { providerId: "anthropic", modelId: "sonnet" } },
  ]);
  assert.equal(line, "planner-1=anthropic/opus · planner-2=google/gemini · primary=anthropic/sonnet");
});

test("a role that appears once keeps its plain name", () => {
  assert.equal(
    roleLine([{ role: "primary", model: { providerId: "anthropic", modelId: "haiku" } }]),
    "primary=anthropic/haiku",
  );
});
