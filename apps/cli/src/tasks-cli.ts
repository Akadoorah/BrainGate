import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BrainGateInvariantError,
  ResultStore,
  TaskLedger,
  legacyExecutionState,
  finalizedSnapshotOf,
  inspectReconciliation,
  reconcile,
  registerActiveRun,
  type ObservationInput,
  type ObservationRecord,
  type ObservationWriter,
  type RegisteredProject,
  type TaskReceipt,
  type TaskRecord,
  type ExecutionScope,
} from "@braingate/core";
import { DogfoodStore } from "@braingate/dogfood";
import { MAX_PROVIDER_CALL_MS } from "@braingate/shadow";
import { STALE_CALL_MULTIPLIER, executionAttribution, isTerminalTaskState, recordedExecutionAttribution } from "@braingate/core";
import { ProjectSnapshotProvider } from "@braingate/execution";
import type { TaskSnapshotProvider } from "@braingate/shadow";
import { quotaRefusalFromEvents } from "@braingate/observability";
import { redactSecrets } from "@braingate/security";
import { resolveOperatorState } from "@braingate/operator";
import { DEFAULT_MANIFEST, findManifest } from "./manifest-path.js";
import { attachFromManifest } from "./project-attachment.js";
import { reviewerVerdictOf } from "./finalization.js";

/**
 * Reading, and finishing, the tasks BrainGate has run.
 *
 * Until now the ledger was write-only from the operator's side: a task could be seen in `status`
 * as a one-line summary, and nothing could answer "what happened to it" or "did anything get left
 * half-written". This is that surface, and it is deliberately read-only for everything except
 * `reconcile`.
 */

export interface TasksCliDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /** Injectable for tests; the real one reads the per-command ledger. */
  readonly now?: () => Date;
  /**
   * Where a project copy would come from, and what reconciles a leftover one.
   *
   * A test supplies a fake, so it can prove reconciliation tidies what a killed process left without
   * copying a real project to do it.
   */
  readonly snapshotStore?: TaskSnapshotProvider;
}

export interface TasksCliResult {
  readonly exitCode: number;
  readonly data: unknown;
}

