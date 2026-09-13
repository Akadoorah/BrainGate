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
 * The class the goal's recorded state was classified under, read back off the findings.
 *
 * A goal does not carry a tier of its own, and inventing one would be a second classification to
 * keep in step with the first. What it carries is what its state *means*, and the reading is
 * deliberately coarse because its only job is to stop a follow-up falling through the floor.
 *
 * - **diagnosed** is T3. Something has been concluded and the next thing is to act on it; that is
 *   the shape of work the tier table gives a separate planning pass and a second opinion, and it is
 *   exactly the turn that used to be routed to a cheaper model and answered differently.
 * - Anything established or contested at all is T2: a follow-up to a goal with findings is not a
 *   lookup, whatever the sentence looks like, but it is not necessarily a change either.
 * - Nothing established is T0 — no floor. A follow-up to a question that was never answered
 *   inherits nothing, and pretending otherwise would buy a planner for a second question.
 */
export function inheritedComplexityFloor(state: GoalState): TaskComplexity {
  if (state.status === "diagnosed" || state.status === "implementing") return "T3";
  if (state.acceptedFindings.length > 0 || state.disputedFindings.length > 0) return "T2";
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
