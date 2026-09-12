import { BrainGateInvariantError } from "./errors.js";
import type { TaskComplexity, TaskRisk } from "./task-outcome.js";
import {
  DERIVATION_VERSION,
  isFailureKind,
  isReviewStatus,
  isTaskOutcome,
  isTerminalTaskState,
  observationOutcomeFor,
  type FailureKind,
  type ObservationOutcome,
  type ReviewStatus,
  type TaskOutcome,
  type TaskState,
} from "./task-outcome.js";
import type { ResultKind, ResultStore, StoredResult } from "./result-store.js";
import type { TaskEvent, TaskLedger } from "./task-ledger.js";

/**
 * The one ordered path that turns a finished run into a permanent record.
 *
 * There is no transaction across `tasks.sqlite`, `dogfood.sqlite` and the result files, and there
 * cannot be: every store is opened with WAL, and SQLite only guarantees atomic commit across
 * attached databases when the journal mode is *not* WAL. So the sequence is fixed, every step is
 * idempotent, and a reconciler can finish any prefix of it.
 *
 * The order is what makes a crash survivable:
 *
 *   1. compose the plan in memory
 *   2. write the result file      — the only artifact that cannot be recomputed, so it goes first
 *   3. append `task.result`       — the durable claim that the file exists and what it hashes to
 *   4. append the observation     — the measurement record
 *   5. append `task.finalized`    — the marker, with an evidence snapshot for audit
 *   6. transition the task        — last, so a terminal task is by definition fully finalized
 *
 * Evidence before status. Today's code does the reverse, which is why a task can be `completed`
 * with nothing recorded about what it produced.
 */

/**
 * The workflow roles, as a runtime list with a derived type.
 *
 * Attribution is read back out of ledger payloads, so the check and the type must be the same fact:
 * a role the engine can route but this list omits would silently vanish from the record, which is
 * exactly the bug this vocabulary is used to fix.
 */
/**
 * The workspace modes a task's own record can name, as a runtime list so the type cannot drift from
 * what the writers actually record.
 */
export const OBSERVATION_WORKSPACE_MODES = Object.freeze(["project-checkout", "staged-read-snapshot", "staged-context", "task-worktree"] as const);
export type ObservationWorkspaceMode = (typeof OBSERVATION_WORKSPACE_MODES)[number];

export function isObservationWorkspaceMode(value: unknown): value is ObservationWorkspaceMode {
  return typeof value === "string" && (OBSERVATION_WORKSPACE_MODES as readonly string[]).includes(value);
}

/** The invariant `workspaceMode` an invocation is recorded with, mapped from the plan's vocabulary. */
export function observationWorkspaceMode(workspaceMode: unknown): ObservationWorkspaceMode | null {
  if (workspaceMode === "project") return "project-checkout";
  if (workspaceMode === "staged-read-snapshot") return "staged-read-snapshot";
  if (workspaceMode === "staged-clean") return "staged-context";
  if (workspaceMode === "task-worktree") return "task-worktree";
  return null;
}

export const OBSERVATION_ROLE_NAMES = Object.freeze(["planner", "primary", "reviewer", "judge"] as const);
export type ObservationRoleName = (typeof OBSERVATION_ROLE_NAMES)[number];

export function isObservationRoleName(value: unknown): value is ObservationRoleName {
  return typeof value === "string" && (OBSERVATION_ROLE_NAMES as readonly string[]).includes(value);
}

export interface ObservationRole {
  readonly role: ObservationRoleName;
  readonly providerId: string;
  readonly modelId: string;
  /**
   * How far this role got, from the task's own provider events.
   *
   * `planned` is the routing decision; `attempted` means a provider call started and did not
   * complete; `completed` means the provider answered. The three are different facts, and a role
   * that was only routed must not read as one that ran.
   */
  readonly status?: "planned" | "attempted" | "completed";
  /**
   * Where this role's provider was pointed, when the record says.
   *
   * `project-checkout` is the operator's working directory; `staged-read-snapshot` is a copy BrainGate
   * made. They are different security facts about the same task, so a record that omits this reads as
   * though every role saw the same thing.
   */
  readonly workspaceMode?: ObservationWorkspaceMode;
}

export interface ObservationContext {
  readonly predicted: { readonly complexity: TaskComplexity; readonly risk: TaskRisk; readonly ruleVersion: string };
  readonly effective: { readonly complexity: TaskComplexity; readonly risk: TaskRisk; readonly ruleVersion: string };
  readonly roles: readonly ObservationRole[];
  /**
   * Opaque here on purpose: the prior's shape belongs to the measurement package, and the adapter
   * that writes observations validates it. `null` means "no adaptive prior participated", which a
   * reconciled run can honestly assert.
   */
  readonly prior: unknown;
}

