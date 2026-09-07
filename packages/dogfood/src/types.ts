import type { TaskClassification, TaskComplexity, TaskRisk, UsageRecord } from "@braingate/core";

export type DogfoodMode = "ask" | "write";
export type DogfoodOutcome = "success" | "partial" | "blocked" | "failed";
export type DogfoodReviewerVerdict = "approve" | "request_changes" | "disagree" | null;

export interface DogfoodRole {
  readonly role: "primary" | "reviewer" | "judge";
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
  readonly outcome: DogfoodOutcome;
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
  readonly runs: number;
  readonly feedback: number;
  readonly feedbackCoverage: number;
  readonly exactComplexityMatches: number;
  readonly complexityUnderpredictions: number;
  readonly complexityOverpredictions: number;
  readonly regressions: number;
  readonly outcomes: Readonly<Record<DogfoodOutcome, number>>;
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
