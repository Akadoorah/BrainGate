import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as activeRuns from "./active-run.js";
import {
  InMemoryObservationWriter,
  ProjectRegistry,
  ResultStore,
  STALE_CALL_MULTIPLIER,
  TaskLedger,
  finalizeTask,
  finalizedSnapshotOf,
  inspectReconciliation,
  parseProjectId,
  reconcile,
  type FinalizationDeps,
  type FinalizationPlan,
  type ReconciliationDeps,
  type RegisteredProject,
  type TaskOutcome,
} from "./index.js";

/**
 * A project with a ledger, a result directory and a corpus, all in a temporary directory.
 *
 * The three destinations are the reason this file exists: finalization spans them, and the point
 * of the exercise is what survives a process dying between one of them and the next.
 */
function fixture(label: string): { project: RegisteredProject; ledger: TaskLedger; results: ResultStore; observations: InMemoryObservationWriter; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), `braingate-finalization-${label}-`));
  const repository = join(root, "repo");
  mkdirSync(repository);
  const registry = new ProjectRegistry(join(root, "home"));
  const project = registry.register({ projectId: parseProjectId(label), name: label, repositories: [repository] });
  const ledger = new TaskLedger(project);
  return {
    project,
    ledger,
    results: new ResultStore(project.storageDir, { redact: (value) => value.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED]") }),
    observations: new InMemoryObservationWriter(),
    close: () => { ledger.close(); },
  };
}

function depsFor(f: ReturnType<typeof fixture>, now: () => Date): FinalizationDeps & { readonly staleAfterMs: number } {
  return Object.freeze({
    ledger: f.ledger,
    results: f.results,
    observations: f.observations,
    now,
    staleAfterMs: STALE_CALL_MULTIPLIER * 20 * 60_000,
  });
}

function plan(taskId: string, projectId: string, overrides: Partial<FinalizationPlan> = {}): FinalizationPlan {
  const classification = Object.freeze({ complexity: "T1" as const, risk: "low" as const, ruleVersion: "test-rule" });
  return Object.freeze({
    taskId,
    projectId,
    mode: "ask",
    outcome: "SUCCESS",
    reviewStatus: "NOT_RUN",
    failureKind: null,
    basis: Object.freeze(["workflow.receipt"]),
    result: Object.freeze({ kind: "answer", text: "the answer", evidence: "redacted" }),
    observation: Object.freeze({ predicted: classification, effective: classification, roles: Object.freeze([]), prior: null }),
    reconciled: false,
    ledgerState: "completed",
    ...overrides,
  });
}

/** A task that has run and is waiting to be recorded. */
function runningTask(f: ReturnType<typeof fixture>): string {
  const task = f.ledger.createTask({ title: "Inspect the theme", complexity: "T1", risk: "low" });
  f.ledger.transition(task.taskId, "running", { test: true });
  return task.taskId;
}

function eventKinds(f: ReturnType<typeof fixture>, taskId: string): readonly string[] {
  return f.ledger.receipt(taskId).events.map((event) => event.kind);
}

test("finalization writes the record once, in an order a crash can survive, and is idempotent", () => {
  const f = fixture("finalize-once");
  try {
    const taskId = runningTask(f);
    const planFor = plan(taskId, f.project.projectId);
    const first = finalizeTask(depsFor(f, () => new Date()), planFor);
    assert.deepEqual(first.conflicts, []);
    assert.equal(first.alreadyFinalized, false);

    const kinds = eventKinds(f, taskId);
    // The result file is written before the event that claims it, and the observation before the
    // marker that says the record is complete.
    assert.ok(kinds.indexOf("task.result") < kinds.indexOf("task.finalized"), "the claim must follow the artifact");
    assert.ok(kinds.includes("task.finalized"));
    assert.equal(f.observations.list().length, 1);
    assert.equal(f.ledger.requireTask(taskId).state, "completed");

    const second = finalizeTask(depsFor(f, () => new Date()), planFor);
    assert.equal(second.alreadyFinalized, true);
    assert.equal(eventKinds(f, taskId).filter((kind) => kind === "task.finalized").length, 1, "a second finalize must not write a second marker");
    assert.equal(f.observations.list().length, 1);
  } finally { f.close(); }
});

