import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ProjectRegistry, parseProjectId, type RegisteredProject, type TaskClassification } from "@braingate/core";
import { DogfoodStore, emptyDogfoodPrior } from "./index.js";

function registered(label: string): RegisteredProject {
  const root = mkdtempSync(join(tmpdir(), `braingate-migration-${label}-`));
  const repository = join(root, "repo");
  mkdirSync(repository);
  return new ProjectRegistry(join(root, "home")).register({ projectId: parseProjectId(label), name: label, repositories: [repository] });
}

function classification(): TaskClassification {
  return Object.freeze({ complexity: "T1", risk: "low", confidence: 0.8, requiresScout: false, reasons: Object.freeze(["test"]), sensitiveDomains: Object.freeze([]), ruleVersion: "test-rule" });
}

/**
 * A corpus as the previous release wrote it: four outcomes, no failure kind, no reconciled flag.
 *
 * Authored here rather than imported, because the point of the test is what the *old* schema looked
 * like on disk. A fixture that tracked the current code could not fail.
 */
function writeLegacyCorpus(project: RegisteredProject): { readonly firstSequence: number; readonly secondSequence: number } {
  mkdirSync(project.storageDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(project.storageDir, "dogfood.sqlite"));
  db.exec(`
    CREATE TABLE dogfood_meta (project_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE dogfood_runs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('ask','write')),
      predicted_complexity TEXT NOT NULL CHECK (predicted_complexity IN ('T0','T1','T2','T3','T4')),
      predicted_risk TEXT NOT NULL CHECK (predicted_risk IN ('low','medium','high','critical')),
      effective_complexity TEXT NOT NULL CHECK (effective_complexity IN ('T0','T1','T2','T3','T4')),
      effective_risk TEXT NOT NULL CHECK (effective_risk IN ('low','medium','high','critical')),
      rule_version TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('success','partial','blocked','failed')),
      reviewer_verdict TEXT NULL CHECK (reviewer_verdict IS NULL OR reviewer_verdict IN ('approve','request_changes','disagree')),
      usage_json TEXT NOT NULL,
      prior_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE dogfood_feedback (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      actual_complexity TEXT NOT NULL CHECK (actual_complexity IN ('T0','T1','T2','T3','T4')),
      actual_risk TEXT NULL CHECK (actual_risk IS NULL OR actual_risk IN ('low','medium','high','critical')),
      outcome TEXT NOT NULL CHECK (outcome IN ('success','partial','blocked','failed')),
      regression INTEGER NOT NULL CHECK (regression IN (0,1)),
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES dogfood_runs(task_id)
    );
    CREATE TRIGGER dogfood_runs_no_update BEFORE UPDATE ON dogfood_runs BEGIN SELECT RAISE(ABORT, 'dogfood_runs are append-only'); END;
    CREATE TRIGGER dogfood_runs_no_delete BEFORE DELETE ON dogfood_runs BEGIN SELECT RAISE(ABORT, 'dogfood_runs are append-only'); END;
    CREATE TRIGGER dogfood_feedback_no_update BEFORE UPDATE ON dogfood_feedback BEGIN SELECT RAISE(ABORT, 'dogfood_feedback is append-only'); END;
    CREATE TRIGGER dogfood_feedback_no_delete BEFORE DELETE ON dogfood_feedback BEGIN SELECT RAISE(ABORT, 'dogfood_feedback is append-only'); END;
    CREATE TRIGGER dogfood_meta_no_update BEFORE UPDATE ON dogfood_meta BEGIN SELECT RAISE(ABORT, 'dogfood_meta is immutable'); END;
    CREATE TRIGGER dogfood_meta_no_delete BEFORE DELETE ON dogfood_meta BEGIN SELECT RAISE(ABORT, 'dogfood_meta is immutable'); END;
  `);
  db.prepare("INSERT INTO dogfood_meta (project_id, schema_version, created_at) VALUES (?, 1, ?)").run(project.projectId, "2026-09-01T00:00:00.000Z");
  const insert = db.prepare(`INSERT INTO dogfood_runs (project_id, task_id, mode, predicted_complexity, predicted_risk, effective_complexity, effective_risk, rule_version, roles_json, outcome, reviewer_verdict, usage_json, prior_json, observed_at)
    VALUES (?, ?, 'ask', 'T1', 'low', 'T1', 'low', 'v1', '[]', ?, NULL, '[]', ?, ?)`);
  // Sequences 7 and 8, deliberately not starting at one: a migration that renumbers rows would
  // still pass a test that only checked the count.
  db.exec("INSERT INTO dogfood_runs (project_id, task_id, mode, predicted_complexity, predicted_risk, effective_complexity, effective_risk, rule_version, roles_json, outcome, reviewer_verdict, usage_json, prior_json, observed_at) VALUES ('" + project.projectId + "', 'old-1', 'ask', 'T1', 'low', 'T1', 'low', 'v1', '[]', 'success', NULL, '[]', '{}', '2026-09-01T00:00:00.000Z')");
  insert.run(project.projectId, "old-2", "failed", JSON.stringify(emptyDogfoodPrior("ask")), "2026-09-02T00:00:00.000Z");
  db.prepare("INSERT INTO dogfood_feedback (project_id, task_id, actual_complexity, actual_risk, outcome, regression, recorded_at) VALUES (?, 'old-1', 'T2', 'medium', 'success', 1, ?)").run(project.projectId, "2026-09-03T00:00:00.000Z");
  const sequences = db.prepare("SELECT task_id, sequence FROM dogfood_runs ORDER BY sequence").all() as { task_id: string; sequence: number }[];
  db.close();
  return { firstSequence: sequences[0]!.sequence, secondSequence: sequences[1]!.sequence };
}

