import type { RegisteredProject } from "./project-registry.js";
import { executionAttribution, recordedExecutionAttribution } from "./role-attribution.js";
import { finalizeTask, finalizedSnapshotOf, type FinalizationDeps, type FinalizationPlan, type ObservationRole, type ObservationRoleName } from "./finalization.js";
import {
  deriveOutcome,
  failureKindFromCode,
  isFailureKind,
  isTaskComplexity,
  isTaskRisk,
  isTerminalTaskState,
  isWorkflowOutcome,
  ledgerStateFor,
  writeVerdictFromEvents,
  type FailureKind,
  type OutcomeEvidence,
  type TaskComplexity,
  type TaskRisk,
} from "./task-outcome.js";
import type { TaskEvent, TaskReceipt, TaskRecord } from "./task-ledger.js";

/**
 * Finishing what a crash left unfinished.
 *
 * Three stores are involved and no transaction spans them, so reconciliation is the other half of
 * the ordered finalization: it appends whatever is missing, in the same order, and never updates
 * or deletes a row.
 *
 * Two recovery classes, distinguished by whether durable finalization evidence exists:
 *
 * - **partial finalization** — any artifact of finalization is present while the record is
 *   incomplete: a `task.finalized` marker on a non-terminal task, a `task.result` or an
 *   observation without the rest, or a terminal task missing any of them. Durability of any one
 *   of those proves the run is over, so this reconciles immediately, with no waiting.
 * - **stale non-terminal** — no finalization evidence at all, and the newest event is older than
 *   the bound. Only here can a run plausibly still be working, so only here is there a wait.
 *
 * The bound is derived, never authored: every provider call is killed by the executors at their
 * own ceiling, so a task with no event for a small multiple of that ceiling cannot be alive.
 */

export const STALE_CALL_MULTIPLIER = 3;

export interface ReconciliationDeps extends FinalizationDeps {
  /** `STALE_CALL_MULTIPLIER * MAX_PROVIDER_CALL_MS`, supplied by the caller that owns the ceiling. */
  readonly staleAfterMs: number;
}

export interface ReconciliationInspection {
  /** Tasks whose finalization is incomplete and whose run is provably over. */
  readonly partialFinalizations: readonly string[];
  /** Non-terminal tasks with no finalization evidence, past the stale bound. */
  readonly staleNonTerminal: readonly string[];
  /** How many tasks a reconciliation would change. Read-only commands only report this. */
  readonly required: number;
}

export interface ReconciliationReport extends ReconciliationInspection {
  readonly reconciled: readonly string[];
  readonly interrupted: readonly string[];
  readonly conflicts: readonly string[];
  readonly notes: readonly string[];
  readonly changed: boolean;
}

interface Candidate {
  readonly task: TaskRecord;
  readonly receipt: TaskReceipt;
  readonly kind: "partial" | "stale";
}

function payloadOf(event: TaskEvent): Record<string, unknown> | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function lastPayload(events: readonly TaskEvent[], kind: string): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.kind === kind) return payloadOf(events[index]!);
  }
  return null;
}

function payloads(events: readonly TaskEvent[], kind: string): readonly Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.kind !== kind) continue;
    const payload = payloadOf(event);
    if (payload !== null) found.push(payload);
  }
  return found;
}

function lastEventAt(events: readonly TaskEvent[], fallback: string): string {
  let latest = fallback;
  for (const event of events) if (event.occurredAt > latest) latest = event.occurredAt;
  return latest;
}

const ROLE_ALIASES: Readonly<Record<string, ObservationRoleName>> = Object.freeze({
  coder: "primary",
  primary: "primary",
  planner: "planner",
  reviewer: "reviewer",
  judge: "judge",
});

function pushRole(into: ObservationRole[], role: string, providerId: unknown, modelId: unknown, status?: ObservationRole["status"]): void {
  const mapped = ROLE_ALIASES[role];
  if (mapped === undefined) return;
  if (typeof providerId !== "string" || typeof modelId !== "string") return;
  if (into.some((entry) => entry.role === mapped && entry.providerId === providerId && entry.modelId === modelId)) return;
  into.push(Object.freeze({ role: mapped, providerId, modelId, ...(status === undefined ? {} : { status }) }));
}