test("a crash at any point in the record leaves a task the reconciler finishes, to the same outcome", () => {
  const f = fixture("crash-prefix");
  try {
    const full = fixture("crash-prefix-full");
    try {
      // What a complete run produces, for comparison.
      const reference = runningTask(full);
      finalizeTask(depsFor(full, () => new Date()), plan(reference, full.project.projectId));

      for (const prefix of ["nothing", "result-file", "result-event", "observation", "marker"] as const) {
        const taskId = runningTask(f);
        const planFor = plan(taskId, f.project.projectId);
        if (prefix === "result-file" || prefix === "result-event" || prefix === "observation" || prefix === "marker") {
          const stored = f.results.persist(taskId, { kind: "answer", text: "the answer" });
          if (prefix !== "result-file") {
            f.ledger.appendEvent(taskId, "task.result", Object.freeze({ schemaVersion: 1, kind: stored.kind, relativePath: stored.relativePath, sha256: stored.sha256, bytes: stored.bytes }));
          }
          if (prefix === "observation" || prefix === "marker") {
            f.observations.record({ taskId, mode: "ask", predicted: planFor.observation.predicted, effective: planFor.observation.effective, roles: planFor.observation.roles, outcome: "success", failureKind: null, prior: null, reconciled: false });
          }
          if (prefix === "marker") {
            f.ledger.appendEvent(taskId, "task.finalized", Object.freeze({ schemaVersion: 1, snapshot: { outcome: "SUCCESS", reviewStatus: "NOT_RUN", ledgerState: "completed", failureKind: null, basis: ["workflow.receipt"], reconciled: false }, basis: ["workflow.receipt"] }));
          }
        }

        // A run that recorded nothing at all is only provably over once it is silent past the
        // bound; everything else is durability evidence and is repaired at once.
        // A minute past the bound, so the assertion is about the bound rather than about how
        // many milliseconds the test itself took to get here.
        const now = prefix === "nothing" ? () => new Date(Date.now() + STALE_CALL_MULTIPLIER * 20 * 60_000 + 60_000) : () => new Date();
        const report = reconcile(f.project, depsFor(f, now), now());
        assert.ok(report.reconciled.includes(taskId), `prefix ${prefix} should have been reconciled`);
        assert.equal(inspectReconciliation(depsFor(f, now), now()).required, 0, `prefix ${prefix} should be complete afterwards`);

        const receipt = f.ledger.receipt(taskId);
        const snapshot = finalizedSnapshotOf(receipt.events);
        assert.notEqual(snapshot, null);
        // The outcome depends on what the crash left behind, and it must not claim more than the
        // evidence supports. A marker is the only prefix that says how the work went, and it is
        // adopted rather than re-derived — otherwise a task could end up with a marker saying
        // SUCCESS and a transition saying something else. Every other prefix says only that the run
        // stopped before it finished recording, which is what INTERRUPTED means.
        assert.equal(snapshot!.outcome, prefix === "marker" ? "SUCCESS" : "INTERRUPTED", `prefix ${prefix}`);
        assert.ok(receipt.events.some((event) => event.kind === "task.result"), `prefix ${prefix} must end with a result claim`);
        assert.notEqual(f.observations.find(taskId), null);
        assert.ok(receipt.task.state === "completed" || receipt.task.state === "failed");
        assert.equal(receipt.task.state, snapshot!.ledgerState ?? receipt.task.state);
      }
    } finally { full.close(); }
  } finally { f.close(); }
});

