import type { ConversationTurn, Finding, GoalRecord, GoalState } from "./types.js";
import { compareFindings } from "./delta-findings.js";

/**
 * What happened on a goal while one particular worker was not looking.
 *
 * The problem this solves is narrow and real. A resumed native session already remembers its own
 * previous turns, so sending it the whole goal state again is not merely wasteful — it is
 * misleading, because it reads as "here is everything", which invites a worker to re-derive what it
 * already concluded. What a returning worker cannot know is what the *other* workers did in the
 * meantime, and that is all this carries.
 *
 * Bounded like every other context layer: a delta that grows with the conversation is the failure
 * mode it exists to prevent.
 */
export const MAX_DELTA_TURNS = 6;
export const MAX_DELTA_TURN_CHARS = 600;
export const MAX_DELTA_CHANGES = 8;
export const MAX_DELTA_CHARS = 4_000;

export interface GoalDelta {
  readonly goalId: string;
  /** Which worker the delta is for, as `provider/model`. `null` when it is for a new worker. */
  readonly sinceWorker: string | null;
  /** How much of the timeline the delta covers, or `null` when nothing has happened since. */
  readonly sinceSequence: number | null;
  /** Turns another worker took while this one was inactive. */
  readonly turns: readonly { readonly request: string; readonly answer: string; readonly attributedTo: readonly string[] }[];
  readonly acceptedAdded: readonly Finding[];
  readonly secondaryAdded: readonly Finding[];
  readonly disputedAdded: readonly Finding[];
  readonly filesChanged: readonly string[];
  readonly testsRun: readonly string[];
  readonly statusChangedFrom: GoalState["status"] | null;
  readonly statusChangedTo: GoalState["status"] | null;
  readonly openQuestionsAdded: readonly string[];
  readonly nextAction: string | null;
  /** True when there is genuinely nothing to report. */
  readonly empty: boolean;
}

function fresh(findings: readonly Finding[], previous: readonly Finding[] | null): readonly Finding[] {
  if (previous === null) return Object.freeze([]);
  const known = new Set(previous.map((finding) => finding.findingId));
  return Object.freeze(findings.filter((finding) => !known.has(finding.findingId)));
}

/**
 * The delta between two readings of a goal.
 *
 * `previous` may be `null`, and that is not an error: it means the worker has no recorded prior
 * view of this goal — a session that was pinned but whose run never finished, say. A delta with no
 * baseline cannot claim what is new, so it reports nothing rather than reporting everything, and
 * the caller falls back to the ordinary handoff.
 */
export function computeGoalDelta(input: {
  readonly goal: GoalRecord;
  readonly previous: GoalState | null;
  readonly turns: readonly ConversationTurn[];
  readonly sinceSequence: number | null;
  readonly sinceWorker: string | null;
}): GoalDelta {
  const { goal, previous } = input;
  const state = goal.state;
  const turns = input.turns
    .filter((turn) => input.sinceSequence === null || turn.sequence > input.sinceSequence)
    .slice(-MAX_DELTA_TURNS)
    .map((turn) => Object.freeze({
      request: turn.request.slice(0, MAX_DELTA_TURN_CHARS),
      answer: turn.answer.slice(0, MAX_DELTA_TURN_CHARS),
      attributedTo: turn.attributedTo,
    }));

  const previousState = previous;
  const acceptedAdded = compareFindings(state.acceptedFindings, previousState?.acceptedFindings ?? null);
  const secondaryAdded = compareFindings(state.secondaryFindings, previousState?.secondaryFindings ?? null);
  const disputedAdded = compareFindings(state.disputedFindings, previousState?.disputedFindings ?? null);
  const filesChanged = difference(state.filesChanged, previousState?.filesChanged ?? null);
  const testsRun = difference(state.testsRun, previousState?.testsRun ?? null);
  const openQuestionsAdded = difference(state.openQuestions, previousState?.openQuestions ?? null);
  const statusChanged = previousState !== null && previousState.status !== state.status;

  const empty = turns.length === 0
    && acceptedAdded.length === 0 && secondaryAdded.length === 0 && disputedAdded.length === 0
    && filesChanged.length === 0 && testsRun.length === 0 && openQuestionsAdded.length === 0
    && !statusChanged;

  return Object.freeze({
    goalId: goal.goalId,
    sinceWorker: input.sinceWorker,
    sinceSequence: input.sinceSequence,
    turns: Object.freeze(turns),
    acceptedAdded,
    secondaryAdded,
    disputedAdded,
    filesChanged,
    testsRun,
    statusChangedFrom: statusChanged ? previousState!.status : null,
    statusChangedTo: statusChanged ? state.status : null,
    openQuestionsAdded,
    nextAction: state.nextAction,
    empty,
  });
}