/**
 * Which roles ran, from the evidence a run left behind.
 *
 * The recorded attribution is preferred when the run got as far as writing one: it distinguishes a
 * role that was planned from one that was attempted from one that answered, and a reconciler that
 * flattened those back into a bare list would be undoing exactly what the run recorded. Only when
 * there is no such record does this fall back to reading the brief, the provider start events, the
 * review event and the usage rows a write leaves — a list that can say who ran, but not how far each
 * got.
 *
 * A role list that cannot be known stays empty rather than being guessed — a reconciled
 * observation must be able to say "we do not know who ran" without pretending otherwise.
 */
function deriveRoles(events: readonly TaskEvent[], receipt: TaskReceipt): readonly ObservationRole[] {
  const recorded = recordedExecutionAttribution(events);
  if (recorded !== null && recorded.length > 0) return recorded;
  // What the plan and the non-provider evidence say about who took part. The statuses here are
  // conservative: the brief is a plan, while a review event and a `provider_call` usage row are only
  // written after the call they describe returned.
  const planned: ObservationRole[] = [];
  const route = lastPayload(events, "task.brief")?.route;
  if (Array.isArray(route)) {
    for (const entry of route) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      pushRole(planned, String(record.role), record.providerId, record.modelId);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!event.kind.startsWith("write.review.")) continue;
    const payload = payloadOf(event);
    if (payload !== null) pushRole(planned, "reviewer", payload.provider, payload.model, "completed");
    break;
  }
  for (const usage of receipt.usage) {
    if (usage.metric !== "provider_call" || usage.model === null) continue;
    pushRole(planned, "primary", usage.provider, usage.model, "completed");
    break;
  }
  // The provider events decide who actually ran and how far each got; the plan above fills in the
  // roles that were routed and never dispatched.
  return executionAttribution({ events, planned });
}

function failureKindFor(input: {
  readonly kind: Candidate["kind"];
  readonly terminalCode: string | null;
  readonly providerFailure: Record<string, unknown> | null;
  /** Whether the ledger still calls the task non-terminal, which means the run did not finish. */
  readonly runDidNotFinish: boolean;
}): FailureKind | null {
  if (input.providerFailure !== null) {
    // Payloads written by M19 or later carry the run's own classification; trust it first.
    const recorded = input.providerFailure.failureKind;
    if (typeof recorded === "string" && isFailureKind(recorded)) return recorded;
    const error = typeof input.providerFailure.error === "string" ? input.providerFailure.error : "";
    if (/parseable JSON|must have kind|invalid verdict/i.test(error)) return "provider-unparseable";
    if (input.providerFailure.timedOut === true) return "timeout";
    if (input.providerFailure.exitCode !== undefined) return "provider-failed";
  }
  if (input.terminalCode !== null) return failureKindFromCode(input.terminalCode);
  // Last, and only when nothing more specific was recorded: a run the ledger still calls
  // non-terminal did not finish, and that is a fact about the run rather than an inference.
  if (input.kind === "stale" || input.runDidNotFinish) return "interrupted";
  return null;
}