test("a legacy task that recorded nothing is repaired as UNKNOWN, visibly, and never counted twice", () => {
  const f = fixture("legacy-unknown");
  try {
    // What an older BrainGate left behind: a terminal task with no result, no observation and no
    // marker. It must not stay unrecorded, and it must not be shown as a success either.
    const task = f.ledger.createTask({ title: "Old task", complexity: "T2", risk: "medium" });
    f.ledger.transition(task.taskId, "running", {});
    f.ledger.transition(task.taskId, "completed", {});

    const now = () => new Date();
    const report = reconcile(f.project, depsFor(f, now), now());
    assert.ok(report.reconciled.includes(task.taskId));

    const snapshot = finalizedSnapshotOf(f.ledger.receipt(task.taskId).events);
    assert.equal(snapshot?.outcome, "UNKNOWN");
    assert.equal(snapshot?.reconciled, true, "a repaired record must say that it was repaired");
    const observation = f.observations.find(task.taskId);
    assert.equal(observation?.outcome, "unknown");
    assert.equal(observation?.reconciled, true);

    // Reconciling again is a no-op: the same evidence derives the same outcome, so there is
    // nothing left to do and no second row to add.
    const again = reconcile(f.project, depsFor(f, now), now());
    assert.equal(again.required, 0);
    assert.equal(again.reconciled.length, 0);
    assert.equal(f.observations.list().length, 1);
  } finally { f.close(); }
});

test("inspecting for reconciliation changes nothing", () => {
  const f = fixture("read-only");
  try {
    const taskId = runningTask(f);
    const now = () => new Date(Date.now() + STALE_CALL_MULTIPLIER * 20 * 60_000 + 60_000);
    const before = f.ledger.receipt(taskId).events.length;
    const inspection = inspectReconciliation(depsFor(f, now), now());
    assert.equal(inspection.required, 1);
    assert.equal(f.ledger.receipt(taskId).events.length, before, "a read must not append");
    assert.equal(f.observations.list().length, 0);
    assert.equal(f.ledger.requireTask(taskId).state, "running");
  } finally { f.close(); }
});

test("the result file is content-addressed, redacted before it is hashed, and a torn file is never adopted", () => {
  const f = fixture("result-store");
  try {
    const taskId = runningTask(f);
    const secret = `token sk-${"a".repeat(24)} end`;
    const stored = f.results.persist(taskId, { kind: "answer", text: secret });

    const onDisk = readFileSync(f.results.absolutePath(stored.relativePath), "utf8");
    assert.doesNotMatch(onDisk, /sk-aaaaaaaa/);
    assert.equal(stored.sha256, stored.originalSha256);

    // The same content persists to the same name and is verified rather than overwritten. This is
    // the retry path after a crash between the write and the record.
    const again = f.results.persist(taskId, { kind: "answer", text: secret });
    assert.equal(again.relativePath, stored.relativePath);
    assert.equal(readdirSync(join(f.project.storageDir, "results", taskId)).length, 1);

    // A file that no longer matches the hash in its name is reported, not read as the answer.
    const absolute = f.results.absolutePath(stored.relativePath);
    writeFileSync(absolute, "tampered");
    const located = f.results.locate(taskId);
    assert.deepEqual(located.torn, [stored.relativePath]);
    assert.equal(located.valid.length, 0);
    assert.throws(() => f.results.persist(taskId, { kind: "answer", text: secret }), /does not match the content its name claims/);
  } finally { f.close(); }
});

test("a result file written before the crash is adopted without a new marker", () => {
  const f = fixture("orphan");
  try {
    const taskId = runningTask(f);
    // The exact crash the design has to survive: the file exists, and nothing recorded it. There
    // is no marker to discover it by — the name is the discovery, and the hash is the proof.
    const stored = f.results.persist(taskId, { kind: "answer", text: "written but unreported" });
    const now = () => new Date(Date.now() + STALE_CALL_MULTIPLIER * 20 * 60_000 + 60_000);
    const report = reconcile(f.project, depsFor(f, now), now());
    assert.ok(report.reconciled.includes(taskId));

    const receipt = f.ledger.receipt(taskId);
    const claim = receipt.events.find((event) => event.kind === "task.result");
    assert.equal((claim?.payload as { readonly relativePath?: string } | undefined)?.relativePath, stored.relativePath);
    assert.equal(finalizedSnapshotOf(receipt.events)?.outcome, "INTERRUPTED", "a repaired task is reported as interrupted, not as a success nobody observed");
  } finally { f.close(); }
});

