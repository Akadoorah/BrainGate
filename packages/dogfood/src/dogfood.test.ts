import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { ProjectRegistry, TaskLedger, type RegisteredProject, type TaskClassification, type TaskComplexity, type TaskRisk } from "@braingate/core";
import { applyDogfoodPrior, DogfoodStore, initializeDogfoodProject } from "./index.js";

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
  return store.recordRun({
    receipt: receipt(project, complexity, risk),
    mode: "ask",
    predicted,
    effective: predicted,
    roles: [{ role: "primary", providerId: "anthropic", modelId: "test-model" }],
    outcome: "success",
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
  assert.deepEqual(manifest.repositories, [".."]);
  const second = initializeDogfoodProject({ cwd: repo, projectId: "waslo", name: "Waslo" });
  assert.equal(second.created, false);
  assert.throws(() => initializeDogfoodProject({ cwd: repo, projectId: "other", name: "Other" }), /will not be overwritten/);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
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