function planFor(project: RegisteredProject, candidate: Candidate): FinalizationPlan {
  const { task, receipt } = candidate;
  const events = receipt.events;
  const brief = lastPayload(events, "task.brief");
  const workflow = lastPayload(events, "workflow.receipt");
  const writeVerdict = writeVerdictFromEvents(events);
  const providerFailures = payloads(events, "shadow.provider.failed");
  const providerFailure = providerFailures.length === 0 ? null : providerFailures[providerFailures.length - 1]!;

  let terminalCode: string | null = null;
  let terminalState: string | null = null;
  for (const event of events) {
    if (event.toState === null) continue;
    terminalState = event.toState;
    const payload = payloadOf(event);
    terminalCode = payload !== null && typeof payload.code === "string" ? payload.code : null;
  }

  const mode: "ask" | "write" = events.some((event) => event.kind.startsWith("write.")) ? "write" : "ask";

  // A snapshot that already exists is not re-derived. The task was finalized and something after it
  // was lost — the observation, or only the terminal transition — and the recorded answer is the
  // answer. Deriving a second one here is how a task could end up with a marker saying SUCCESS and a
  // transition payload saying INTERRUPTED, which is worse than either.
  const alreadyRecorded = finalizedSnapshotOf(events);
  if (alreadyRecorded !== null) {
    const classification = brief?.classification;
    const asRecord = typeof classification === "object" && classification !== null ? classification as Record<string, unknown> : null;
    const complexity: TaskComplexity = typeof asRecord?.complexity === "string" && isTaskComplexity(asRecord.complexity)
      ? asRecord.complexity
      : (task.complexity ?? "T1");
    const risk: TaskRisk = typeof asRecord?.risk === "string" && isTaskRisk(asRecord.risk) ? asRecord.risk : (task.risk ?? "low");
    const ruleVersion = typeof asRecord?.ruleVersion === "string" ? asRecord.ruleVersion : "unknown";
    return Object.freeze({
      taskId: task.taskId,
      projectId: project.projectId,
      mode,
      outcome: alreadyRecorded.outcome,
      reviewStatus: alreadyRecorded.reviewStatus,
      failureKind: alreadyRecorded.failureKind,
      basis: Object.freeze([...alreadyRecorded.basis, "reconciliation:alreadyRecorded"]),
      result: Object.freeze({ kind: "none" as const, text: null, evidence: "unavailable" as const }),
      observation: Object.freeze({
        predicted: Object.freeze({ complexity, risk, ruleVersion }),
        effective: Object.freeze({ complexity, risk, ruleVersion }),
        roles: deriveRoles(events, receipt),
        prior: null,
      }),
      reconciled: true,
      // The state the marker says the task was settling into, when it still has to settle.
      ledgerState: alreadyRecorded.ledgerState ?? ledgerStateFor(alreadyRecorded.outcome, mode),
    });
  }

  // A task the ledger still calls non-terminal did not finish, whatever else survived: the run
  // stopped mid-record, and INTERRUPTED is the word for that. A *terminal* task with an incomplete
  // record is a different thing — an older BrainGate wrote `completed` and nothing else — and
  // nothing there says how it ended, so no failure kind is invented and the outcome derives as
  // UNKNOWN.
  const runDidNotFinish = !isTerminalTaskState(task.state);
  const unsettled = terminalState === "failed" || candidate.kind === "stale" || runDidNotFinish;
  const failureKind = unsettled ? failureKindFor({ kind: candidate.kind, terminalCode, providerFailure, runDidNotFinish }) : null;

  const workflowOutcome = workflow !== null && typeof workflow.outcome === "string" && isWorkflowOutcome(workflow.outcome)
    ? workflow.outcome
    : null;
  const evidence: OutcomeEvidence = Object.freeze({
    mode,
    workflow: workflowOutcome,
    writeCompleted: payloads(events, "write.changes_collected").length > 0,
    writeReviewRan: writeVerdict !== null,
    writeVerdict,
    failureKind,
    reconciled: true,
  });
  const derived = deriveOutcome(evidence);

  // A reconciled run cannot know what classification it was given, so the task row's own values
  // stand in, and `ruleVersion: "unknown"` records that they are not the classifier's output.
  const classification = brief?.classification;
  const recorded = typeof classification === "object" && classification !== null ? classification as Record<string, unknown> : null;
  const complexity: TaskComplexity = typeof recorded?.complexity === "string" && isTaskComplexity(recorded.complexity)
    ? recorded.complexity
    : (task.complexity ?? "T1");
  const risk: TaskRisk = typeof recorded?.risk === "string" && isTaskRisk(recorded.risk) ? recorded.risk : (task.risk ?? "low");
  const ruleVersion = typeof recorded?.ruleVersion === "string" ? recorded.ruleVersion : "unknown";

  return Object.freeze({
    taskId: task.taskId,
    projectId: project.projectId,
    mode,
    outcome: derived.outcome,
    reviewStatus: derived.reviewStatus,
    failureKind,
    basis: Object.freeze([...derived.basis, "reconciliation"]),
    // Result text cannot be reconstructed; an orphan artifact, if one survives, is adopted by
    // `finalizeTask` from the task's own result directory.
    result: Object.freeze({
      kind: "none" as const,
      text: null,
      evidence: candidate.kind === "stale" ? ("lost-to-crash" as const) : ("unavailable" as const),
    }),
    observation: Object.freeze({
      predicted: Object.freeze({ complexity, risk, ruleVersion }),
      effective: Object.freeze({ complexity, risk, ruleVersion }),
      roles: deriveRoles(events, receipt),
      prior: null,
    }),
    reconciled: true,
    ledgerState: ledgerStateFor(derived.outcome, mode),
  });
}