const DEFAULT_LIMIT = 20;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new BrainGateInvariantError("CLI_ARGUMENT_INVALID", `${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function removeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function noExtraArgs(args: string[]): void {
  if (args.length > 0) throw new BrainGateInvariantError("CLI_ARGUMENT_INVALID", `Unexpected CLI argument: ${args[0]}.`);
}

function emit(json: boolean, data: unknown, human: string, stdout: (text: string) => void): void {
  stdout(json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
}

/**
 * The corpus writer, for the tasks this command repairs.
 *
 * A reconciled task must end up in the corpus like any other: excluding it would make the corpus a
 * record of the runs that finished cleanly, which is the opposite of what it is for. It is recorded
 * with `reconciled: true`, so nothing downstream has to guess how it got there.
 */
class ReconcileObservationWriter implements ObservationWriter {
  readonly #store: DogfoodStore;
  readonly #ledger: TaskLedger;

  constructor(store: DogfoodStore, ledger: TaskLedger) {
    this.#store = store;
    this.#ledger = ledger;
  }

  find(taskId: string): ObservationRecord | null {
    return this.#store.find(taskId);
  }

  record(input: ObservationInput): ObservationRecord {
    const receipt = this.#ledger.receipt(input.taskId);
    return this.#store.recordObservation({ ...input, receipt, reviewerVerdict: reviewerVerdictOf(receipt) });
  }
}

function depsFor(scope: ExecutionScope, ledger: TaskLedger, store: DogfoodStore, now: () => Date) {
  return Object.freeze({
    ledger,
    results: ResultStore.fromScope(scope, { redact: redactSecrets }),
    observations: new ReconcileObservationWriter(store, ledger),
    // Derived, never authored: no provider call can outlive the ceiling the executors enforce, so
    // nothing that has been silent for three of them can still be working.
    staleAfterMs: STALE_CALL_MULTIPLIER * MAX_PROVIDER_CALL_MS,
    now,
  });
}

/**
 * How much of a recorded tail is displayed.
 *
 * The write side bounds a tail at 2 000 characters; this is the same ceiling applied again on the way
 * out, so a row written by an older build or another tool cannot flood a terminal.
 */
const FAILURE_TAIL_DISPLAY_CHARS = 2_000;

/** A budget limits how many times a role may be attempted; a hand-edited ledger may not. */
const MAX_DISPLAYED_FAILURES = 8;

/**
 * One failed provider attempt, as the ledger recorded it.
 *
 * Every field is copied, coerced or omitted — never inferred. `null` means the record does not carry
 * it, which is different from a value of zero, and nothing here decides what the failure means.
 */
export interface FailureView {
  readonly role: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly quotaPool: string | null;
  readonly failureKind: string | null;
  /** Some writers record a cause as a phrase instead of a taxonomy value, e.g. `sandbox-not-applied`. */
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Recorded only by writers that capture one; `null` is "not recorded", not "no signal". */
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly stderrTail: string | null;
  readonly stdoutTail: string | null;
  readonly retainedChars: number | null;
  readonly error: string | null;
}

function textOf(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberOf(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Every failed provider attempt the ledger recorded, in order, bounded.
 *
 * This is the evidence a failed task is explained by. The tails are redacted once when they are
 * written; they are redacted again here, because this is the path that puts them on a screen and
 * somewhere a person will copy them from.
 */
/**
 * What the provider was given, when it was given a project copy.
 *
 * The manifest identity, the counts, the policy version and the source fingerprint are read back from
 * the task's own events, so the answer survives the snapshot being deleted — which it always is.
 */
export interface SnapshotView {
  readonly snapshotId: string;
  readonly manifestHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly policyVersion: string;
  readonly sourceFingerprint: string;
  readonly role: string | null;
  readonly provider: string | null;
  readonly model: string | null;
}

export function snapshotViews(events: readonly { readonly kind: string; readonly payload: unknown }[]): readonly SnapshotView[] {
  const views: SnapshotView[] = [];
  for (const event of events) {
    if (event.kind !== "task.snapshot") continue;
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
    const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
    views.push(Object.freeze({
      snapshotId: text(record.snapshotId) ?? "unknown",
      manifestHash: text(record.manifestHash) ?? "unknown",
      fileCount: count(record.fileCount) ?? 0,
      totalBytes: count(record.totalBytes) ?? 0,
      policyVersion: text(record.policyVersion) ?? "unknown",
      sourceFingerprint: text(record.sourceFingerprint) ?? "unknown",
      role: text(record.role),
      provider: text(record.provider),
      model: text(record.model),
    }));
  }
  return Object.freeze(views);
}

function snapshotLines(events: readonly { readonly kind: string; readonly payload: unknown }[]): readonly string[] {
  return snapshotViews(events).map((view) =>
    `  snapshot ${view.manifestHash.slice(0, 16)} · ${String(view.fileCount)} files · ${String(view.totalBytes)} bytes · policy ${view.policyVersion}${view.provider === null ? "" : ` · read by ${view.provider}/${view.model ?? "unknown"} as ${view.role ?? "unknown"}`}`,
  );
}

export function failureViews(events: readonly { readonly kind: string; readonly payload: unknown }[]): readonly FailureView[] {
  const views: FailureView[] = [];
  for (const event of events) {
    if (event.kind !== "shadow.provider.failed") continue;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    const tail = (key: string): string | null => {
      const value = textOf(record, key);
      return value === null ? null : redactSecrets(value).slice(0, FAILURE_TAIL_DISPLAY_CHARS);
    };
    views.push(Object.freeze({
      role: textOf(record, "role"),
      provider: textOf(record, "provider"),
      model: textOf(record, "model"),
      quotaPool: textOf(record, "quotaPool"),
      failureKind: textOf(record, "failureKind"),
      reason: textOf(record, "reason"),
      exitCode: numberOf(record, "exitCode"),
      timedOut: record.timedOut === true,
      signal: textOf(record, "signal"),
      durationMs: numberOf(record, "durationMs"),
      stderrTail: tail("stderrTail"),
      stdoutTail: tail("stdoutTail"),
      retainedChars: numberOf(record, "retainedChars"),
      error: tail("error"),
    }));
  }
  return Object.freeze(views.slice(-MAX_DISPLAYED_FAILURES));
}

function indent(text: string): readonly string[] {
  return text.split("\n").map((line) => `      ${line}`);
}

/** One line per task: what it was, what state it reached, and what BrainGate decided. */
function taskLine(task: TaskRecord, snapshot: ReturnType<typeof finalizedSnapshotOf>): string {
  const decided = snapshot === null
    ? "not recorded"
    : `${snapshot.outcome}${snapshot.failureKind === null ? "" : ` (${snapshot.failureKind})`}${snapshot.reconciled ? " · reconciled" : ""}`;
  return `${task.taskId.slice(0, 8)}  ${task.state.padEnd(10)}  ${decided.padEnd(28)}  ${task.complexity ?? "-"}/${task.risk ?? "-"}  ${task.title}`;
}

interface ListedTask {
  readonly task: TaskRecord;
  readonly snapshot: ReturnType<typeof finalizedSnapshotOf>;
}

function matches(task: TaskRecord, snapshot: ReturnType<typeof finalizedSnapshotOf>, filters: { readonly state?: string; readonly outcome?: string; readonly failureKind?: string }): boolean {
  if (filters.state !== undefined && task.state !== filters.state) return false;
  if (filters.outcome !== undefined && (snapshot?.outcome ?? null) !== filters.outcome) return false;
  if (filters.failureKind !== undefined && (snapshot?.failureKind ?? null) !== filters.failureKind) return false;
  return true;
}

async function runList(args: string[], deps: TasksCliDependencies, cwd: string, json: boolean, stdout: (text: string) => void): Promise<TasksCliResult> {
  const manifest = takeOption(args, "--project") ?? DEFAULT_MANIFEST;
  const state = takeOption(args, "--state");
  const outcome = takeOption(args, "--outcome");
  const failureKind = takeOption(args, "--failure-kind");
  const limitRaw = takeOption(args, "--limit");
  noExtraArgs(args);
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new BrainGateInvariantError("CLI_ARGUMENT_INVALID", "--limit must be an integer between 1 and 1000.");
  const operatorState = resolveOperatorState(deps.env ?? process.env);
  const { project, scope } = attachFromManifest(operatorState, manifest, cwd);
  const ledger = new TaskLedger(scope.project);
  try {
    // Newest first: the operator is looking for the task they just ran, not the first one ever.
    const all = [...ledger.listTasks()].reverse();
    const filtered = all
      .map((task): ListedTask => Object.freeze({ task, snapshot: finalizedSnapshotOf(ledger.receipt(task.taskId).events) }))
      .filter((entry) => matches(entry.task, entry.snapshot, { ...(state === undefined ? {} : { state }), ...(outcome === undefined ? {} : { outcome }), ...(failureKind === undefined ? {} : { failureKind }) }));
    const page = filtered.slice(0, limit);
    const data = Object.freeze({
      projectId: project.projectId,
      workspaceId: scope.workspaceId,
      workspacePath: scope.workspacePath,
      matched: filtered.length,
      shown: page.length,
      tasks: Object.freeze(page.map((entry) => Object.freeze({
        taskId: entry.task.taskId,
        state: entry.task.state,
        complexity: entry.task.complexity,
        risk: entry.task.risk,
        title: entry.task.title,
        createdAt: entry.task.createdAt,
        updatedAt: entry.task.updatedAt,
        outcome: entry.snapshot?.outcome ?? null,
        reviewStatus: entry.snapshot?.reviewStatus ?? null,
        failureKind: entry.snapshot?.failureKind ?? null,
        reconciled: entry.snapshot?.reconciled ?? false,
        basis: entry.snapshot?.basis ?? Object.freeze([]),
      }))),
    });
    const header = `task      state       outcome                      tier   title`;
    const lines = page.length === 0 ? ["No tasks matched."] : [header, ...page.map((entry) => taskLine(entry.task, entry.snapshot))];
    // An empty workspace ledger next to state from before workspaces existed is the one case where
    // "no tasks" needs an explanation: the history is still there, and it belongs to no directory
    // BrainGate can name, so it is preserved rather than shown as if it were this workspace's.
    if (all.length === 0) {
      const legacy = legacyExecutionState(scope.projectStorageDir);
      if (legacy.length > 0) {
        lines.push("", `Execution state from before workspaces is present at ${scope.projectStorageDir} (${legacy.join(", ")}).`, "It is preserved, is not used here, and is not carried into this workspace.");
      }
    }
    if (filtered.length > page.length) lines.push(`… ${filtered.length - page.length} more (--limit ${filtered.length} to see them).`);
    emit(json, data, lines.join("\n"), stdout);
    return Object.freeze({ exitCode: 0, data });
  } finally { ledger.close(); }
}

async function runShow(args: string[], deps: TasksCliDependencies, cwd: string, json: boolean, stdout: (text: string) => void): Promise<TasksCliResult> {
  const manifest = takeOption(args, "--project") ?? DEFAULT_MANIFEST;
  const printResult = removeFlag(args, "--result");
  const taskId = args.shift();
  noExtraArgs(args);
  if (taskId === undefined) throw new BrainGateInvariantError("CLI_ARGUMENT_INVALID", "tasks show requires a task id.");
  const operatorState = resolveOperatorState(deps.env ?? process.env);
  const { project, scope } = attachFromManifest(operatorState, manifest, cwd);
  const ledger = new TaskLedger(scope.project);
  try {
    const receipt: TaskReceipt = ledger.receipt(resolveTaskId(ledger, taskId));
    const snapshot = finalizedSnapshotOf(receipt.events);
    // Read from the run's own provider events: what was dispatched, not what was planned.
    const execution = recordedExecutionAttribution(receipt.events) ?? executionAttribution({ events: receipt.events });
    const refusal = quotaRefusalFromEvents(receipt.events);
    const results = ResultStore.fromScope(scope, { redact: redactSecrets });
    let resultEvent: Record<string, unknown> | null = null;
    for (let index = receipt.events.length - 1; index >= 0; index -= 1) {
      const event = receipt.events[index]!;
      if (event.kind !== "task.result" || typeof event.payload !== "object" || event.payload === null) continue;
      resultEvent = event.payload as Record<string, unknown>;
      break;
    }
    const relativePath = typeof resultEvent?.relativePath === "string" ? resultEvent.relativePath : null;
    // Read through the store so a file that no longer matches its name is reported as torn rather
    // than printed as though it were the result. Whether the file is *there* is a fact about the
    // artifact, and the record is a fact about the task: a deleted file must not make the record
    // uninspectable, so absence is detected here and reported, never thrown from this path.
    const located = results.locate(receipt.task.taskId);
    const artifactMissing = relativePath !== null && !results.exists(relativePath);
    const printed = printResult && relativePath !== null && !artifactMissing ? results.read(relativePath) : null;
    const recorded = resultEvent;
    const failures = failureViews(receipt.events);
    const data = Object.freeze({
      projectId: project.projectId,
      task: receipt.task,
      outcome: snapshot?.outcome ?? null,
      reviewStatus: snapshot?.reviewStatus ?? null,
      failureKind: snapshot?.failureKind ?? null,
      reconciled: snapshot?.reconciled ?? false,
      basis: snapshot?.basis ?? Object.freeze([]),
      // Who actually ran, and how far each role got: the plan's roles are not the same fact as the
      // executed ones, and this is the record that keeps a planner on another provider from vanishing.
      execution,
      snapshots: snapshotViews(receipt.events),
      quotaRefusal: refusal,
      transitions: Object.freeze(receipt.events.filter((event) => event.toState !== null).map((event) => Object.freeze({ from: event.fromState, to: event.toState, at: event.occurredAt }))),
      events: Object.freeze(receipt.events.map((event) => Object.freeze({ sequence: event.sequence, kind: event.kind, at: event.occurredAt }))),
      usage: receipt.usage,
      failures,
      result: recorded === null ? null : Object.freeze({
        kind: typeof recorded.kind === "string" ? recorded.kind : null,
        relativePath,
        bytes: typeof recorded.bytes === "number" ? recorded.bytes : 0,
        sha256: typeof recorded.sha256 === "string" ? recorded.sha256 : null,
        truncated: recorded.truncated === true,
        // `missing` is the state a reader needs: the ledger says an artifact exists and the disk
        // says otherwise. `present` is its complement, so neither has to be inferred from `files`.
        missing: artifactMissing,
        present: relativePath !== null && !artifactMissing,
        files: Object.freeze(located.valid.map((entry) => entry.relativePath)),
        torn: Object.freeze([...located.torn]),
      }),
      ...(printed !== null ? { resultText: printed } : {}),
    });

    // `--result` asks for the bytes themselves. When they were asked for and cannot be produced, that
    // is a failure of *the request* and is reported as one — and the two reasons stay apart, because
    // "the recorded artifact was deleted" and "this task never recorded one" have different next
    // steps. The plain invocation says the same thing in its output and still exits 0.
    if (printResult) {
      const expectedSha = typeof recorded?.sha256 === "string" ? recorded.sha256 : null;
      const expectedBytes = typeof recorded?.bytes === "number" ? recorded.bytes : 0;
      if (recorded === null) {
        throw new BrainGateInvariantError("RESULT_NOT_RECORDED", `Task ${receipt.task.taskId} recorded no result to print.`);
      }
      if (artifactMissing) {
        throw new BrainGateInvariantError(
          "RESULT_MISSING",
          `The result artifact this task recorded is not on disk: ${String(relativePath)} (sha256 ${expectedSha ?? "not recorded"}, ${String(expectedBytes)} bytes). The task's own record is intact — run \`braingate tasks show ${receipt.task.taskId}\` to see it.`,
        );
      }
    }

    const lines = [
      `${receipt.task.title}`,
      `  task     ${receipt.task.taskId}`,
      `  state    ${receipt.task.state}`,
      `  outcome  ${snapshot === null ? "not recorded · run `braingate tasks reconcile`" : `${snapshot.outcome}${snapshot.failureKind === null ? "" : ` (${snapshot.failureKind})`}${snapshot.reconciled ? " · reconciled" : ""}`}`,
      `  review   ${snapshot?.reviewStatus ?? "not recorded"}`,
      `  basis    ${snapshot === null || snapshot.basis.length === 0 ? "none" : snapshot.basis.join(", ")}`,
      `  tier     ${receipt.task.complexity ?? "-"}/${receipt.task.risk ?? "-"}`,
      `  updated  ${receipt.task.updatedAt}`,
      // The workspace a role read is part of what the role did, so it is rendered beside the model
      // rather than left to the reader to infer from the provider's name.
      ...(execution.length === 0 ? [] : [`  executed ${execution.map((role) => `${role.role}=${role.providerId}/${role.modelId}(${role.status ?? "planned"}${role.workspaceMode === undefined ? "" : `, ${role.workspaceMode}`})`).join(" · ")}`]),
      ...snapshotLines(receipt.events),
      ...(refusal === null ? [] : [`  refusal  ${refusal.providerId}/${refusal.quotaPool} · ${refusal.reason} · ${refusal.observedAt} · ${refusal.resetAt === null ? "no machine-readable reset" : `reset ${refusal.resetAt}`}`]),
    ];
    // What was tried and what the provider said, before anything else on a failed task. The outcome
    // line names the failure kind; this is the evidence behind it, and until now it was recorded and
    // never shown.
    for (const [index, failure] of failures.entries()) {
      const heading = failures.length === 1 ? "failure" : `failure ${String(index + 1)}/${String(failures.length)}`;
      const where = `${failure.role ?? "unknown role"} ${failure.provider ?? "?"}/${failure.model ?? "?"}`;
      const cause = failure.failureKind ?? failure.reason ?? "no cause recorded";
      const exit = failure.exitCode === null ? "no exit code recorded" : `exit ${String(failure.exitCode)}`;
      const timed = failure.timedOut ? " · timed out" : "";
      const signal = failure.signal === null ? "" : ` · signal ${failure.signal}`;
      const duration = failure.durationMs === null ? "" : ` · ${String(failure.durationMs)}ms`;
      const pool = failure.quotaPool === null ? "" : ` · ${failure.quotaPool}`;
      lines.push(`  ${heading}  ${where} · ${cause} · ${exit}${timed}${signal}${duration}${pool}`);
      if (failure.stderrTail !== null) lines.push(`    stderr`, ...indent(failure.stderrTail));
      if (failure.stdoutTail !== null) lines.push(`    stdout`, ...indent(failure.stdoutTail));
      if (failure.stderrTail === null && failure.stdoutTail === null) lines.push("    (the provider left no output)");
    }
    if (receipt.usage.length > 0) {
      lines.push("  usage");
      for (const usage of receipt.usage) lines.push(`    ${usage.provider}/${usage.model ?? "-"} ${usage.metric}=${usage.value === null ? "unknown" : String(usage.value)}${usage.unit === null ? "" : usage.unit} (${usage.evidence})`);
    }
    if (recorded !== null) {
      const kind = typeof recorded.kind === "string" ? recorded.kind : "none";
      const bytes = typeof recorded.bytes === "number" ? recorded.bytes : 0;
      if (artifactMissing) {
        // The record is intact and the bytes are gone. Saying only "MISSING" would read as a task
        // that produced nothing; the expected artifact is named, with what it should hash to, so the
        // difference between "lost" and "never made" is on the screen.
        lines.push(`  result   MISSING · the recorded artifact is not on disk`);
        lines.push(`    expected ${String(relativePath)}`);
        lines.push(`    sha256   ${typeof recorded.sha256 === "string" ? recorded.sha256 : "not recorded"} · ${String(bytes)} bytes`);
      } else {
        const torn = located.torn.length > 0 ? ` · ${String(located.torn.length)} file(s) do not match their hash` : "";
        lines.push(`  result   ${kind} · ${String(bytes)} bytes${recorded.truncated === true ? " · truncated" : ""}${torn}`);
        if (printResult && printed === null) lines.push("    (no stored result file to print)");
      }
    } else {
      lines.push("  result   none recorded");
    }
    if (printed !== null) lines.push("", printed);
    emit(json, data, lines.join("\n"), stdout);
    return Object.freeze({ exitCode: 0, data });
  } finally { ledger.close(); }
}

