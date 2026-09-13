import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  BrainGateInvariantError,
  ProjectRegistry,
  TaskLedger,
  parseProjectConfig,
  type ExecutionProject,
  type RegisteredProject,
  executionScopeFor,
} from "./index.js";

/**
 * Execution state is workspace-scoped: the fixture's own directory is a workspace like any other.
 * A test that builds a project through this registry is asking for that directory's execution state,
 * which is exactly what `executionScopeFor` resolves for a real command.
 */
function workspace(project: RegisteredProject): ExecutionProject {
  return executionScopeFor(project, project.repositories[0]!).project;
}


function setupTwoProjects() {
  const root = mkdtempSync(join(tmpdir(), "braingate-ledger-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  mkdirSync(repoA);
  mkdirSync(repoB);
  const registry = new ProjectRegistry(join(root, "state"));
  const a = workspace(registry.register(parseProjectConfig({ project_id: "waslo", name: "Waslo", repositories: [repoA] })));
  const b = workspace(registry.register(parseProjectConfig({ project_id: "tabaq", name: "Tabaq", repositories: [repoB] })));
  return { a, b };
}

test("task ledgers are physically and logically isolated by project", () => {
  const { a, b } = setupTwoProjects();
  const ledgerA = new TaskLedger(a);
  const ledgerB = new TaskLedger(b);
  try {
    const taskA = ledgerA.createTask({ title: "Fix Waslo auth", complexity: "T2", risk: "medium" });
    const taskB = ledgerB.createTask({ title: "Fix Tabaq sync", complexity: "T2", risk: "medium" });

    assert.notEqual(ledgerA.databasePath, ledgerB.databasePath);
    assert.equal(ledgerA.getTask(taskA.taskId)?.projectId, "waslo");
    assert.equal(ledgerB.getTask(taskB.taskId)?.projectId, "tabaq");
    assert.equal(ledgerA.getTask(taskB.taskId), undefined);
    assert.equal(ledgerB.getTask(taskA.taskId), undefined);
  } finally {
    ledgerA.close();
    ledgerB.close();
  }
});

test("task lifecycle rejects invalid transitions", () => {
  const { a } = setupTwoProjects();
  const ledger = new TaskLedger(a);
  try {
    const task = ledger.createTask({ title: "Small task" });
    ledger.transition(task.taskId, "running");
    ledger.transition(task.taskId, "completed");

    assert.throws(
      () => ledger.transition(task.taskId, "running"),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "TASK_TRANSITION_INVALID",
    );
  } finally {
    ledger.close();
  }
});

test("events and usage records remain append-only at the database layer", () => {
  const { a } = setupTwoProjects();
  const ledger = new TaskLedger(a);
  const task = ledger.createTask({ title: "Audit me" });
  ledger.recordUsage({
    taskId: task.taskId,
    provider: "claude",
    evidence: "native",
    metric: "quota_delta",
    value: 4,
    unit: "percent",
  });
  ledger.close();

  const db = new Database(join(a.storageDir, "tasks.sqlite"));
  try {
    assert.throws(() => db.prepare("UPDATE task_events SET kind = 'tampered'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM usage_records").run(), /append-only/);
    assert.throws(() => db.prepare("UPDATE tasks SET project_id = 'other'").run(), /immutable/);
  } finally {
    db.close();
  }
});

test("receipt is ordered and records usage evidence explicitly", () => {
  const { a } = setupTwoProjects();
  const ledger = new TaskLedger(a);
  try {
    const task = ledger.createTask({
      title: "Receipt test",
      intent: "debugging",
      complexity: "T3",
      risk: "high",
      route: { primary: "claude" },
      memoryProposalRefs: ["proposal-1"],
    });
    ledger.transition(task.taskId, "planned", { reason: "needs repository scan" });
    ledger.transition(task.taskId, "running");
    ledger.appendEvent(task.taskId, "tests.started", { suite: "auth" });
    ledger.recordUsage({
      taskId: task.taskId,
      provider: "codex",
      model: "reviewer",
      evidence: "unknown",
      metric: "allowance_delta",
    });

    const receipt = ledger.receipt(task.taskId);
    assert.deepEqual(receipt.events.map((event) => event.kind), [
      "task.created",
      "task.transition",
      "task.transition",
      "tests.started",
    ]);
    assert.equal(receipt.usage[0]?.evidence, "unknown");
    assert.deepEqual(receipt.task.memoryProposalRefs, ["proposal-1"]);
  } finally {
    ledger.close();
  }
});
