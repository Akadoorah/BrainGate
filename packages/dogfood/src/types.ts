import type { FailureKind, ObservationOutcome, TaskClassification, TaskComplexity, TaskRisk, UsageRecord } from "@braingate/core";

export type DogfoodMode = "ask" | "write";
/**
 * The observation vocabulary, which is core's — not a second spelling of it.
 *
 * A run records one of core's `OBSERVATION_OUTCOMES`, so the words the ledger and the operator use
 * and the words the corpus uses cannot drift apart. The two gaps a four-word vocabulary could not
 * express — a run that was interrupted, one that recorded nothing at all — are what this milestone
 * exists to make nameable.
 */
export type DogfoodOutcome = ObservationOutcome;
/**
 * What the operator asserts later about a run's real outcome.
 *
 * Narrower than `DogfoodOutcome` on purpose: a human judging a task after the fact is judging
 * whether the work got done, and "interrupted" and "unknown" describe the *record* rather than the
 * work. Keeping the two apart is what lets `dogfood_runs.outcome` widen without turning the
 * feedback table's CHECK constraint into a claim about a run that has no answer.
 */
export type DogfoodFeedbackOutcome = "success" | "partial" | "blocked" | "failed";
export type DogfoodReviewerVerdict = "approve" | "request_changes" | "disagree" | null;

export interface DogfoodRole {
  readonly role: "planner" | "primary" | "reviewer" | "judge";
  readonly providerId: string;
  readonly modelId: string;
}

export interface DogfoodPrior {
  readonly mode: DogfoodMode;
  readonly sampleSize: number;
  readonly complexityUnderpredictions: number;
  readonly riskSampleSize: number;
  readonly riskUnderpredictions: number;
  readonly complexityFloor: TaskComplexity | null;
  readonly riskFloor: TaskRisk | null;
  readonly active: boolean;
  readonly reasons: readonly string[];
}

export interface AdaptiveClassification {
  readonly predicted: TaskClassification;
  readonly effective: TaskClassification;
  readonly prior: DogfoodPrior;
  readonly applied: boolean;
}

export interface DogfoodUsage {
  readonly provider: string;
  readonly model: string | null;
  readonly evidence: UsageRecord["evidence"];
  readonly metric: string;
  readonly value: number | null;
  readonly unit: string | null;
}

export interface DogfoodRunRecord {
  readonly sequence: number;
  readonly projectId: string;
  readonly taskId: string;
  readonly mode: DogfoodMode;
  readonly predictedComplexity: TaskComplexity;
  readonly predictedRisk: TaskRisk;
  readonly effectiveComplexity: TaskComplexity;
  readonly effectiveRisk: TaskRisk;
  readonly ruleVersion: string;
  readonly roles: readonly DogfoodRole[];
  readonly outcome: DogfoodOutcome;
  /** Why the run failed, in the taxonomy the ledger uses; null when nothing failed. */
  readonly failureKind: FailureKind | null;
  /**
   * Whether this record was reconstructed after the fact rather than written by the run itself.
   *
   * A reconciled run is not evidence about anything a fresh routing decision would ask: its roles
   * and its use of a prior are reconstructions, not measurements. It is counted, and counted apart.
   */
  readonly reconciled: boolean;
  readonly reviewerVerdict: DogfoodReviewerVerdict;
  readonly usage: readonly DogfoodUsage[];
  readonly prior: DogfoodPrior;
  readonly observedAt: string;
}

export interface DogfoodFeedbackRecord {
  readonly sequence: number;
  readonly projectId: string;
  readonly taskId: string;
  readonly actualComplexity: TaskComplexity;
  readonly actualRisk: TaskRisk | null;
  readonly outcome: DogfoodFeedbackOutcome;
  readonly regression: boolean;
  readonly recordedAt: string;
}

export interface DogfoodProviderSummary {
  readonly role: DogfoodRole["role"];
  readonly providerId: string;
  readonly modelId: string;
  readonly runs: number;
}

export interface DogfoodReport {
  readonly projectId: string;
  /** Every run in the corpus, including the ones reconciled after the fact. */
  readonly runs: number;
  /** Runs that were observed as they happened; the only rows `outcomes` and `priors` count. */
  readonly observedRuns: number;
  readonly reconciledRuns: number;
  readonly feedback: number;
  readonly feedbackCoverage: number;
  readonly exactComplexityMatches: number;
  readonly complexityUnderpredictions: number;
  readonly complexityOverpredictions: number;
  readonly regressions: number;
  /** Outcomes of live runs only. */
  readonly outcomes: Readonly<Record<DogfoodOutcome, number>>;
  /** Outcomes of reconciled runs, kept apart so the two are never added together by accident. */
  readonly reconciledOutcomes: Readonly<Record<DogfoodOutcome, number>>;
  readonly reviewerVerdicts: Readonly<Record<"approve" | "request_changes" | "disagree" | "none", number>>;
  readonly providers: readonly DogfoodProviderSummary[];
  readonly priors: Readonly<{ ask: DogfoodPrior; write: DogfoodPrior }>;
}

export interface DogfoodRegressionRecord {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly taskId: string;
  readonly mode: DogfoodMode;
  readonly predictedComplexity: TaskComplexity;
  readonly effectiveComplexity: TaskComplexity;
  readonly actualComplexity: TaskComplexity;
  readonly predictedRisk: TaskRisk;
  readonly effectiveRisk: TaskRisk;
  readonly actualRisk: TaskRisk | null;
  readonly outcome: DogfoodOutcome;
  readonly reviewerVerdict: DogfoodReviewerVerdict;
  readonly roles: readonly DogfoodRole[];
  readonly feedbackRecordedAt: string;
}