function classify(deps: ReconciliationDeps, now: Date): readonly Candidate[] {
  const found: Candidate[] = [];
  for (const task of deps.ledger.listTasks()) {
    const receipt = deps.ledger.receipt(task.taskId);
    const hasClaim = lastPayload(receipt.events, "task.result") !== null;
    const hasMarker = lastPayload(receipt.events, "task.finalized") !== null;
    const hasObservation = deps.observations.find(task.taskId) !== null;
    // The result *file* counts as evidence too, and it is the one piece with no event to announce
    // it: a run that wrote its answer and died before recording it leaves a task that looks
    // untouched. Without this the artifact would sit in the project's storage valid and
    // unreferenced, and inspection would report that nothing was waiting.
    const hasArtifact = !hasClaim && deps.results.locate(task.taskId).valid.length > 0;
    const hasResult = hasClaim || hasArtifact;
    // The attribution is written in the run's own `finally`, immediately before the record is
    // completed, so its presence says the work is over even when nothing after it was written. It is
    // treated like the other partial evidence — repaired at once, with the same idempotent finalizer
    // and the same lost-race tolerance — rather than waiting out the stale bound, which would leave a
    // finished run's attribution unrecorded for the length of the bound.
    const hasAttribution = lastPayload(receipt.events, "task.execution") !== null;
    const complete = hasClaim && hasMarker && hasObservation;

    if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
      if (!complete) found.push({ task, receipt, kind: "partial" });
      continue;
    }
    if (hasResult || hasMarker || hasObservation || hasAttribution) {
      // Finalization began, so the run is over whatever the state row still says.
      found.push({ task, receipt, kind: "partial" });
      continue;
    }
    const last = Date.parse(lastEventAt(receipt.events, task.updatedAt));
    if (Number.isFinite(last) && now.getTime() - last > deps.staleAfterMs) found.push({ task, receipt, kind: "stale" });
  }
  return Object.freeze(found);
}

export function inspectReconciliation(deps: ReconciliationDeps, now = new Date()): ReconciliationInspection {
  const candidates = classify(deps, now);
  return Object.freeze({
    partialFinalizations: Object.freeze(candidates.filter((entry) => entry.kind === "partial").map((entry) => entry.task.taskId)),
    staleNonTerminal: Object.freeze(candidates.filter((entry) => entry.kind === "stale").map((entry) => entry.task.taskId)),
    required: candidates.length,
  });
}

export function reconcile(project: RegisteredProject, deps: ReconciliationDeps, now = new Date()): ReconciliationReport {
  const candidates = classify(deps, now);
  const reconciled: string[] = [];
  const interrupted: string[] = [];
  const conflicts: string[] = [];
  const notes: string[] = [];

  for (const candidate of candidates) {
    const plan = planFor(project, candidate);
    const record = finalizeTask(deps, plan);
    reconciled.push(candidate.task.taskId);
    if (candidate.kind === "stale" || plan.failureKind === "interrupted") interrupted.push(candidate.task.taskId);
    conflicts.push(...record.conflicts.map((entry) => `${candidate.task.taskId}:${entry}`));
    notes.push(...record.notes.map((entry) => `${candidate.task.taskId}:${entry}`));
  }

  return Object.freeze({
    partialFinalizations: Object.freeze(candidates.filter((entry) => entry.kind === "partial").map((entry) => entry.task.taskId)),
    staleNonTerminal: Object.freeze(candidates.filter((entry) => entry.kind === "stale").map((entry) => entry.task.taskId)),
    required: candidates.length,
    reconciled: Object.freeze(reconciled),
    interrupted: Object.freeze(interrupted),
    conflicts: Object.freeze(conflicts),
    notes: Object.freeze(notes),
    changed: reconciled.length > 0,
  });
}
