/**
 * The outcome vocabularies, in one place.
 *
 * M19 separated three things that used to be one: the ledger *state* (where a task is in its
 * lifecycle), the operator *outcome* (what actually happened), and the *review status* (whether
 * the result was checked). They are related but not interchangeable, and collapsing them is how
 * a task came to be announced as "completed" when its provider had refused to run.
 *
 * Every list here is a runtime array with its type derived from it, so a validator and its type
 * cannot drift apart.
 */

export const TASK_STATES = ["created", "planned", "running", "verifying", "completed", "failed", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_COMPLEXITIES = ["T0", "T1", "T2", "T3", "T4"] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

export const TASK_RISKS = ["low", "medium", "high", "critical"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];

/** What the operator is told happened. Never a workflow's own vocabulary. */
export const TASK_OUTCOMES = ["SUCCESS", "PARTIAL", "FAILED", "BLOCKED", "INTERRUPTED", "UNKNOWN"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

/**
 * The stored vocabulary, which is the same six values in the casing the observation table uses.
 *
 * `unknown` exists so a reconciled task whose outcome cannot be derived is still *persisted* as
 * unknown rather than being filed as a failure it was not, or omitted from the record entirely.
 */
export const OBSERVATION_OUTCOMES = ["success", "partial", "blocked", "failed", "interrupted", "unknown"] as const;
export type ObservationOutcome = (typeof OBSERVATION_OUTCOMES)[number];

export const FAILURE_KINDS = [
  "provider-failed",
  "provider-unparseable",
  "provider-empty",
  "isolation-unavailable",
  "auth-unavailable",
  "routing-unavailable",
  "turns-exhausted",
  "timeout",
  "interrupted",
  "source-fingerprint-changed",
  "verification-failed",
  "review-blocked",
  "unknown",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Kept independent of the outcome: an unreviewed success is still a success. */
export const REVIEW_STATUSES = [
  "NOT_RUN",
  "APPROVED",
  "APPROVED_AFTER_REPAIR",
  "APPROVED_BY_JUDGE",
  "CHANGES_REQUESTED",
  "CHANGES_REQUESTED_PENDING",
  "DISAGREED",
  "UNKNOWN",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** The workflow engine's own outcomes, which describe the engine's path and not the result. */
export const WORKFLOW_OUTCOMES = [
  "completed_without_review",
  "approved",
  "approved_after_repair",
  "approved_by_judge",
  "repaired_needs_review",
  "blocked_changes_required",
  "blocked_disagreement",
] as const;
export type WorkflowOutcome = (typeof WORKFLOW_OUTCOMES)[number];

/**
 * Bumped when a derivation changes, so a snapshot taken under older rules is identifiable.
 *
 * A `task.finalized` snapshot records what BrainGate believed at the time; rendering always
 * re-derives from the canonical evidence, and a disagreement between the two is reported as an
 * integrity conflict rather than silently resolved.
 */
export const DERIVATION_VERSION = "2026-09-11.1";

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["completed", "failed", "cancelled"]);

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

function member<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

export function isTaskOutcome(value: string): value is TaskOutcome { return member(TASK_OUTCOMES, value); }
export function isTaskComplexity(value: string): value is TaskComplexity { return member(TASK_COMPLEXITIES, value); }
export function isTaskRisk(value: string): value is TaskRisk { return member(TASK_RISKS, value); }
export function isObservationOutcome(value: string): value is ObservationOutcome { return member(OBSERVATION_OUTCOMES, value); }
export function isFailureKind(value: string): value is FailureKind { return member(FAILURE_KINDS, value); }
export function isReviewStatus(value: string): value is ReviewStatus { return member(REVIEW_STATUSES, value); }
export function isWorkflowOutcome(value: string): value is WorkflowOutcome { return member(WORKFLOW_OUTCOMES, value); }

/** The same outcome in the casing the observation table stores. */
export function observationOutcomeFor(outcome: TaskOutcome): ObservationOutcome {
  return outcome.toLowerCase() as ObservationOutcome;
}

export function strictOutcomeFor(outcome: ObservationOutcome): TaskOutcome {
  return outcome.toUpperCase() as TaskOutcome;
}

/**
 * The six failure kinds that mean something went wrong rather than that judgement went against
 * the work. `review-blocked` and `interrupted` are outcomes of their own.
 */
export function strictOutcomeFromFailure(kind: FailureKind): TaskOutcome {
  if (kind === "review-blocked") return "BLOCKED";
  if (kind === "interrupted") return "INTERRUPTED";
  return "FAILED";
}

export function strictOutcomeFromWorkflow(outcome: WorkflowOutcome): TaskOutcome {
  switch (outcome) {
    case "completed_without_review":
    case "approved":
    case "approved_after_repair":
    case "approved_by_judge":
      return "SUCCESS";
    case "repaired_needs_review":
      return "PARTIAL";
    case "blocked_changes_required":
    case "blocked_disagreement":
      return "BLOCKED";
  }
}

/** The write reviewer's vocabulary, as a runtime list so a guard cannot drift from the type. */
export const WRITE_VERDICTS = Object.freeze(["approve", "request_changes", "disagree"] as const);
export type WriteVerdict = (typeof WRITE_VERDICTS)[number];

export function isWriteVerdict(value: unknown): value is WriteVerdict {
  return typeof value === "string" && (WRITE_VERDICTS as readonly string[]).includes(value);
}

/**
 * The reviewer's verdict, read from the ledger's own events.
 *
 * The ledger is the source of the decision; this reads the event kinds it already writes rather
 * than keeping a second copy, so a reconciler and a corpus adapter asking the same question cannot
 * answer it differently.
 */
export function writeVerdictFromEvents(events: readonly { readonly kind: string }[]): WriteVerdict | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const kind = events[index]!.kind;
    if (!kind.startsWith("write.review.")) continue;
    const verdict = kind.slice("write.review.".length);
    return isWriteVerdict(verdict) ? verdict : null;
  }
  return null;
}

/**
 * The verdict a workflow outcome implies.
 *
 * A read-path review does not write `write.review.*`; its decision is the workflow's own outcome,
 * which already distinguishes approval from a request for changes and from a disagreement. This
 * keeps a corpus snapshot of the verdict possible without inventing a second decision.
 */
export function writeVerdictFromWorkflow(outcome: WorkflowOutcome): WriteVerdict | null {
  switch (outcome) {
    case "approved":
    case "approved_after_repair":
    case "approved_by_judge":
      return "approve";
    case "repaired_needs_review":
    case "blocked_changes_required":
      return "request_changes";
    case "blocked_disagreement":
      return "disagree";
    case "completed_without_review":
      return null;
  }
}

export function strictOutcomeFromWrite(input: { readonly completed: boolean; readonly reviewRan: boolean; readonly verdict: WriteVerdict | null }): TaskOutcome {
  if (!input.completed) return "FAILED";
  if (!input.reviewRan) return "SUCCESS";
  // A review that ran and did not approve has not failed to execute; it blocked the change.
  return input.verdict === "approve" ? "SUCCESS" : "BLOCKED";
}

export interface OutcomeEvidence {
  readonly mode: "ask" | "write";
  /** The workflow receipt's outcome, when the run produced one. */
  readonly workflow: WorkflowOutcome | null;
  /** Whether a write produced a reviewable change that passed verification. */
  readonly writeCompleted: boolean;
  readonly writeReviewRan: boolean;
  readonly writeVerdict: WriteVerdict | null;
  readonly failureKind: FailureKind | null;
  readonly reconciled: boolean;
}

export interface DerivedOutcome {
  readonly outcome: TaskOutcome;
  readonly reviewStatus: ReviewStatus;
  /** Which recorded evidence the derivation used; stored so a reader can see the basis. */
  readonly basis: readonly string[];
}

export function deriveReviewStatus(evidence: OutcomeEvidence): ReviewStatus {
  if (evidence.workflow !== null) {
    switch (evidence.workflow) {
      case "completed_without_review": return "NOT_RUN";
      case "approved": return "APPROVED";
      case "approved_after_repair": return "APPROVED_AFTER_REPAIR";
      case "approved_by_judge": return "APPROVED_BY_JUDGE";
      case "repaired_needs_review": return "CHANGES_REQUESTED_PENDING";
      case "blocked_changes_required": return "CHANGES_REQUESTED";
      case "blocked_disagreement": return "DISAGREED";
    }
  }
  if (evidence.mode === "write" && evidence.writeReviewRan) {
    if (evidence.writeVerdict === "approve") return "APPROVED";
    if (evidence.writeVerdict === "request_changes") return "CHANGES_REQUESTED";
    if (evidence.writeVerdict === "disagree") return "DISAGREED";
    return "UNKNOWN";
  }
  if (evidence.mode === "write" && evidence.writeCompleted) return "NOT_RUN";
  return evidence.reconciled ? "UNKNOWN" : "NOT_RUN";
}

export function deriveOutcome(evidence: OutcomeEvidence): DerivedOutcome {
  const basis: string[] = [];
  if (evidence.failureKind !== null) basis.push(`failure:${evidence.failureKind}`);
  if (evidence.workflow !== null) basis.push("workflow.receipt");
  if (evidence.mode === "write" && evidence.writeCompleted) basis.push("write.changes");
  if (evidence.reconciled) basis.push("reconciled");

  let outcome: TaskOutcome;
  if (evidence.failureKind !== null) {
    // A live run that threw always failed, whatever kind of failure it was.
    outcome = strictOutcomeFromFailure(evidence.failureKind);
  } else if (evidence.workflow !== null) {
    outcome = strictOutcomeFromWorkflow(evidence.workflow);
  } else if (evidence.mode === "write" && evidence.writeCompleted) {
    outcome = strictOutcomeFromWrite({ completed: true, reviewRan: evidence.writeReviewRan, verdict: evidence.writeVerdict });
  } else {
    // Nothing recorded says what happened. For a reconciled task that is the honest answer; for
    // a live run it is unreachable, because a run either returns a receipt or throws.
    outcome = "UNKNOWN";
  }
  return Object.freeze({ outcome, reviewStatus: deriveReviewStatus(evidence), basis: Object.freeze(basis) });
}

/**
 * Which ledger state a strict outcome settles into.
 *
 * `null` means "do not transition": an UNKNOWN reconciled task is already terminal, and
 * inventing a state for it would be exactly the conflation M19 removed.
 *
 * A review that blocked work is `completed` on the read path — the run finished — and `failed`
 * on the write path, where the change is not ready for approval. The two surfaces differ today
 * and M19 records that difference rather than quietly changing it; blocked work is selected by
 * `--outcome BLOCKED`, never by `--state`.
 */
export function ledgerStateFor(outcome: TaskOutcome, mode: "ask" | "write"): TaskState | null {
  if (outcome === "UNKNOWN") return null;
  if (outcome === "SUCCESS" || outcome === "PARTIAL") return "completed";
  if (outcome === "BLOCKED") return mode === "ask" ? "completed" : "failed";
  return "failed";
}

/** Maps a BrainGate invariant code to the failure taxonomy, without interpreting provider text. */
export function failureKindFromCode(code: string): FailureKind {
  switch (code) {
    case "SHADOW_PROVIDER_FAILED":
    case "WRITE_PROVIDER_FAILED":
    case "VISUAL_PROVIDER_FAILED":
    case "SHADOW_PROVIDER_UNAVAILABLE":
    case "WRITE_PROVIDER_UNAVAILABLE":
      return "provider-failed";
    case "SHADOW_RESPONSE_INVALID":
    case "SHADOW_SHAPE_INVALID":
      return "provider-unparseable";
    case "SHADOW_RESPONSE_EMPTY":
      return "provider-empty";
    case "SHADOW_TIMEOUT":
      return "timeout";
    case "SHADOW_AUTH_REQUIRED":
    case "SHADOW_API_AUTH_DENIED":
    case "WRITE_SUBSCRIPTION_REQUIRED":
      return "auth-unavailable";
    case "SHADOW_CODEX_ISOLATION_REQUIRED":
    case "SHADOW_GROK_ISOLATION_REQUIRED":
    case "SHADOW_GROK_SANDBOX_NOT_APPLIED":
    case "SHADOW_PROFILE_UNSAFE":
    case "WRITE_PROFILE_UNSAFE":
    case "SHADOW_CAPABILITY_UNPROVEN":
    case "WRITE_CAPABILITY_UNPROVEN":
    case "SHADOW_VERSION_TOO_OLD":
    case "WRITE_VERSION_TOO_OLD":
    case "SHADOW_PROVIDER_BLOCKED":
    case "SHADOW_CODEX_ROLE_DENIED":
    case "SHADOW_GROK_ROLE_DENIED":
    case "SHADOW_CWD_ESCAPE":
      return "isolation-unavailable";
    case "ROUTE_NO_ELIGIBLE_MODEL":
    case "MODEL_CATALOG_EMPTY":
      return "routing-unavailable";
    case "WRITE_SCOPE_BLOCKED":
    case "WRITE_DIFF_TOO_LARGE":
    case "WRITE_CHANGESET_TOO_LARGE":
    case "WRITE_UNTRACKED_TOO_LARGE":
    case "WRITE_BINARY_UNTRACKED":
    case "WRITE_ARTIFACT_ALTERED":
    case "WRITE_SENSITIVE_PATH":
    case "WRITE_CONTROL_PATH":
    case "WRITE_PATH_INVALID":
    case "WRITE_PATH_ESCAPE":
    case "WRITE_SYMLINK_ESCAPE":
    case "WRITE_NO_CHANGES":
      return "verification-failed";
    case "SHADOW_SOURCE_MUTATED":
    case "WRITE_SOURCE_MUTATED":
      return "source-fingerprint-changed";
    default:
      return "unknown";
  }
}
