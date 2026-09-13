import type { GoalRecord, GoalState, GoalContext, HandoffPackage } from "./types.js";
import { MAX_HANDOFF_CHARS } from "./goal-state.js";

/** How much of the raw timeline travels beside the handoff. The state is compact; the thread is not. */
export const MAX_CONTEXT_TURNS = 4;
export const MAX_CONTEXT_TURN_CHARS = 1_500;

/**
 * Turns a goal into the package a worker is given.
 *
 * The wording is the requirement. A worker may disagree — that is the point of routing the same
 * goal to a second vendor — but it must disagree *visibly*, with evidence, rather than overwrite
 * what was established by not having read it. Saying that in the handoff is cheap; discovering it
 * afterwards cost a whole dogfood run.
 */
export function buildHandoffPackage(input: {
  readonly goal: GoalRecord;
  /** The work unit this handoff accompanies: what the operator just asked for. */
  readonly workUnit: string;
  /** `provider/model` this handoff is aimed at, when it is aimed at one. */
  readonly addressedTo?: string | null;
  /** Surfaces that already hold detail, so a worker looks rather than is told. */
  readonly evidenceRefs?: readonly string[];
}): HandoffPackage {
  return Object.freeze({
    goalId: input.goal.goalId,
    objective: input.goal.objective,
    status: input.goal.state.status,
    acceptedFindings: input.goal.state.acceptedFindings,
    secondaryFindings: input.goal.state.secondaryFindings,
    disputedFindings: input.goal.state.disputedFindings,
    openQuestions: input.goal.state.openQuestions,
    approvedScope: input.goal.state.approvedScope,
    filesChanged: input.goal.state.filesChanged,
    testsRun: input.goal.state.testsRun,
    nextAction: input.goal.state.nextAction,
    providerSessions: input.goal.state.providerSessions,
    addressedTo: input.addressedTo ?? null,
    workUnit: input.workUnit,
    evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])]),
  });
}

function bullets(values: readonly string[], empty: string): readonly string[] {
  return values.length === 0 ? [`- ${empty}`] : values.map((value) => `- ${value}`);
}

function findingLines(label: string, findings: readonly { readonly claim: string; readonly evidence: readonly string[]; readonly assertedBy: string }[]): readonly string[] {
  if (findings.length === 0) return [];
  const lines = [`${label}:`];
  for (const finding of findings) {
    lines.push(`- ${finding.claim}`);
    for (const item of finding.evidence) lines.push(`  evidence: ${item}`);
    lines.push(`  asserted by: ${finding.assertedBy}`);
  }
  return lines;
}

/**
 * The handoff, as the text a worker actually reads.
 *
 * A rendered form as well as a structured one, because the structured form travels inside the
 * payload's `context` field and a field is easy to skim past. This leads with the instruction that
 * makes the difference between continuing a goal and restarting it.
 */
export function renderHandoff(handoff: HandoffPackage): string {
  const lines: string[] = [
    `You are continuing BrainGate goal ${handoff.goalId}.`,
    "",
    `Goal: ${handoff.objective}`,
    `Status: ${handoff.status}`,
    "",
  ];

  const accepted = findingLines("Established (accepted)", handoff.acceptedFindings);
  if (accepted.length > 0) {
    lines.push(
      "These are the current best-supported conclusions. Treat them as state, not as a suggestion.",
      "Do not silently replace one. If you disagree, say so explicitly and give the new evidence.",
      "",
      ...accepted,
      "",
    );
  } else {
    lines.push("Nothing has been established about this goal yet.", "");
  }

  const secondary = findingLines("Also established, but not the root cause", handoff.secondaryFindings);
  if (secondary.length > 0) {
    lines.push(
      "These are real findings that were explicitly judged *not* to be the active cause. Do not",
      "promote one back to root cause without new evidence.",
      "",
      ...secondary,
      "",
    );
  }

  const disputed = findingLines("Disputed — claimed, but not established", handoff.disputedFindings);
  if (disputed.length > 0) {
    lines.push(
      "These contradict something already established and have not displaced it. If you think one",
      "of them is right, the evidence is what has to change, not the claim.",
      "",
      ...disputed,
      "",
    );
  }

  lines.push("Changes so far:", ...bullets(handoff.filesChanged, "no files have been changed"), "");
  lines.push("Tests so far:", ...bullets(handoff.testsRun, "no tests have been run"), "");
  lines.push("Approved scope:", ...bullets(handoff.approvedScope, "not yet scoped"), "");
  if (handoff.openQuestions.length > 0) lines.push("Open questions:", ...bullets(handoff.openQuestions, ""), "");
  if (handoff.nextAction !== null) lines.push(`Next action on record: ${handoff.nextAction}`, "");

  const sessions = handoff.providerSessions.filter((session) => session.resumeMode === "available");
  if (sessions.length > 0) {
    lines.push(
      "Native sessions on record:",
      ...sessions.map((session) => `- ${session.providerId}${session.modelId === null ? "" : `/${session.modelId}`}: ${session.sessionId}`),
      "",
    );
  }
  if (handoff.evidenceRefs.length > 0) {
    lines.push("Where the detail lives:", ...handoff.evidenceRefs.map((ref) => `- ${ref}`), "");
  }

  lines.push(
    "Your current task:",
    handoff.workUnit,
    "",
    "You are free to inspect the repository yourself. This handoff is context, not an instruction",
    "to trust the previous workers blindly.",
  );

  const text = lines.join("\n");
  return text.length > MAX_HANDOFF_CHARS
    ? `${text.slice(0, MAX_HANDOFF_CHARS)}\n…[handoff truncated by BrainGate]`
    : text;
}

/**
 * The provider-facing context object: three layers, not one transcript.
 *
 * Layer 1 is the recent exchange so a follow-up like "and the other one?" resolves. Layer 2 is the
 * handoff, which is what carries across a provider switch. Layer 3 names where the detail lives.
 * The task itself is not duplicated in here — it is the payload's own `task` field, which is why
 * this object can stay small on a turn where nothing has changed.
 */
export function buildGoalContext(input: {
  readonly goal: GoalRecord;
  readonly workUnit: string;
  readonly recentTurns: readonly { readonly request: string; readonly answer: string }[];
  readonly evidenceRefs?: readonly string[];
  readonly addressedTo?: string | null;
}): GoalContext {
  const handoff = buildHandoffPackage({
    goal: input.goal,
    workUnit: input.workUnit,
    ...(input.addressedTo === undefined ? {} : { addressedTo: input.addressedTo }),
    ...(input.evidenceRefs === undefined ? {} : { evidenceRefs: input.evidenceRefs }),
  });
  return Object.freeze({
    recentTurns: Object.freeze(input.recentTurns.slice(-MAX_CONTEXT_TURNS).map((turn) => Object.freeze({
      request: turn.request.slice(0, MAX_CONTEXT_TURN_CHARS),
      answer: turn.answer.slice(0, MAX_CONTEXT_TURN_CHARS),
    }))),
    handoff,
    evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])]),
  });
}

/** The state a handoff was built from, for a caller that wants to assert the two agree. */
export function stateOfHandoff(handoff: HandoffPackage): GoalState {
  return Object.freeze({
    status: handoff.status,
    acceptedFindings: handoff.acceptedFindings,
    secondaryFindings: handoff.secondaryFindings,
    disputedFindings: handoff.disputedFindings,
    openQuestions: handoff.openQuestions,
    approvedScope: handoff.approvedScope,
    filesChanged: handoff.filesChanged,
    testsRun: handoff.testsRun,
    nextAction: handoff.nextAction,
    providerSessions: handoff.providerSessions,
  });
}
