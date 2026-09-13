import type { TaskClassification, TaskComplexity, TaskRisk } from "@braingate/core";
import type { GoalState } from "./types.js";

const COMPLEXITY_ORDER: readonly TaskComplexity[] = ["T0", "T1", "T2", "T3", "T4"];
const RISK_ORDER: readonly TaskRisk[] = ["low", "medium", "high", "critical"];

function maxComplexity(a: TaskComplexity, b: TaskComplexity): TaskComplexity {
  return COMPLEXITY_ORDER[Math.max(COMPLEXITY_ORDER.indexOf(a), COMPLEXITY_ORDER.indexOf(b))]!;
}

function maxRisk(a: TaskRisk, b: TaskRisk): TaskRisk {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(a), RISK_ORDER.indexOf(b))]!;
}

/**
 * The tier a goal's recorded state has earned, which is a *floor* for the next turn and nothing more.
 *
 * The rule changed in M20.2, and the reason is that the M20.1 version ratcheted. It read a goal as
 * T3 from the moment it was `diagnosed`, and nothing ever lowered it: a goal stays diagnosed for as
 * long as it takes to finish, so ten follow-ups into an implementation the work was still being
 * budgeted as a fresh diagnosis — a planner and a second opinion for a turn that merely ran the
 * tests. Continuity without inflation means the floor reflects where the goal is *now*.
 *
 * So there are two ceilings, and both are deliberately below the tiers the classifier can reach on
 * a message's own evidence:
 *
 * - Findings or disputes put the floor at **T2**, never higher. A follow-up to a goal with findings
 *   is not a lookup — that is the failure this layer exists to fix — but having findings is not by
 *   itself a reason to buy a planner and an independent reviewer forever.
 * - Work in progress or blocked puts the floor at **T3**, never higher. Those two states mean the
 *   goal is mid-change or stuck, which is where a second opinion is genuinely owed.
 *
 * `T0` means "no floor at all", which is the honest reading of a goal whose first turn established
 * nothing: a follow-up to a question that was never answered inherits nothing.
 */
export function inheritedComplexityFloor(state: GoalState): TaskComplexity {
  // Stage first, because it is a statement about the goal that survives having no formally accepted
  // findings. A goal is `diagnosed` because a turn finished and concluded something; whether that
  // conclusion was recorded as a finding is a separate question, and a follow-up to a diagnosis is
  // not a lookup even when nobody has written the diagnosis down as a belief yet.
  if (state.status === "implementing" || state.status === "blocked") return "T3";
  if (state.status === "diagnosed") return "T2";
  const established = state.acceptedFindings.length > 0 || state.disputedFindings.length > 0;
  if (established) return "T2";
  return "T0";
}

/** A goal whose scope was a single stated file, or a root cause already pinned to a named cause. */
export function riskFloor(state: GoalState): TaskRisk {
  if (state.status === "blocked") return "medium";
  return "low";
}

/**
 * Applies a complexity floor to a classification.
 *
 * The shared half of {@link effectiveClassification}, for a caller that knows the floor but not the
 * goal behind it — a command-line surface is handed a tier by the session that owns the goal rather
 * than a copy of the goal model. One function so the session's plan line and the run's budget cannot
 * apply different rules.
 */
export function applyInheritedFloor(prompt: TaskClassification, floor: TaskComplexity): TaskClassification {
  const complexity = maxComplexity(prompt.complexity, floor);
  if (complexity === prompt.complexity) return prompt;
  return Object.freeze({ ...prompt, complexity, reasons: Object.freeze([...prompt.reasons, `goal-inherited-complexity:${floor}`]) });
}

export interface EffectiveClassification {
  /** What the prompt alone was classified as. Kept so a receipt can show both numbers. */
  readonly prompt: TaskClassification;
  /** What the work is actually budgeted as, after the goal it continues. */
  readonly effective: TaskClassification;
  readonly applied: boolean;
}

/**
 * A follow-up inherits the complexity of the goal it continues.
 *
 * This is the M20 classification invariant, and it is a floor rather than a formula on purpose.
 * The old code classified each turn's literal text in isolation, so "How would you implement the
 * proposed fix?" — eight words, no debug cue, no breadth cue — came out T1 and reached the
 * cheapest model, which then produced a different diagnosis. Nothing was wrong with the words; the
 * wrong thing was asking the words alone.
 *
 * Climbing is allowed and staying level is allowed. Falling is not: a short follow-up can never
 * spend less than the goal it is continuing, because the work is defined by the goal and not by
 * the sentence. `max` is the whole rule — the prompt's own tier still counts whenever it is higher,
 * so a follow-up that introduces new risk is budgeted for it.
 *
 * The same applies to risk, and for the same reason: a goal already sitting on auth or payments
 * work does not become low-risk because the next sentence is short.
 */
export function effectiveClassification(input: {
  readonly prompt: TaskClassification;
  readonly state: GoalState;
}): EffectiveClassification {
  const goalComplexity = inheritedComplexityFloor(input.state);
  const goalRisk = riskFloor(input.state);
  const complexity = maxComplexity(input.prompt.complexity, goalComplexity);
  const risk = maxRisk(input.prompt.risk, goalRisk);
  const reasons = [...input.prompt.reasons];
  if (complexity !== input.prompt.complexity) reasons.push(`goal-inherited-complexity:${goalComplexity}`);
  if (risk !== input.prompt.risk) reasons.push(`goal-inherited-risk:${goalRisk}`);
  if (complexity === input.prompt.complexity && risk === input.prompt.risk) reasons.push("goal-floor-met");

  return Object.freeze({
    prompt: input.prompt,
    effective: Object.freeze({ ...input.prompt, complexity, risk, reasons: Object.freeze(reasons) }),
    applied: complexity !== input.prompt.complexity || risk !== input.prompt.risk,
  });
}
