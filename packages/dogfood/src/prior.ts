import { BrainGateInvariantError, type TaskClassification, type TaskComplexity, type TaskRisk } from "@braingate/core";
import type { AdaptiveClassification, DogfoodMode, DogfoodPrior } from "./types.js";

const COMPLEXITY: readonly TaskComplexity[] = ["T0", "T1", "T2", "T3", "T4"];
const RISK: readonly TaskRisk[] = ["low", "medium", "high", "critical"];

export interface PriorSample {
  readonly predictedComplexity: TaskComplexity;
  readonly predictedRisk: TaskRisk;
  readonly actualComplexity: TaskComplexity;
  readonly actualRisk: TaskRisk | null;
}

export function parseTaskComplexity(value: unknown): TaskComplexity {
  if (typeof value !== "string" || !COMPLEXITY.includes(value as TaskComplexity)) {
    throw new BrainGateInvariantError("DOGFOOD_COMPLEXITY_INVALID", "Complexity must be one of T0, T1, T2, T3, T4.");
  }
  return value as TaskComplexity;
}

export function parseTaskRisk(value: unknown): TaskRisk {
  if (typeof value !== "string" || !RISK.includes(value as TaskRisk)) {
    throw new BrainGateInvariantError("DOGFOOD_RISK_INVALID", "Risk must be one of low, medium, high, critical.");
  }
  return value as TaskRisk;
}

function percentileFloor<T extends string>(ordered: readonly T[], values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const ranks = values.map((value) => ordered.indexOf(value)).sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(ranks.length * 0.6) - 1);
  return ordered[ranks[index]!] ?? null;
}

export function emptyDogfoodPrior(mode: DogfoodMode): DogfoodPrior {
  return Object.freeze({
    mode,
    sampleSize: 0,
    complexityUnderpredictions: 0,
    riskSampleSize: 0,
    riskUnderpredictions: 0,
    complexityFloor: null,
    riskFloor: null,
    active: false,
    reasons: Object.freeze([]),
  });
}

export function deriveDogfoodPrior(mode: DogfoodMode, samples: readonly PriorSample[], minimumSamples = 3): DogfoodPrior {
  if (!Number.isInteger(minimumSamples) || minimumSamples < 3) {
    throw new BrainGateInvariantError("DOGFOOD_PRIOR_MINIMUM_INVALID", "Adaptive prior minimumSamples must be an integer of at least 3.");
  }
  const complexityUnder = samples.filter((sample) => COMPLEXITY.indexOf(sample.actualComplexity) > COMPLEXITY.indexOf(sample.predictedComplexity));
  const complexityRate = samples.length === 0 ? 0 : complexityUnder.length / samples.length;
  const complexityFloor = samples.length >= minimumSamples && complexityRate >= 0.6
    ? percentileFloor(COMPLEXITY, complexityUnder.map((sample) => sample.actualComplexity))
    : null;

  const riskSamples = samples.filter((sample): sample is PriorSample & { actualRisk: TaskRisk } => sample.actualRisk !== null);
  const riskUnder = riskSamples.filter((sample) => RISK.indexOf(sample.actualRisk) > RISK.indexOf(sample.predictedRisk));
  const riskRate = riskSamples.length === 0 ? 0 : riskUnder.length / riskSamples.length;
  const riskFloor = riskSamples.length >= minimumSamples && riskRate >= 0.6
    ? percentileFloor(RISK, riskUnder.map((sample) => sample.actualRisk))
    : null;

  const reasons: string[] = [];
  if (complexityFloor !== null) reasons.push(`project-history-complexity-floor:${complexityFloor}`);
  if (riskFloor !== null) reasons.push(`project-history-risk-floor:${riskFloor}`);
  return Object.freeze({
    mode,
    sampleSize: samples.length,
    complexityUnderpredictions: complexityUnder.length,
    riskSampleSize: riskSamples.length,
    riskUnderpredictions: riskUnder.length,
    complexityFloor,
    riskFloor,
    active: complexityFloor !== null || riskFloor !== null,
    reasons: Object.freeze(reasons),
  });
}

export function applyDogfoodPrior(predicted: TaskClassification, prior: DogfoodPrior): AdaptiveClassification {
  let complexity = predicted.complexity;
  let risk = predicted.risk;
  const reasons = [...predicted.reasons];

  if (prior.complexityFloor !== null && COMPLEXITY.indexOf(prior.complexityFloor) > COMPLEXITY.indexOf(complexity)) {
    complexity = prior.complexityFloor;
    reasons.push(`dogfood-floor:complexity:${complexity}`);
  }
  if (prior.riskFloor !== null && RISK.indexOf(prior.riskFloor) > RISK.indexOf(risk)) {
    risk = prior.riskFloor;
    reasons.push(`dogfood-floor:risk:${risk}`);
  }
  if (risk === "high" && COMPLEXITY.indexOf(complexity) < COMPLEXITY.indexOf("T3")) {
    complexity = "T3";
    reasons.push("dogfood-risk-floor-restored:T3");
  }
  if (risk === "critical" && complexity !== "T4") {
    complexity = "T4";
    reasons.push("dogfood-risk-floor-restored:T4");
  }

  const applied = complexity !== predicted.complexity || risk !== predicted.risk;
  const effective: TaskClassification = Object.freeze({
    ...predicted,
    complexity,
    risk,
    requiresScout: predicted.requiresScout || COMPLEXITY.indexOf(complexity) >= COMPLEXITY.indexOf("T2"),
    reasons: Object.freeze(reasons),
  });
  return Object.freeze({ predicted, effective, prior, applied });
}
