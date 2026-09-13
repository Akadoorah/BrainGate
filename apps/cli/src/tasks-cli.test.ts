import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectRegistry,
  TaskLedger,
  finalizeTask,
  finalizedSnapshotOf,
  type FinalizationPlan,
  type ExecutionProject,
  executionScopeFor,
} from "@braingate/core";
import { DogfoodStore } from "@braingate/dogfood";
import { resolveOperatorState } from "@braingate/operator";
import { redactSecrets } from "@braingate/security";
import { ResultStore, type ObservationInput, type ObservationRecord, type ObservationWriter } from "@braingate/core";
import { runCli } from "./cli.js";
import { runTasksCli } from "./tasks-cli.js";



function fixture(): { root: string; repo: string; manifest: string; env: NodeJS.ProcessEnv; project: ExecutionProject } {
  const root = mkdtempSync(join(tmpdir(), "braingate-tasks-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const manifest = join(root, "project.json");
  writeFileSync(manifest, JSON.stringify({ project_id: "sample", name: "Sample", repositories: [repo] }));
  // The canonical location, exactly as `braingate init` lays it out, so a command that omits
  // `--project` is resolved the way an operator's own invocation is.
  mkdirSync(join(repo, ".brain"));
  writeFileSync(join(repo, ".brain", "project.json"), JSON.stringify({ project_id: "sample", name: "Sample", repositories: [".."] }));
  const env = { BRAINGATE_HOME: join(root, "brain-home") };
  const state = resolveOperatorState(env, root);
  // The ledger and the corpus belong to the workspace, so the fixture resolves what a command
  // resolves rather than handing the project handle to a store that would file state at project level.
  const project = executionScopeFor(new ProjectRegistry(state.home).loadFile(manifest), repo).project;
  return { root, repo, manifest, env, project };
}

function io(): { stdout: (value: string) => void; stderr: (value: string) => void; out: () => string; err: () => string } {
  let stdout = "";
  let stderr = "";
  return { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; }, out: () => stdout, err: () => stderr };
}

/**
 * The corpus-backed observation writer, as the CLI composes it.
 *
 * The seed has to write to the same store the reconciler reads, or a task it recorded perfectly
 * looks unobserved to the next command and gets "repaired" for no reason.
 */
function corpusWriter(store: DogfoodStore, ledger: TaskLedger): ObservationWriter {
  return {
    find: (taskId: string): ObservationRecord | null => store.find(taskId),
    record: (input: ObservationInput): ObservationRecord => store.recordObservation({ ...input, receipt: ledger.receipt(input.taskId), reviewerVerdict: null }),
  };
}

/**
 * Three tasks in the ledger: one recorded properly, one an older BrainGate left terminal with
 * nothing recorded, and one that stopped while it was still running.
 */
function seed(project: ExecutionProject): { readonly recorded: string; readonly legacy: string; readonly abandoned: string } {
  const ledger = new TaskLedger(project);
  const store = new DogfoodStore(project);
  try {
    const recorded = ledger.createTask({ title: "Answered question", complexity: "T1", risk: "low" });
    ledger.transition(recorded.taskId, "running", {});
    const classification = Object.freeze({ complexity: "T1" as const, risk: "low" as const, ruleVersion: "test-rule" });
    const plan: FinalizationPlan = Object.freeze({
      taskId: recorded.taskId,
      projectId: project.projectId,
      mode: "ask",
      outcome: "SUCCESS",
      reviewStatus: "NOT_RUN",
      failureKind: null,
      basis: Object.freeze(["workflow.receipt"]),
      result: Object.freeze({ kind: "answer", text: "the recorded answer", evidence: "redacted" }),
      observation: Object.freeze({ predicted: classification, effective: classification, roles: Object.freeze([]), prior: null }),
      reconciled: false,
      ledgerState: "completed",
    });
    finalizeTask({ ledger, results: new ResultStore(project.storageDir, { redact: redactSecrets }), observations: corpusWriter(store, ledger) }, plan);

    const legacy = ledger.createTask({ title: "Old task", complexity: "T2", risk: "medium" });
    ledger.transition(legacy.taskId, "running", {});
    ledger.transition(legacy.taskId, "completed", {});

    const abandoned = ledger.createTask({ title: "Abandoned task", complexity: "T1", risk: "low" });
    ledger.transition(abandoned.taskId, "running", {});
    return { recorded: recorded.taskId, legacy: legacy.taskId, abandoned: abandoned.taskId };
  } finally { store.close(); ledger.close(); }
}

test("tasks list shows what was recorded, and filters on it", async () => {
  const f = fixture();
  const ids = seed(f.project);
  const output = io();
  const result = await runTasksCli(["list", "--project", f.manifest], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 0);
  assert.match(output.out(), /SUCCESS/);
  assert.match(output.out(), new RegExp(ids.recorded.slice(0, 8)));
  // A terminal task with no record says so rather than appearing as a success or a failure.
  assert.match(output.out(), /not recorded/);

  const filtered = io();
  await runTasksCli(["list", "--project", f.manifest, "--outcome", "SUCCESS"], { cwd: f.repo, env: f.env, stdout: filtered.stdout, stderr: filtered.stderr });
  assert.match(filtered.out(), /SUCCESS/);
  assert.doesNotMatch(filtered.out(), /Old task/);
});

test("tasks list is newest first, bounded by --limit, and says what it left out", async () => {
  const f = fixture();
  seed(f.project);
  const output = io();
  const result = await runTasksCli(["list", "--project", f.manifest, "--limit", "1"], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 0);
  const data = result.data as { readonly shown: number; readonly matched: number };
  assert.equal(data.shown, 1);
  assert.equal(data.matched, 3);
  assert.match(output.out(), /more/);
});

test("tasks show reads the record and the stored result without invoking a provider", async () => {
  const f = fixture();
  const ids = seed(f.project);
  const output = io();
  const result = await runTasksCli(["show", ids.recorded.slice(0, 8), "--project", f.manifest, "--result"], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 0);
  assert.match(output.out(), /SUCCESS/);
  assert.match(output.out(), /the recorded answer/, "the stored result is retrievable");
  assert.match(output.out(), /workflow\.receipt/, "the basis the outcome was derived from is shown");
});

test("tasks show refuses an id it cannot resolve", async () => {
  const f = fixture();
  seed(f.project);
  const output = io();
  const result = await runTasksCli(["show", "zzzz", "--project", f.manifest], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 1);
  assert.match(output.err(), /TASK_NOT_FOUND|No task/);
});

test("tasks reconcile repairs both kinds of unfinished record and then finds nothing left", async () => {
  const f = fixture();
  const ids = seed(f.project);
  const first = io();
  const result = await runTasksCli(["reconcile", "--project", f.manifest], { cwd: f.repo, env: f.env, stdout: first.stdout, stderr: first.stderr });
  assert.equal(result.exitCode, 0);
  const report = result.data as { readonly reconciled: readonly string[] };
  // The abandoned task is not stale yet, so only the legacy terminal one is repaired: a run that
  // could still be working is left alone, and the task that was recorded properly has nothing
  // missing to complete.
  assert.deepEqual([...report.reconciled], [ids.legacy]);

  const second = io();
  await runTasksCli(["reconcile", "--project", f.manifest], { cwd: f.repo, env: f.env, stdout: second.stdout, stderr: second.stderr });
  assert.match(second.out(), /Nothing to reconcile/);

  // The repaired record says UNKNOWN and says it was repaired, in both stores.
  const ledger = new TaskLedger(f.project);
  try {
    const snapshot = finalizedSnapshotOf(ledger.receipt(ids.legacy).events);
    assert.equal(snapshot?.outcome, "UNKNOWN");
    assert.equal(snapshot?.reconciled, true);
    const stored = new DogfoodStore(f.project);
    try {
      assert.equal(stored.find(ids.legacy)?.outcome, "unknown");
      assert.equal(stored.find(ids.legacy)?.reconciled, true);
      // The live run that finished cleanly is untouched and still counted among the observed runs.
      assert.equal(stored.find(ids.recorded)?.outcome, "success");
      assert.equal(stored.report().reconciledRuns, 1);
    } finally { stored.close(); }
  } finally { ledger.close(); }
});

test("listing never writes to the ledger or the corpus", async () => {
  const f = fixture();
  const ids = seed(f.project);
  const countRows = (): number => {
    const ledger = new TaskLedger(f.project);
    try { return ledger.listTasks().reduce((total, task) => total + ledger.receipt(task.taskId).events.length, 0); } finally { ledger.close(); }
  };
  const before = countRows();
  const output = io();
  await runTasksCli(["list", "--project", f.manifest], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  await runTasksCli(["show", ids.legacy, "--project", f.manifest], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  assert.equal(countRows(), before, "a read-only command must not append an event");
});

// The operator asked for these commands to stay observational. A read that finds something
// unfinished must say so — silence would leave them reading a summary of tasks that are not
// actually finished being written — and must not repair it, because repairing appends events to a
// ledger someone may be reading.
test("status reports a task waiting to be reconciled without reconciling it", async () => {
  const f = fixture();
  const ids = seed(f.project);
  const output = io();
  const result = await runCli(["status", "--project", f.manifest], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 0);
  assert.match(output.out(), /Reconciliation required: 1 task\(s\)/);

  const ledger = new TaskLedger(f.project);
  try {
    assert.equal(finalizedSnapshotOf(ledger.receipt(ids.legacy).events), null, "a read must not have repaired anything");
  } finally { ledger.close(); }
});

// The defect the real validation run found: the default manifest was `.braingate/project.json`, so
// `braingate tasks list` inside a project failed with exit 1 unless `--project` was passed. Every
// test above passed `--project`, which is exactly why it survived until the command was run for real.
test("tasks resolves the project from inside the repository, without --project", async () => {
  const f = fixture();
  const ids = seed(f.project);
  mkdirSync(join(f.repo, "src"));
  // Also from a subdirectory: the manifest is found by walking up, the way git finds its root.
  for (const cwd of [f.repo, join(f.repo, "src")]) {
    const list = io();
    const listed = await runTasksCli(["list"], { cwd, env: f.env, stdout: list.stdout, stderr: list.stderr });
    assert.equal(listed.exitCode, 0, `tasks list from ${cwd} should succeed`);
    assert.equal(list.err(), "");
    assert.match(list.out(), /SUCCESS/);

    const show = io();
    const shown = await runTasksCli(["show", ids.recorded.slice(0, 8)], { cwd, env: f.env, stdout: show.stdout, stderr: show.stderr });
    assert.equal(shown.exitCode, 0);
    assert.match(show.out(), /SUCCESS/);
  }

  const reconcileOut = io();
  const reconciled = await runTasksCli(["reconcile"], { cwd: f.repo, env: f.env, stdout: reconcileOut.stdout, stderr: reconcileOut.stderr });
  assert.equal(reconciled.exitCode, 0);
  assert.match(reconcileOut.out(), /Reconciled 1 task/);
});

test("tasks show surfaces a failed provider attempt, bounded and redacted", async () => {
  const f = fixture();
  const ledger = new TaskLedger(f.project);
  const store = new DogfoodStore(f.project);
  const secret = `sk-${"a".repeat(24)}`;
  const recordedTail = `refused by the provider: ${secret}\n${"z".repeat(3_000)}`;
  let taskId = "";
  try {
    const task = ledger.createTask({ title: "A provider that refused", complexity: "T1", risk: "low" });
    taskId = task.taskId;
    ledger.transition(taskId, "running", {});
    ledger.appendEvent(taskId, "shadow.provider.failed", {
      role: "primary", phase: "initial", provider: "anthropic", model: "claude-haiku-4-5",
      quotaPool: "claude-subscription", failureKind: "provider-failed", timedOut: false, exitCode: 1,
      durationMs: 4_210, stderrTail: recordedTail, stdoutTail: `rate_limit_event status=rejected ${secret}`,
      retainedChars: 120,
    });
    // A second attempt that failed without a taxonomy kind: the writer recorded a cause phrase and no
    // exit code at all, which is a different shape from the first attempt and must not be invented into one.
    ledger.appendEvent(taskId, "shadow.provider.failed", {
      role: "primary", phase: "initial", provider: "anthropic", model: "claude-haiku-4-5",
      quotaPool: "claude-subscription", reason: "sandbox-not-applied",
    });
    const classification = Object.freeze({ complexity: "T1" as const, risk: "low" as const, ruleVersion: "test-rule" });
    const plan: FinalizationPlan = Object.freeze({
      taskId, projectId: f.project.projectId, mode: "ask", outcome: "FAILED", reviewStatus: "NOT_RUN",
      failureKind: "provider-failed", basis: Object.freeze(["failure:provider-failed"]),
      result: Object.freeze({ kind: "none", text: null, evidence: "lost-to-crash" }),
      observation: Object.freeze({
        predicted: classification, effective: classification,
        roles: Object.freeze([{ role: "primary" as const, providerId: "anthropic", modelId: "claude-haiku-4-5", quotaPool: "claude-subscription" }]),
        prior: null,
      }),
      reconciled: false, ledgerState: "failed",
    });
    finalizeTask({ ledger, results: new ResultStore(f.project.storageDir, { redact: redactSecrets }), observations: corpusWriter(store, ledger) }, plan);
  } finally { store.close(); ledger.close(); }

  const output = io();
  const result = await runTasksCli(["show", taskId], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 0);
  const printed = output.out();
  // What was attempted, by whom, and how it ended.
  assert.match(printed, /FAILED \(provider-failed\)/);
  assert.match(printed, /failure 1\/2\s+primary anthropic\/claude-haiku-4-5 · provider-failed · exit 1 · 4210ms · claude-subscription/);
  // The second attempt recorded a cause phrase instead of a kind, and no exit code. Both are shown as
  // what they are rather than as a zero or a guess.
  assert.match(printed, /failure 2\/2\s+primary anthropic\/claude-haiku-4-5 · sandbox-not-applied · no exit code recorded · claude-subscription/);
  // And what the provider said.
  assert.match(printed, /refused by the provider:/);
  assert.match(printed, /rate_limit_event status=rejected/);
  // Redacted on the way out, even though the ledger row still holds the raw tail.
  assert.doesNotMatch(printed, /sk-aaaaaaaa/);
  assert.ok(!printed.includes("z".repeat(2_500)), "the displayed tail is capped");

  const data = result.data as { readonly failures: readonly { readonly provider: string | null; readonly reason: string | null; readonly exitCode: number | null; readonly durationMs: number | null; readonly timedOut: boolean; readonly stderrTail: string | null; readonly stdoutTail: string | null }[] };
  assert.equal(data.failures.length, 2);
  const failure = data.failures[0]!;
  assert.equal(data.failures[1]!.reason, "sandbox-not-applied");
  assert.equal(data.failures[1]!.exitCode, null, "an absent exit code stays absent");
  assert.equal(failure.provider, "anthropic");
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.durationMs, 4_210);
  assert.equal(failure.timedOut, false);
  assert.ok((failure.stderrTail ?? "").length <= 2_000);
  assert.doesNotMatch(failure.stderrTail ?? "", /sk-aaaaaaaa/);
  assert.equal(failure.stdoutTail, "rate_limit_event status=rejected [REDACTED_API_TOKEN]");
});

test("a task that never failed is not given a failure section", async () => {
  const f = fixture();
  const ids = seed(f.project);
  const output = io();
  const result = await runTasksCli(["show", ids.recorded], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(output.out(), /\n  failure/);
  assert.deepEqual((result.data as { readonly failures: readonly unknown[] }).failures, []);
});

// A record and its artifact fail independently. A deleted result file must not make the task
// uninspectable — the ledger, the events, the observation and the finalization are all still there,
// and the missing artifact is a fact to report, not a reason to refuse to render anything.
test("tasks show renders a record whose result artifact was deleted, and --result says so explicitly", async () => {
  const f = fixture();
  const ids = seed(f.project);
  const ledger = new TaskLedger(f.project);
  let claim: { readonly relativePath: string; readonly sha256: string; readonly bytes: number };
  try {
    const event = ledger.receipt(ids.recorded).events.find((candidate) => candidate.kind === "task.result");
    claim = event?.payload as typeof claim;
  } finally { ledger.close(); }
  const absolute = join(f.project.storageDir, claim.relativePath);
  rmSync(absolute, { force: true });

  const ledgerMutations = (): number => {
    const l = new TaskLedger(f.project);
    try { return l.listTasks().reduce((total, task) => total + l.receipt(task.taskId).events.length, 0); } finally { l.close(); }
  };
  const before = ledgerMutations();

  // 1. The plain invocation succeeds and explains itself.
  const plain = io();
  const shown = await runTasksCli(["show", ids.recorded], { cwd: f.repo, env: f.env, stdout: plain.stdout, stderr: plain.stderr });
  assert.equal(shown.exitCode, 0, "a missing artifact is not a reason to fail an inspection");
  assert.equal(plain.err(), "");
  assert.match(plain.out(), /outcome\s+SUCCESS/, "the record still renders");
  assert.match(plain.out(), /basis\s+workflow\.receipt/);
  assert.match(plain.out(), /result\s+MISSING/);
  assert.match(plain.out(), /expected results\//, "the path it should be at is named");
  assert.ok(plain.out().includes(claim.relativePath));
  assert.ok(plain.out().includes(claim.sha256));
  assert.ok(plain.out().includes(`${String(claim.bytes)} bytes`));

  // 2. JSON carries the state rather than leaving it to be inferred.
  const jsonOut = io();
  const json = await runTasksCli(["show", ids.recorded, "--json"], { cwd: f.repo, env: f.env, stdout: jsonOut.stdout, stderr: jsonOut.stderr });
  assert.equal(json.exitCode, 0);
  const data = json.data as { readonly result: { readonly missing: boolean; readonly present: boolean; readonly relativePath: string; readonly sha256: string; readonly bytes: number; readonly files: readonly string[] } };
  assert.equal(data.result.missing, true);
  assert.equal(data.result.present, false);
  assert.equal(data.result.relativePath, claim.relativePath);
  assert.equal(data.result.sha256, claim.sha256);
  assert.equal(data.result.bytes, claim.bytes);
  assert.deepEqual(data.result.files, []);

  // 3. Asking explicitly for the bytes is a request that failed, and the reason is the artifact.
  const explicit = io();
  const requested = await runTasksCli(["show", ids.recorded, "--result"], { cwd: f.repo, env: f.env, stdout: explicit.stdout, stderr: explicit.stderr });
  assert.equal(requested.exitCode, 1);
  assert.match(explicit.err(), /RESULT_MISSING/);
  assert.match(explicit.err(), /is not on disk/);
  assert.doesNotMatch(explicit.err(), /RESULT_NOT_RECORDED/, "a lost artifact is not the same as a task that never had one");

  // 4. The other reason stays distinct: this task recorded no result at all.
  const none = io();
  const noResult = await runTasksCli(["show", ids.abandoned, "--result"], { cwd: f.repo, env: f.env, stdout: none.stdout, stderr: none.stderr });
  assert.equal(noResult.exitCode, 1);
  assert.match(none.err(), /RESULT_NOT_RECORDED/);
  assert.doesNotMatch(none.err(), /RESULT_MISSING/);

  // 5. None of that wrote anything.
  assert.equal(ledgerMutations(), before, "inspecting must not append an event");
  assert.equal(existsSync(absolute), false, "and must not conjure the artifact back");
});