/** A task id may be given in full or by its printed prefix, which is how `list` shows it. */
function resolveTaskId(ledger: TaskLedger, requested: string): string {
  const exact = ledger.listTasks().find((task) => task.taskId === requested);
  if (exact !== undefined) return exact.taskId;
  const matches = ledger.listTasks().filter((task) => task.taskId.startsWith(requested));
  if (matches.length === 1) return matches[0]!.taskId;
  if (matches.length === 0) throw new BrainGateInvariantError("TASK_NOT_FOUND", `No task in this project starts with ${requested}.`);
  throw new BrainGateInvariantError("TASK_AMBIGUOUS", `${matches.length} tasks start with ${requested}; give more of the id.`);
}

async function runReconcile(args: string[], deps: TasksCliDependencies, cwd: string, json: boolean, stdout: (text: string) => void): Promise<TasksCliResult> {
  const manifest = takeOption(args, "--project") ?? DEFAULT_MANIFEST;
  noExtraArgs(args);
  const operatorState = resolveOperatorState(deps.env ?? process.env);
  const { project, scope } = attachFromManifest(operatorState, manifest, cwd);
  const ledger = new TaskLedger(scope.project);
  const store = new DogfoodStore(scope.project);
  const unregister = registerActiveRun(() => { /* a signal during reconciliation stops here; the next run finishes it */ });
  try {
    const now = deps.now ?? (() => new Date());
    const report = reconcile(scope.project, depsFor(scope, ledger, store, now), now());
    // Reconciliation is where a task's remains are already being tidied, so it is where a project copy
    // left by a killed process is tidied too. A separate concern from the record: the sweep removes
    // only BrainGate-owned snapshot directories whose owning process is gone, and reports what it
    // will not touch rather than guessing at it.
    const sweep = (deps.snapshotStore ?? new ProjectSnapshotProvider(scope.project)).sweep({
      isTaskFinished: (taskId) => {
        try { return isTerminalTaskState(ledger.receipt(taskId).task.state); }
        catch { return undefined; }
      },
    });
    const data = Object.freeze({
      projectId: project.projectId,
      required: report.required,
      reconciled: report.reconciled,
      interrupted: report.interrupted,
      conflicts: report.conflicts,
      partialFinalizations: report.partialFinalizations,
      staleNonTerminal: report.staleNonTerminal,
      snapshotsRemoved: sweep.removed,
      snapshotsKept: sweep.kept,
      snapshotsUnrecognised: sweep.unrecognised,
    });
    const lines = report.required === 0
      ? ["Nothing to reconcile: every task has a complete record."]
      : [
        `Reconciled ${report.reconciled.length} task(s): ${report.interrupted.length} interrupted, ${report.reconciled.length - report.interrupted.length} finished but unrecorded.`,
        ...report.reconciled.map((taskId) => `  ${taskId}`),
      ];
    if (report.conflicts.length > 0) lines.push(...["Conflicts (the store refused to overwrite):", ...report.conflicts.map((entry) => `  ${entry}`)]);
    if (sweep.removed > 0) lines.push(`Removed ${String(sweep.removed)} project snapshot(s) left by a process that is gone.`);
    if (sweep.unrecognised > 0) lines.push(`Left ${String(sweep.unrecognised)} unrecognised entr(ies) in the snapshots directory alone.`);
    emit(json, data, lines.join("\n"), stdout);
    return Object.freeze({ exitCode: 0, data });
  } finally {
    unregister();
    store.close();
    ledger.close();
  }
}

