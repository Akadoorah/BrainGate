import {
  ResultStore,
  createFinalizer,
  finalizedSnapshotOf,
  writeVerdictFromEvents,
  writeVerdictFromWorkflow,
  type FailureKind,
  type FinalizationSnapshot,
  type ObservationInput,
  type ObservationRecord,
  type ObservationWriter,
  type RegisteredProject,
  type TaskFinalizer,
  type TaskLedger,
  type TaskOutcome,
  type TaskReceipt,
  type WorkflowOutcome,
} from "@braingate/core";
import type { DogfoodReviewerVerdict, DogfoodStore } from "@braingate/dogfood";
import { normalizeTaskReceipt } from "@braingate/observability";
import { redactSecrets } from "@braingate/security";

/**
 * The observation writer the finalizer calls.
 *
 * It is the only place the corpus learns about a task, which is the point: the runner does not know
 * a measurement store exists, and this adapter is the one component that knows both. The receipt it
 * hands over is the ledger's, so the usage recorded is what the providers measured rather than a
 * second count kept somewhere else.
 */
class StoreObservationWriter implements ObservationWriter {
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
    // A task with no ledger row cannot be observed: the receipt is what proves the task exists and
    // carries the spend. Reconcilers only ever ask about tasks the ledger already has.
    const receipt = this.#ledger.receipt(input.taskId);
    return this.#store.recordObservation({
      ...input,
      receipt,
      reviewerVerdict: reviewerVerdictOf(receipt),
    });
  }
}

/**
 * The reviewer's verdict, snapshotted from whatever recorded it.
 *
 * A write review writes `write.review.<verdict>`; a read review's decision is the workflow's
 * outcome. Both are read, in that order, so the corpus records the decision that was made rather
 * than a guess. `null` means the task had no review, which is a different thing from a review that
 * approved.
 */
export function reviewerVerdictOf(receipt: TaskReceipt): DogfoodReviewerVerdict {
  const direct = writeVerdictFromEvents(receipt.events);
  if (direct !== null) return direct;
  const workflow = normalizeTaskReceipt(receipt).workflow;
  return workflow === null ? null : writeVerdictFromWorkflow(workflow.outcome as WorkflowOutcome);
}

/**
 * The finalizer for one project: the ledger, the project's result directory, and its corpus.
 *
 * Composed at the CLI edge because this is the only layer that may know all three stores at once.
 * An execution package that imported this would have to import the measurement store with it.
 */
export function projectFinalizer(input: { readonly project: RegisteredProject; readonly ledger: TaskLedger; readonly store: DogfoodStore }): TaskFinalizer {
  return createFinalizer({
    ledger: input.ledger,
    results: new ResultStore(input.project.storageDir, { redact: redactSecrets }),
    observations: new StoreObservationWriter(input.store, input.ledger),
  });
}

/** What the CLI reports about a finished task: the writer's own answer, not a second derivation. */
export interface RecordedOutcome {
  readonly outcome: TaskOutcome;
  readonly reviewStatus: FinalizationSnapshot["reviewStatus"];
  readonly failureKind: FailureKind | null;
  readonly basis: readonly string[];
  readonly reconciled: boolean;
  readonly observed: boolean;
}

/**
 * Reads the outcome a finalized task recorded.
 *
 * `null` means the task has no readable finalization marker yet — it is still running, or it was
 * interrupted before the record was written. That is deliberately not the same as `UNKNOWN`, which
 * is an outcome somebody derived and wrote down.
 */
export function recordedOutcomeOf(receipt: TaskReceipt): RecordedOutcome | null {
  const snapshot = finalizedSnapshotOf(receipt.events);
  if (snapshot === null) return null;
  return Object.freeze({
    outcome: snapshot.outcome,
    reviewStatus: snapshot.reviewStatus,
    failureKind: snapshot.failureKind,
    basis: snapshot.basis,
    reconciled: snapshot.reconciled,
    observed: true,
  });
}

/** Whether an outcome is something the operator can build on. */
export function isUsableOutcome(outcome: TaskOutcome): boolean {
  return outcome === "SUCCESS" || outcome === "PARTIAL";
}
