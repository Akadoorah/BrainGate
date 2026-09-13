import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { BrainGateInvariantError, ProjectRegistry, TaskLedger, type RegisteredProject, type TaskClassification, type TaskComplexity, type TaskRisk } from "@braingate/core";
import { applyDogfoodPrior, DogfoodStore, emptyDogfoodPrior, initializeDogfoodProject, inspectGitRepository, repositoryReadiness } from "./index.js";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout ?? "").trim();
}

function repoFixture(label: string): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), `braingate-dogfood-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "app.txt"), "hello\n");
  git(repo, ["add", "app.txt"]); git(repo, ["commit", "-m", "initial"]);
  return { root, repo };
}

function registered(label: string): { root: string; repo: string; project: RegisteredProject } {
  const f = repoFixture(label);
  const registry = new ProjectRegistry(join(f.root, "brain-home"));
  const project = registry.register({ projectId: `${label}` as never, name: label, repositories: [f.repo] });
  return { ...f, project };
}

function classification(complexity: TaskComplexity, risk: TaskRisk): TaskClassification {
  return Object.freeze({ complexity, risk, confidence: 0.8, requiresScout: complexity !== "T0", reasons: Object.freeze(["test"]), sensitiveDomains: Object.freeze([]), ruleVersion: "test-rule" });
}

function receipt(project: RegisteredProject, complexity: TaskComplexity, risk: TaskRisk) {
  const ledger = new TaskLedger(project);
  const task = ledger.createTask({ title: `Dogfood ${complexity}`, complexity, risk });
  ledger.transition(task.taskId, "running");
  ledger.recordUsage({ taskId: task.taskId, provider: "anthropic", model: "test-model", evidence: "measured", metric: "provider_call", value: 1, unit: "call" });
  ledger.transition(task.taskId, "completed");
  const result = ledger.receipt(task.taskId);
  ledger.close();
  return result;
}

function record(store: DogfoodStore, project: RegisteredProject, complexity: TaskComplexity = "T1", risk: TaskRisk = "low") {
  const predicted = classification(complexity, risk);
  const taskReceipt = receipt(project, complexity, risk);
  return store.recordObservation({
    taskId: taskReceipt.task.taskId,
    receipt: taskReceipt,
    mode: "ask",
    predicted,
    effective: predicted,
    roles: [{ role: "primary", providerId: "anthropic", modelId: "test-model" }],
    outcome: "success",
    failureKind: null,
    prior: null,
    reconciled: false,
    reviewerVerdict: null,
  });
}

test("project init is local-only, idempotent, and refuses identity conflicts", () => {
  const { repo } = repoFixture("init");
  const first = initializeDogfoodProject({ cwd: repo, projectId: "waslo", name: "Waslo" });
  assert.equal(first.created, true);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8")) as { project_id: string; repositories: string[] };
  assert.equal(manifest.project_id, "waslo");
  assert.deepEqual(manifest.repositories, [realpathSync.native(repo)]);
  const second = initializeDogfoodProject({ cwd: repo, projectId: "waslo", name: "Waslo" });
  assert.equal(second.created, false);
  assert.throws(() => initializeDogfoodProject({ cwd: repo, projectId: "other", name: "Other" }), /will not be overwritten/);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
});

// A directory with no repository is a workspace. Git is a capability one may have, not a
// precondition for being registered, and this used to be the one place BrainGate turned people away
// — with git's own error, after it had already asked for a project id and a display name.
test("a directory with no repository is registered as a workspace, not turned away", () => {
  const bare = mkdtempSync(join(tmpdir(), "braingate-no-repo-"));
  try {
    assert.equal(repositoryReadiness(bare).repositoryPath, null);
    const result = initializeDogfoodProject({ cwd: bare, projectId: "fresh", name: "Fresh" });
    assert.equal(result.created, true);
    assert.equal(result.hasRepository, false);
    assert.equal(result.repositoryPath, realpathSync.native(bare), "the workspace is the directory they are in");
    assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, "utf8")).repositories, [realpathSync.native(bare)]);
    assert.equal(existsSync(join(bare, ".git")), false, "registering must not create a repository");
    // Registration is what the manifest says; nothing above it is consulted.
    const registry = new ProjectRegistry(join(bare, "..", "fresh-home"));
    assert.equal(registry.loadFile(result.manifestPath).repositories[0], realpathSync.native(bare));
    assert.equal(initializeDogfoodProject({ cwd: bare, projectId: "fresh", name: "Fresh" }).created, false);
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

test("a subdirectory of a repository is registered as itself, not widened to the repository root", () => {
  const f = repoFixture("subdir-init");
  try {
    const workspace = join(f.repo, "flutter_migration");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "main.dart"), "void main() {}\n");
    const result = initializeDogfoodProject({ cwd: workspace, projectId: "flutter-migration", name: "Flutter Migration" });
    assert.equal(result.hasRepository, true, "a repository is still metadata it has");
    assert.equal(result.repositoryPath, realpathSync.native(workspace), "and the workspace is the selected directory");
    assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, "utf8")).repositories, [realpathSync.native(workspace)]);
    // The manifest still stays out of Git: the ignore is written to the repository's own exclude,
    // which is found from the subdirectory. The untracked source file is the operator's, not ours.
    assert.doesNotMatch(git(f.repo, ["status", "--porcelain", "--untracked-files=all"]), /\.brain\//);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("creating the repository is something BrainGate is asked to do, never something it assumes", () => {
  const bare = mkdtempSync(join(tmpdir(), "braingate-git-init-"));
  try {
    const result = initializeDogfoodProject({ cwd: bare, projectId: "fresh", name: "Fresh", createRepository: true });
    assert.equal(result.created, true);
    assert.equal(result.hasRepository, true);
    assert.equal(existsSync(join(bare, ".git")), true);
    // The manifest is registered against the repository that was just made, and stays out of it.
    assert.equal(git(result.repositoryPath, ["status", "--porcelain"]), "");
    assert.equal(repositoryReadiness(bare).repositoryPath, result.repositoryPath);
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

test("a repository with no commit yet is a state to report, not a crash", () => {
  const bare = mkdtempSync(join(tmpdir(), "braingate-unborn-"));
  try {
    const result = initializeDogfoodProject({ cwd: bare, projectId: "fresh", name: "Fresh", createRepository: true });
    // `git rev-parse HEAD` fails on an unborn branch, which is exactly where someone who just ran
    // `git init` is standing. Questions work there; worktree writes need a commit to branch from.
    const state = inspectGitRepository(result.repositoryPath);
    assert.equal(state.head, null);
    assert.equal(state.clean, true);
    assert.notEqual(state.branch, null);
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

test("dogfood telemetry is physically project scoped and append-only", () => {
  const a = registered("project-a"); const b = registered("project-b");
  const storeA = new DogfoodStore(a.project); const storeB = new DogfoodStore(b.project);
  try {
    const runB = record(storeB, b.project);
    assert.equal(storeA.getRun(runB.taskId), undefined);
    assert.notEqual(storeA.databasePath, storeB.databasePath);
    const db = new Database(storeB.databasePath);
    try {
      assert.throws(() => db.prepare("UPDATE dogfood_runs SET outcome = 'failed'").run(), /append-only/);
      assert.throws(() => db.prepare("DELETE FROM dogfood_runs").run(), /append-only/);
    } finally { db.close(); }
  } finally { storeA.close(); storeB.close(); }
});

test("persistence rejects de-escalated effective classifications and mismatched prior modes", () => {
  const f = registered("persistence-guard"); const store = new DogfoodStore(f.project);
  try {
    const predicted = classification("T2", "medium");
    const taskReceipt = receipt(f.project, "T2", "medium");
    const base = {
      taskId: taskReceipt.task.taskId,
      receipt: taskReceipt,
      mode: "ask" as const,
      predicted,
      roles: [{ role: "primary" as const, providerId: "anthropic", modelId: "test-model" }],
      outcome: "success" as const,
      failureKind: null,
      prior: null,
      reconciled: false,
      reviewerVerdict: null,
    };
    assert.throws(() => store.recordObservation({ ...base, effective: classification("T1", "medium") }), /effective complexity cannot be lower/);
    assert.throws(() => store.recordObservation({ ...base, effective: classification("T2", "low") }), /effective risk cannot be lower/);
    assert.throws(() => store.recordObservation({ ...base, effective: predicted, prior: emptyDogfoodPrior("write") }), /prior mode must match/);
    assert.equal(store.report().runs, 0);
  } finally { store.close(); }
});

test("adaptive prior needs three feedback samples and can only escalate", () => {
  const f = registered("adaptive"); const store = new DogfoodStore(f.project);
  try {
    for (let index = 0; index < 2; index += 1) {
      const run = record(store, f.project, "T1", "low");
      store.recordFeedback({ taskId: run.taskId, actualComplexity: "T2", outcome: "success" });
    }
    assert.equal(store.derivePrior("ask").active, false);
    const third = record(store, f.project, "T1", "low");
    store.recordFeedback({ taskId: third.taskId, actualComplexity: "T2", outcome: "success" });
    const prior = store.derivePrior("ask");
    assert.equal(prior.active, true); assert.equal(prior.complexityFloor, "T2");
    const raised = applyDogfoodPrior(classification("T1", "low"), prior);
    assert.equal(raised.effective.complexity, "T2"); assert.equal(raised.applied, true);
    const alreadyHigher = applyDogfoodPrior(classification("T3", "high"), prior);
    assert.equal(alreadyHigher.effective.complexity, "T3"); assert.equal(alreadyHigher.effective.risk, "high"); assert.equal(alreadyHigher.applied, false);
  } finally { store.close(); }
});

test("risk prior restores its complexity floor and never de-escalates", () => {
  const f = registered("risk-prior"); const store = new DogfoodStore(f.project);
  try {
    for (let index = 0; index < 3; index += 1) {
      const run = record(store, f.project, "T1", "low");
      store.recordFeedback({ taskId: run.taskId, actualComplexity: "T2", actualRisk: "high", outcome: "partial" });
    }
    const prior = store.derivePrior("ask");
    assert.equal(prior.riskFloor, "high");
    const applied = applyDogfoodPrior(classification("T1", "low"), prior);
    assert.equal(applied.effective.risk, "high"); assert.equal(applied.effective.complexity, "T3");
  } finally { store.close(); }
});

test("report and regression JSONL are deterministic and contain no prompt/diff surfaces", () => {
  const f = registered("regression"); const store = new DogfoodStore(f.project);
  try {
    const one = record(store, f.project, "T1", "low");
    const two = record(store, f.project, "T2", "medium");
    store.recordFeedback({ taskId: two.taskId, actualComplexity: "T3", actualRisk: "high", outcome: "failed", regression: true });
    store.recordFeedback({ taskId: one.taskId, actualComplexity: "T1", outcome: "success", regression: true });
    const report = store.report();
    assert.equal(report.runs, 2); assert.equal(report.feedback, 2); assert.equal(report.regressions, 2);
    const first = store.regressionJsonl(); const second = store.regressionJsonl();
    assert.equal(first, second);
    assert.doesNotMatch(first, /prompt|candidateOutput|reasoning|diff|UNIQUE_SECRET/);
    const lines = first.trim().split("\n").map((line) => JSON.parse(line) as { taskId: string });
    assert.deepEqual(lines.map((line) => line.taskId), [...lines.map((line) => line.taskId)].sort());
  } finally { store.close(); }
});

// `planner` was added to WorkflowRole and this validator was not updated, so a task planned,
// executed and reviewed successfully and was then rejected on the way into telemetry — after
// the work was done and paid for. Every role the engine can route must be storable.
test("every workflow role can be recorded, so none fails a task after it succeeded", () => {
  const f = registered("all-roles");
  const store = new DogfoodStore(f.project);
  try {
    const roles = (["planner", "primary", "reviewer", "judge"] as const).map((role) => ({ role, providerId: "anthropic", modelId: `${role}-model` }));
    const taskReceipt = receipt(f.project, "T3", "low");
    store.recordObservation({
      taskId: taskReceipt.task.taskId,
      receipt: taskReceipt,
      mode: "ask",
      predicted: classification("T3", "low"),
      effective: classification("T3", "low"),
      roles,
      outcome: "success",
      failureKind: null,
      prior: null,
      reconciled: false,
      reviewerVerdict: null,
    });
    const stored = store.listRuns().at(-1)!;
    assert.deepEqual(stored.roles.map((entry) => entry.role), ["planner", "primary", "reviewer", "judge"]);
  } finally { store.close(); }
});

test("a rebind moves a registration to this checkout, and only when it is asked for", () => {
  const f = repoFixture("rebind");
  try {
    // Registered against a checkout that is not this one, which is what a copied clone looks like.
    const other = join(f.root, "other-repo");
    mkdirSync(other);
    git(other, ["init", "-q", "-b", "main"]);
    git(other, ["config", "user.email", "test@example.invalid"]);
    git(other, ["config", "user.name", "BrainGate Test"]);

    mkdirSync(join(f.repo, ".brain"), { recursive: true });
    const manifest = join(f.repo, ".brain", "project.json");
    writeFileSync(manifest, JSON.stringify({ project_id: "moved", name: "Moved", repositories: [other] }));

    // Without the flag, the manifest is left exactly as it was: a conflict, not an overwrite.
    assert.throws(
      () => initializeDogfoodProject({ cwd: f.repo, projectId: "moved", name: "Moved" }),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "PROJECT_INIT_CONFLICT" && /--rebind/.test(error.message),
      "the refusal must name the flag that would do it deliberately",
    );
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).repositories[0], other, "and nothing was rewritten");

    // With it, the project keeps its identity and follows the operator to this checkout.
    const rebound = initializeDogfoodProject({ cwd: f.repo, projectId: "moved", name: "Moved", rebind: true });
    assert.equal(rebound.created, false);
    assert.equal(rebound.projectId, "moved");
    const document = JSON.parse(readFileSync(manifest, "utf8"));
    // Absolute, so it names the directory the operator was in rather than inferring the repository
    // from where the file sits. A workspace can be a subdirectory, and `..` could not say so.
    assert.deepEqual(document.repositories, [realpathSync.native(f.repo)], "the manifest names this workspace");
    const registry = new ProjectRegistry(join(f.root, "rebind-home"));
    assert.equal(registry.loadFile(manifest).repositories[0], realpathSync.native(f.repo));
    // And the move is not visible to git, which is the property the local ignore exists for.
    assert.equal(git(f.repo, ["status", "--porcelain"]), "");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