export interface FinalizationResultInput {
  readonly kind: ResultKind | "none";
  /** Already redacted by the caller; the store redacts again before hashing as a second guard. */
  readonly text: string | null;
  readonly mediaType?: string;
  readonly evidence: "redacted" | "recovered" | "lost-to-crash" | "unavailable";
}

export interface FinalizationPlan {
  readonly taskId: string;
  readonly projectId: string;
  readonly mode: "ask" | "write";
  readonly outcome: TaskOutcome;
  readonly reviewStatus: ReviewStatus;
  readonly failureKind: FailureKind | null;
  /** Which recorded evidence produced the outcome, stored so a reader can audit the derivation. */
  readonly basis: readonly string[];
  readonly result: FinalizationResultInput;
  readonly observation: ObservationContext;
  readonly reconciled: boolean;
  /** `null` means "already terminal or nothing to settle into"; see `ledgerStateFor`. */
  readonly ledgerState: TaskState | null;
}

export interface ObservationRecord {
  readonly sequence: number;
  readonly outcome: ObservationOutcome;
  readonly failureKind: FailureKind | null;
  readonly reconciled: boolean;
}

export interface ObservationInput {
  readonly taskId: string;
  readonly mode: "ask" | "write";
  readonly predicted: ObservationContext["predicted"];
  readonly effective: ObservationContext["effective"];
  readonly roles: readonly ObservationRole[];
  readonly outcome: ObservationOutcome;
  readonly failureKind: FailureKind | null;
  readonly prior: unknown;
  readonly reconciled: boolean;
}

export interface ObservationWriter {
  find(taskId: string): ObservationRecord | null;
  record(input: ObservationInput): ObservationRecord;
}

export interface TaskFinalizer {
  finalize(plan: FinalizationPlan): FinalizationRecord;
}

/** The seam implementation: anything holding the three durable destinations can finalize. */
export function createFinalizer(deps: FinalizationDeps): TaskFinalizer {
  return Object.freeze({ finalize: (plan: FinalizationPlan): FinalizationRecord => finalizeTask(deps, plan) });
}

/**
 * An observation writer that keeps records in memory.
 *
 * The seam exists so an execution package never learns about a measurement store. This
 * implementation is for tests, and for a caller that legitimately has no store; the CLI wires the
 * project's own persistent one, because a corpus that lives only in memory is the bug M19 fixed.
 */
export class InMemoryObservationWriter implements ObservationWriter {
  readonly #records = new Map<string, ObservationRecord>();
  readonly #inputs = new Map<string, ObservationInput>();

  find(taskId: string): ObservationRecord | null {
    return this.#records.get(taskId) ?? null;
  }

  record(input: ObservationInput): ObservationRecord {
    const existing = this.#records.get(input.taskId);
    if (existing !== undefined) return existing;
    const record = Object.freeze({
      sequence: this.#records.size + 1,
      outcome: input.outcome,
      failureKind: input.failureKind,
      reconciled: input.reconciled,
    });
    this.#records.set(input.taskId, record);
    this.#inputs.set(input.taskId, input);
    return record;
  }