test("a corpus written by the previous release is widened in place, keeping its sequence values", () => {
  const project = registered("migrate");
  const before = writeLegacyCorpus(project);

  const store = new DogfoodStore(project);
  try {
    const runs = store.listRuns();
    assert.equal(runs.length, 2);
    // The sequence is how a reader orders the corpus. Renumbering it would rewrite history.
    assert.equal(runs[0]!.sequence, before.firstSequence);
    assert.equal(runs[1]!.sequence, before.secondSequence);
    assert.equal(runs[0]!.taskId, "old-1");
    assert.equal(runs[1]!.taskId, "old-2");
    // A row written before these columns existed says so, rather than guessing.
    assert.equal(runs[0]!.failureKind, null);
    assert.equal(runs[0]!.reconciled, false);

    // The feedback row still resolves through the foreign key it was written with.
    assert.equal(store.latestFeedback().length, 1);
    assert.equal(store.report().regressions, 1);

    // The new vocabulary is accepted, and the vocabulary the feedback table never needed is not.
    store.recordObservation({
      taskId: "new-1", mode: "ask", predicted: classification(), effective: classification(), roles: [],
      outcome: "interrupted", failureKind: "interrupted", prior: null, reconciled: true, receipt: null, reviewerVerdict: null,
    });
    assert.equal(store.requireRun("new-1").outcome, "interrupted");
    assert.equal(store.requireRun("new-1").reconciled, true);
  } finally { store.close(); }

  // The database reports the version the code expects, and opening it again is a no-op.
  const probe = new Database(join(project.storageDir, "dogfood.sqlite"), { readonly: true });
  const version = probe.pragma("user_version", { simple: true }) as number;
  const violations = probe.pragma("foreign_key_check") as unknown[];
  const triggers = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string }[];
  probe.close();
  assert.equal(version, 2);
  assert.deepEqual(violations, []);
  assert.deepEqual(triggers.map((row) => row.name), [
    "dogfood_feedback_no_delete", "dogfood_feedback_no_update",
    "dogfood_meta_no_delete", "dogfood_meta_no_update",
    "dogfood_runs_no_delete", "dogfood_runs_no_update",
  ]);

  const reopened = new DogfoodStore(project);
  try {
    assert.equal(reopened.listRuns().length, 3);
    assert.equal(reopened.listRuns()[0]!.sequence, before.firstSequence);
  } finally { reopened.close(); }
});

test("the corpus still refuses to lose a row it has already written", () => {
  const project = registered("append-only");
  writeLegacyCorpus(project);
  const store = new DogfoodStore(project);
  try {
    const db = new Database(join(project.storageDir, "dogfood.sqlite"));
    try {
      assert.throws(() => db.prepare("UPDATE dogfood_runs SET outcome = 'failed' WHERE task_id = 'old-1'").run(), /append-only/);
      assert.throws(() => db.prepare("DELETE FROM dogfood_runs WHERE task_id = 'old-1'").run(), /append-only/);
    } finally { db.close(); }
  } finally { store.close(); }
});

test("a reconciled run is kept apart from a live one, and never feeds a prior", () => {
  const project = registered("reconciled");
  const store = new DogfoodStore(project);
  try {
    const record = (taskId: string, reconciled: boolean, outcome: "success" | "unknown") => store.recordObservation({
      taskId, mode: "ask", predicted: classification(), effective: classification(), roles: [],
      outcome, failureKind: outcome === "unknown" ? "interrupted" : null, prior: null, reconciled,
      receipt: null, reviewerVerdict: null,
    });
    for (let index = 0; index < 4; index += 1) record(`live-${String(index)}`, false, "success");
    record("repaired", true, "unknown");

    const report = store.report();
    assert.equal(report.runs, 5, "every row is in the corpus");
    assert.equal(report.observedRuns, 4);
    assert.equal(report.reconciledRuns, 1);
    assert.equal(report.outcomes.success, 4);
    assert.equal(report.outcomes.unknown, 0, "a repaired run must not be counted among the live ones");
    assert.equal(report.reconciledOutcomes.unknown, 1);
    // A prior is a claim about what the classifier did during a live run. A repaired record's
    // classification is an inference, so it must not move the next task's routing.
    assert.equal(store.derivePrior("ask").sampleSize, 0);

    // Recording the same observation twice is idempotent; a different one for the same task is a
    // conflict rather than an overwrite.
    const again = record("live-0", false, "success");
    assert.equal(again.sequence, store.requireRun("live-0").sequence);
    assert.throws(() => record("live-0", false, "unknown"), /already has a different observation/);
  } finally { store.close(); }
});