function difference(current: readonly string[], previous: readonly string[] | null): readonly string[] {
  if (previous === null) return Object.freeze([]);
  const known = new Set(previous);
  return Object.freeze(current.filter((item) => !known.has(item)).slice(0, MAX_DELTA_CHANGES));
}

/**
 * The delta as the worker reads it.
 *
 * Written in the second person and about *other workers*, because that is the only framing in which
 * the content is new to the reader. A resumed session that is told "accepted findings: X" when it
 * is the one that established X has been told nothing and has been given a reason to re-examine its
 * own conclusion.
 */
export function renderGoalDelta(delta: GoalDelta, workUnit: string): string {
  const lines: string[] = [];
  if (delta.sinceWorker !== null) {
    lines.push(`Your native session is continuing. Here is what happened in BrainGate goal ${delta.goalId.slice(0, 8)} since your last turn — nothing else about this goal has changed.`);
  } else {
    lines.push(`There is no prior native session to continue. Here is what happened in BrainGate goal ${delta.goalId.slice(0, 8)} since the last recorded turn.`);
  }
  lines.push("");

  if (delta.turns.length > 0) {
    lines.push("Since then:");
    for (const turn of delta.turns) {
      const who = turn.attributedTo.length === 0 ? "another worker" : turn.attributedTo.join(", ");
      lines.push(`- ${who} was asked: ${turn.request}`);
      lines.push(`  and answered: ${turn.answer}`);
    }
    lines.push("");
  }

  const changes: string[] = [];
  for (const finding of delta.acceptedAdded) changes.push(`a new accepted finding was recorded: ${finding.claim}`);
  for (const finding of delta.secondaryAdded) changes.push(`a new secondary finding was recorded: ${finding.claim}`);
  for (const finding of delta.disputedAdded) changes.push(`a contrary claim was recorded and did NOT displace an accepted finding: ${finding.claim}`);
  for (const file of delta.filesChanged) changes.push(`a file was changed: ${file}`);
  for (const test of delta.testsRun) changes.push(`a test was run: ${test}`);
  for (const question of delta.openQuestionsAdded) changes.push(`a new open question was recorded: ${question}`);

  if (changes.length === 0) {
    lines.push("No findings, files, tests or questions changed in that time.");
  } else {
    lines.push("Changes to the established state:");
    for (const change of changes) lines.push(`- ${change}`);
  }
  lines.push("");

  if (delta.statusChangedFrom !== null && delta.statusChangedTo !== null) {
    lines.push(`Goal status moved from ${delta.statusChangedFrom} to ${delta.statusChangedTo}.`, "");
  }

  lines.push("Your current task:", workUnit, "");
  lines.push(
    "This is a delta, not a summary. Do not restate or re-derive the work you already did in this",
    "session; continue from it. If you believe an established finding is wrong, say so explicitly",
    "and give the new evidence.",
  );

  const text = lines.join("\n");
  return text.length > MAX_DELTA_CHARS ? `${text.slice(0, MAX_DELTA_CHARS)}\n…[delta truncated by BrainGate]` : text;
}

/** A stable, compact rendering for a receipt line: one sentence, no content. */
export function describeGoalDelta(delta: GoalDelta): string {
  if (delta.empty) return "nothing changed since that session was last used";
  const parts: string[] = [];
  if (delta.turns.length > 0) parts.push(`${String(delta.turns.length)} turn(s) by another worker`);
  const findings = delta.acceptedAdded.length + delta.secondaryAdded.length + delta.disputedAdded.length;
  if (findings > 0) parts.push(`${String(findings)} finding(s) changed`);
  if (delta.filesChanged.length > 0) parts.push(`${String(delta.filesChanged.length)} file(s) changed`);
  if (delta.testsRun.length > 0) parts.push(`${String(delta.testsRun.length)} test(s) run`);
  if (delta.statusChangedTo !== null) parts.push(`status now ${delta.statusChangedTo}`);
  return parts.join(" · ");
}