  list(): readonly ObservationRecord[] {
    return Object.freeze([...this.#records.values()]);
  }

  /**
   * What was recorded for a task, in full.
   *
   * `list()` answers "which observations exist" with the fields a reader decides on; this answers
   * "what did the writer say", which is what a test — or a reconciler's own audit — needs to check
   * that an attribution survived a crash rather than being reconstructed differently.
   */
  recordedInput(taskId: string): ObservationInput | null {
    return this.#inputs.get(taskId) ?? null;
  }
}

export interface FinalizationDeps {
  readonly ledger: TaskLedger;
  readonly results: ResultStore;
  readonly observations: ObservationWriter;
  readonly now?: () => Date;
}

export interface FinalizationRecord {
  readonly taskId: string;
  readonly outcome: TaskOutcome;
  readonly resultRelativePath: string | null;
  readonly resultSha256: string | null;
  readonly observationSequence: number;
  readonly alreadyFinalized: boolean;
  readonly conflicts: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Whether an orphan artifact should be claimed for this task.
 *
 * Only \`FAILED\` refuses one, and only because a failed run leaves nothing to fail on. Every other
 * outcome adopts what it finds — including INTERRUPTED, which is what a run that died before
 * recording anything derives — because the alternative is an answer or a diff sitting on disk that
 * the ledger never mentions. The claim is recorded with \`evidence: "recovered"\`, so it says
 * "discovered, not written by this finalizer" without claiming the run succeeded.
 */
function adoptsOrphan(outcome: TaskOutcome): boolean {
  return outcome !== "FAILED";
}

function lastPayload(events: readonly TaskEvent[], kind: string): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== kind) continue;
    const payload = event.payload;
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) return payload as Record<string, unknown>;
    return null;
  }
  return null;
}

function reviewerVerdictFor(status: ReviewStatus): "approve" | "request_changes" | "disagree" | null {
  if (status === "APPROVED" || status === "APPROVED_AFTER_REPAIR" || status === "APPROVED_BY_JUDGE") return "approve";
  if (status === "CHANGES_REQUESTED" || status === "CHANGES_REQUESTED_PENDING") return "request_changes";
  if (status === "DISAGREED") return "disagree";
  return null;
}

export function finalizeTask(deps: FinalizationDeps, plan: FinalizationPlan): FinalizationRecord {
  const task = deps.ledger.requireTask(plan.taskId);
  if (task.projectId !== plan.projectId) {
    throw new BrainGateInvariantError("FINALIZE_PROJECT_MISMATCH", "A finalization plan must belong to the task's own project.");
  }
  const now = (deps.now ?? ((): Date => new Date()))().toISOString();
  const conflicts: string[] = [];
  const notes: string[] = [];

  // The receipt is re-read at each step rather than cached: a second process may be finalizing
  // the same task concurrently, and every step below decides from what is durable right now.
  const before = deps.ledger.receipt(plan.taskId);
  const existingResult = lastPayload(before.events, "task.result");
  const existingMarker = lastPayload(before.events, "task.finalized");
  const alreadyFinalized = existingMarker !== null;

  // --- step 2: the result file, or a recovered one -------------------------------
  let stored: StoredResult | null = null;
  let evidence = plan.result.evidence;
  const hasText = plan.result.kind !== "none" && plan.result.text !== null && plan.result.text.trim().length > 0;
  if (hasText) {
    stored = deps.results.persist(plan.taskId, {
      kind: plan.result.kind as ResultKind,
      text: plan.result.text as string,
      ...(plan.result.mediaType === undefined ? {} : { mediaType: plan.result.mediaType }),
    });
  } else if (existingResult === null && adoptsOrphan(plan.outcome)) {
    // Crash between writing the file and recording it. The artifact validates itself against the
    // hash in its own name, so discovery needs no marker.
    const found = deps.results.locate(plan.taskId);
    for (const torn of found.torn) {
      deps.results.discard(torn);
      notes.push(`discarded torn result artifact ${torn}`);
      conflicts.push(`result:torn:${torn}`);
    }
    if (found.valid.length === 1) {
      stored = found.valid[0]!;
      evidence = "recovered";
      notes.push(`recovered result artifact ${stored.relativePath}`);
    } else if (found.valid.length > 1) {
      conflicts.push(`result:multiple-candidates:${String(found.valid.length)}`);
    }
  }

  // --- step 3: the durable claim about the result --------------------------------
  if (existingResult === null) {
    // Metadata only. The ledger is read whole — every `tasks show`, every export, every receipt —
    // so the bytes stay in the result file and this records how to find them and how to prove they
    // are the bytes that were written. A preview here would put a task's content into the one
    // store that is dumped, exported and copied around, which is exactly what the write path's
    // diff test forbids.
    deps.ledger.appendEvent(plan.taskId, "task.result", Object.freeze({
      schemaVersion: 1,
      kind: stored === null ? "none" : stored.kind,
      relativePath: stored?.relativePath ?? null,
      sha256: stored?.sha256 ?? null,
      bytes: stored?.bytes ?? 0,
      originalSha256: stored?.originalSha256 ?? null,
      originalBytes: stored?.originalBytes ?? 0,
      truncated: stored?.truncated ?? false,
      mediaType: stored?.mediaType ?? null,
      evidence,
    }));
  } else if (stored !== null && existingResult.sha256 !== stored.sha256) {
    conflicts.push("result:mismatch");
  }

  // --- step 4: the observation ---------------------------------------------------
  const existingObservation = deps.observations.find(plan.taskId);
  let observationSequence: number;
  if (existingObservation === null) {
    observationSequence = deps.observations.record({
      taskId: plan.taskId,
      mode: plan.mode,
      predicted: plan.observation.predicted,
      effective: plan.observation.effective,
      roles: plan.observation.roles,
      outcome: observationOutcomeFor(plan.outcome),
      failureKind: plan.failureKind,
      prior: plan.observation.prior,
      reconciled: plan.reconciled,
    }).sequence;
  } else {
    observationSequence = existingObservation.sequence;
    if (existingObservation.outcome !== observationOutcomeFor(plan.outcome)
      || existingObservation.failureKind !== plan.failureKind
      || existingObservation.reconciled !== plan.reconciled) {
      conflicts.push("observation:mismatch");
    }
  }

  // --- step 5: the marker, with an evidence snapshot for audit -------------------
  if (existingMarker === null) {
    deps.ledger.appendEvent(plan.taskId, "task.finalized", Object.freeze({
      schemaVersion: 1,
      finalizedAt: now,
      derivationVersion: DERIVATION_VERSION,
      reconciled: plan.reconciled,
      // A snapshot of what BrainGate believed at this moment. Not a second source of truth: the
      // canonical answer is re-derived from the events, and a disagreement is reported below. It
      // exists so a reader that has only the ledger — the CLI printing an exit code, an operator
      // reading a receipt — sees the same answer the writer computed, instead of deriving a
      // second one that could differ.
      snapshot: Object.freeze({
        outcome: plan.outcome,
        reviewStatus: plan.reviewStatus,
        ledgerState: plan.ledgerState,
        failureKind: plan.failureKind,
        basis: Object.freeze([...plan.basis]),
        reconciled: plan.reconciled,
      }),
      observationSequence,
      resultSha256: existingResult === null ? (stored?.sha256 ?? null) : (existingResult.sha256 ?? null),
      resultRelativePath: stored?.relativePath ?? (typeof existingResult?.relativePath === "string" ? existingResult.relativePath : null),
    }));
  } else {
    const snapshot = existingMarker.snapshot;
    if (typeof snapshot === "object" && snapshot !== null) {
      const recorded = snapshot as Record<string, unknown>;
      if (recorded.outcome !== plan.outcome) conflicts.push("finalized:outcome-mismatch");
      if (recorded.reviewStatus !== plan.reviewStatus) conflicts.push("finalized:review-status-mismatch");
    }
  }

  // Conflicts are recorded, never repaired: history is append-only, and silently rewriting what a
  // previous process recorded is the one thing an evidence product must not do.
  for (const conflict of conflicts) {
    deps.ledger.appendEvent(plan.taskId, "task.reconciliation_conflict", Object.freeze({ conflict, source: plan.reconciled ? "reconciliation" : "finalization" }));
  }

  // --- step 6: the terminal transition, last -------------------------------------
  if (!isTerminalTaskState(task.state) && plan.ledgerState !== null) {
    try {
      deps.ledger.transition(plan.taskId, plan.ledgerState, {
        outcome: plan.outcome,
        reviewStatus: plan.reviewStatus,
        code: plan.failureKind,
        source: plan.reconciled ? "reconciliation" : "finalization",
      });
    } catch (error) {
      // A concurrent finalizer won the race. The task is terminal either way; that is the point.
      if (!(error instanceof BrainGateInvariantError && error.code === "TASK_TRANSITION_INVALID")) throw error;
    }
  }

  return Object.freeze({
    taskId: plan.taskId,
    outcome: plan.outcome,
    resultRelativePath: stored?.relativePath ?? (typeof existingResult?.relativePath === "string" ? existingResult.relativePath : null),
    resultSha256: stored?.sha256 ?? (typeof existingResult?.sha256 === "string" ? existingResult.sha256 : null),
    observationSequence,
    alreadyFinalized,
    conflicts: Object.freeze(conflicts),
    notes: Object.freeze(notes),
  });
}

/** What the finalizer recorded about a task, as it recorded it. */
export interface FinalizationSnapshot {
  readonly outcome: TaskOutcome;
  readonly reviewStatus: ReviewStatus;
  readonly ledgerState: TaskState | null;
  readonly failureKind: FailureKind | null;
  readonly basis: readonly string[];
  readonly reconciled: boolean;
}

/**
 * The snapshot a receipt's finalization marker carries, or `null` if it is missing or unreadable.
 *
 * A reader that has only the ledger — the CLI deciding an exit code, `tasks show` printing a
 * card — should report the answer the writer computed rather than derive a second one. Deriving it
 * twice is how the ledger and the operator's screen end up disagreeing about the same task.
 */
export function finalizedSnapshotOf(events: readonly { readonly kind: string; readonly payload: unknown }[]): FinalizationSnapshot | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== "task.finalized") continue;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const raw = (payload as Record<string, unknown>).snapshot;
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    // Validated rather than trusted: a snapshot that does not speak the vocabulary is treated as
    // absent, so a corrupted marker can never be shown as an outcome.
    if (typeof record.outcome !== "string" || !isTaskOutcome(record.outcome)) continue;
    if (typeof record.reviewStatus !== "string" || !isReviewStatus(record.reviewStatus)) continue;
    const state = record.ledgerState;
    const ledgerState: TaskState | null = typeof state === "string" && isTerminalTaskState(state as TaskState) ? state as TaskState : null;
    const failureKind = typeof record.failureKind === "string" && isFailureKind(record.failureKind) ? record.failureKind : null;
    const basis = Array.isArray(record.basis) ? record.basis.filter((item): item is string => typeof item === "string") : [];
    return Object.freeze({
      outcome: record.outcome,
      reviewStatus: record.reviewStatus,
      ledgerState,
      failureKind,
      basis: Object.freeze(basis),
      reconciled: record.reconciled === true,
    });
  }
  return null;
}
