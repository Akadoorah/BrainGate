import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ProjectRegistry, type RegisteredProject } from "./project-registry.js";
import { TaskLedger } from "./task-ledger.js";

/**
 * M20 adds two nullable columns to `tasks`, on a database that has existed since M0.
 *
 * This is the one change in the milestone that could destroy history, so it is tested against a
 * table built by the *previous* schema rather than against a fresh one — a fresh database exercises
 * the `CREATE TABLE` path, which is the path that was never at risk.
 */

function project(label: string): RegisteredProject {
  const root = mkdtempSync(join(tmpdir(), `braingate-ledger-m20-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  return new ProjectRegistry(join(root, "brain-home")).register({ projectId: label as never, name: label, repositories: [repo] });
}

/** The `tasks` table as it was written before the goal link existed. */
function legacyDatabase(target: RegisteredProject, rows: readonly { readonly taskId: string; readonly title: string }[]): void {
  mkdirSync(target.storageDir, { recursive: true });
  const db = new Database(join(target.storageDir, "tasks.sqlite"));
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('created', 'planned', 'running', 'verifying', 'completed', 'failed', 'cancelled')),
      intent TEXT,
      complexity TEXT CHECK (complexity IS NULL OR complexity IN ('T0', 'T1', 'T2', 'T3', 'T4')),
      risk TEXT CHECK (risk IS NULL OR risk IN ('low', 'medium', 'high', 'critical')),
      route_json TEXT,
      memory_proposal_refs_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, project_id)
    );
  `);
  for (const row of rows) {
    db.prepare("INSERT INTO tasks (task_id, project_id, title, state, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)")
      .run(row.taskId, target.projectId, row.title, "2026-09-01T00:00:00.000Z", "2026-09-01T00:01:00.000Z");
  }
  db.close();
}

test("a ledger written before M20 keeps every task, and reads the new link as absent", () => {
  const target = project("legacy");
  legacyDatabase(target, [{ taskId: "11111111-1111-4111-8111-111111111111", title: "an old task" }]);

  const ledger = new TaskLedger(target);
  try {
    const tasks = ledger.listTasks();
    assert.equal(tasks.length, 1, "the migration must not drop the task it was run for");
    assert.equal(tasks[0]?.title, "an old task");
    assert.equal(tasks[0]?.state, "completed");
    // Null is the honest reading, and it is not the same as "belongs to no goal id" being unknown.
    assert.equal(tasks[0]?.goalId, null);
    assert.equal(tasks[0]?.conversationId, null);
    const receipt = ledger.receipt("11111111-1111-4111-8111-111111111111");
    assert.equal(receipt.events.length, 0);
  } finally { ledger.close(); }
});

test("the migration is idempotent, so opening the same ledger twice is not a second migration", () => {
  const target = project("idempotent");
  legacyDatabase(target, [{ taskId: "22222222-2222-4222-8222-222222222222", title: "old" }]);
  const first = new TaskLedger(target);
  first.close();
  const second = new TaskLedger(target);
  const third = new TaskLedger(target);
  try {
    assert.equal(third.listTasks().length, 1);
    const columns = (new Database(join(target.storageDir, "tasks.sqlite"), { readonly: true })
      .pragma("table_info(tasks)") as readonly { readonly name: string }[]).map((column) => column.name);
    assert.equal(columns.filter((name) => name === "goal_id").length, 1);
    assert.equal(columns.filter((name) => name === "conversation_id").length, 1);
  } finally { third.close(); second.close(); }
});

test("a new task records the goal it is a work unit of, and a goal lists its own work units", () => {
  const target = project("linkage");
  const ledger = new TaskLedger(target);
  try {
    const first = ledger.createTask({ title: "diagnose", complexity: "T3", risk: "medium", goalId: "goal-a", conversationId: "conversation-1" });
    const second = ledger.createTask({ title: "implement", complexity: "T3", risk: "medium", goalId: "goal-a", conversationId: "conversation-1" });
    ledger.createTask({ title: "something unrelated", complexity: "T1", risk: "low" });

    assert.equal(first.goalId, "goal-a");
    assert.equal(first.conversationId, "conversation-1");
    assert.equal(ledger.requireTask(first.taskId).goalId, "goal-a");
    const underGoal = ledger.listTasksForGoal("goal-a");
    assert.deepEqual(underGoal.map((task) => task.taskId), [first.taskId, second.taskId]);
    assert.deepEqual([...ledger.listTasksForGoal("goal-that-does-not-exist")], []);
    // A standalone task is not silently attached to anything.
    const standalone = ledger.listTasks().find((task) => task.title === "something unrelated");
    assert.equal(standalone?.goalId, null);
  } finally { ledger.close(); }
});

test("a goal id from another project returns nothing, because the query is project-scoped", () => {
  const a = project("scope-a");
  const b = project("scope-b");
  const ledgerA = new TaskLedger(a);
  const ledgerB = new TaskLedger(b);
  try {
    ledgerA.createTask({ title: "a's work", goalId: "shared-goal-id", conversationId: "conversation-a" });
    assert.equal(ledgerA.listTasksForGoal("shared-goal-id").length, 1);
    assert.equal(ledgerB.listTasksForGoal("shared-goal-id").length, 0);
  } finally { ledgerA.close(); ledgerB.close(); }
});