/**
 * Reports what a read-only command would have to reconcile, without writing anything.
 *
 * `status`, `tasks list`, `tasks show` and `doctor` are observational; this is how one of them can
 * still tell the operator that something is waiting, without becoming a writer.
 *
 * A project whose corpus has never been written is answered without opening it: `status` must not be
 * the command that creates a database, and a corpus that does not exist has no observations to
 * report. Opening an existing one is a read.
 */
export function reconciliationNotice(scope: ExecutionScope, ledger: TaskLedger, now = new Date()): string | null {
  const required = (observations: ObservationWriter): number => inspectReconciliation({
    ledger,
    results: ResultStore.fromScope(scope, { redact: redactSecrets }),
    observations,
    staleAfterMs: STALE_CALL_MULTIPLIER * MAX_PROVIDER_CALL_MS,
    now: () => now,
  }, now).required;

  let count: number;
  if (!existsSync(join(scope.storageDir, "dogfood.sqlite"))) {
    const absent: ObservationWriter = {
      find: () => null,
      record: () => { throw new BrainGateInvariantError("DOGFOOD_READ_ONLY", "A read-only command does not write observations."); },
    };
    count = required(absent);
  } else {
    const store = new DogfoodStore(scope.project);
    try { count = required(new ReconcileObservationWriter(store, ledger)); } finally { store.close(); }
  }
  return count === 0 ? null : `Reconciliation required: ${String(count)} task(s). Run \`braingate tasks reconcile\`.`;
}

export async function runTasksCli(argv: readonly string[], deps: TasksCliDependencies = {}): Promise<TasksCliResult> {
  const args = [...argv];
  const json = removeFlag(args, "--json");
  const cwd = realpathSync.native(resolve(deps.cwd ?? process.cwd()));
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  try {
    const command = args.shift();
    if (command === "list") return await runList(args, deps, cwd, json, stdout);
    if (command === "show") return await runShow(args, deps, cwd, json, stdout);
    if (command === "reconcile") return await runReconcile(args, deps, cwd, json, stdout);
    throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "tasks requires list, show, or reconcile.");
  } catch (error) {
    const safe = error instanceof BrainGateInvariantError
      ? { code: error.code, message: error.message }
      : { code: "CLI_UNEXPECTED", message: "Unexpected BrainGate tasks failure. Raw error details were suppressed." };
    const data = { error: safe };
    (deps.stderr ?? ((text: string) => process.stderr.write(text)))(json ? `${JSON.stringify(data, null, 2)}\n` : `BrainGate ${safe.code}: ${safe.message}\n`);
    return Object.freeze({ exitCode: 1, data });
  }
}