test("a failure is never recorded as a success, and its kind is carried through", () => {
  const f = fixture("failure-kind");
  try {
    const taskId = runningTask(f);
    const outcome: TaskOutcome = "FAILED";
    const record = finalizeTask(depsFor(f, () => new Date()), plan(taskId, f.project.projectId, {
      outcome,
      failureKind: "provider-failed",
      basis: Object.freeze(["failure:provider-failed"]),
      result: Object.freeze({ kind: "none", text: null, evidence: "lost-to-crash" }),
      ledgerState: "failed",
    }));
    assert.equal(record.outcome, "FAILED");
    const snapshot = finalizedSnapshotOf(f.ledger.receipt(taskId).events);
    assert.equal(snapshot?.outcome, "FAILED");
    assert.equal(snapshot?.failureKind, "provider-failed");
    assert.equal(f.observations.find(taskId)?.outcome, "failed");
    assert.equal(f.ledger.requireTask(taskId).state, "failed");
    assert.equal(existsSync(join(f.project.storageDir, "results", taskId)), false, "a failure writes no result file");
  } finally { f.close(); }
});

test("a marker that disagrees with the evidence is reported as a conflict, not silently believed", () => {
  const f = fixture("conflict");
  try {
    const taskId = runningTask(f);
    const planFor = plan(taskId, f.project.projectId);
    finalizeTask(depsFor(f, () => new Date()), planFor);
    // The same task, finalized again with a different outcome: the store cannot update, so the
    // disagreement has to surface somewhere, and it must not overwrite the first record.
    const conflicting = finalizeTask(depsFor(f, () => new Date()), plan(taskId, f.project.projectId, { outcome: "FAILED", failureKind: "timeout", ledgerState: "failed" }));
    assert.ok(conflicting.conflicts.length > 0, "a conflicting finalize must report a conflict");
    assert.equal(finalizedSnapshotOf(f.ledger.receipt(taskId).events)?.outcome, "SUCCESS");
    assert.equal(f.observations.find(taskId)?.outcome, "success");
  } finally { f.close(); }
});

test("the stale bound is derived from the provider ceiling, not authored", () => {
  const f = fixture("stale-bound");
  try {
    const taskId = runningTask(f);
    const justInside = new Date(Date.now() + STALE_CALL_MULTIPLIER * 20 * 60_000 - 60_000);
    const deps: ReconciliationDeps = depsFor(f, () => justInside);
    assert.equal(inspectReconciliation(deps, justInside).required, 0, "a run that could still be working is left alone");
    const justPast = new Date(Date.now() + STALE_CALL_MULTIPLIER * 20 * 60_000 + 60_000);
    assert.equal(inspectReconciliation(depsFor(f, () => justPast), justPast).required, 1);
    assert.equal(f.ledger.requireTask(taskId).state, "running");
  } finally { f.close(); }
});

test("a termination signal reaches the run that is still working, and the task ends INTERRUPTED", () => {
  const f = fixture("signal");
  try {
    const taskId = runningTask(f);
    // What a runner registers when it starts: a handler that writes the record it can still write.
    // Without it a signal leaves the task `running` forever, which is exactly what happened to a
    // real task that sat abandoned for thirty-three hours.
    const { registerActiveRun, activeRunCount, abortActiveRuns } = activeRuns;
    assert.equal(activeRunCount(), 0);
    const unregister = registerActiveRun((signal) => {
      assert.equal(signal, "SIGINT");
      finalizeTask(depsFor(f, () => new Date()), plan(taskId, f.project.projectId, {
        outcome: "INTERRUPTED",
        failureKind: "interrupted",
        basis: Object.freeze(["failure:interrupted"]),
        result: Object.freeze({ kind: "none", text: null, evidence: "lost-to-crash" }),
        ledgerState: "failed",
      }));
    });
    assert.equal(activeRunCount(), 1);
    abortActiveRuns("SIGINT");

    const snapshot = finalizedSnapshotOf(f.ledger.receipt(taskId).events);
    assert.equal(snapshot?.outcome, "INTERRUPTED");
    assert.equal(snapshot?.failureKind, "interrupted");
    assert.equal(f.ledger.requireTask(taskId).state, "failed");
    unregister();
    assert.equal(activeRunCount(), 0);
  } finally { f.close(); }
});
