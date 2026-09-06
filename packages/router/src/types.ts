import type { ExecutionBudget, TaskClassification } from "@braingate/core";

export type ModelRole = "scout" | "planner" | "coder" | "reviewer" | "judge" | "visual";
export type SpeedClass = "fast" | "balanced" | "deep";
export type QuotaState = "healthy" | "limited" | "unknown" | "exhausted";

export interface ModelDefinition {
  readonly providerId: string;
  readonly modelId: string;
  readonly quotaPool: string;
  readonly capabilities: Readonly<Partial<Record<ModelRole, number>>>;
  readonly speed: SpeedClass;
  readonly contextCapacity: number;
  readonly writeCapable: boolean;
  readonly reasoning: number;
  readonly underlyingFamily: string | null;
}

export interface ModelRuntime {
  readonly available: boolean;
  readonly quotaState: QuotaState;
  readonly quotaPressure: number | null;
  readonly observedAt: string;
}

export interface RegisteredModel {
  readonly definition: ModelDefinition;
  readonly runtime: ModelRuntime;
}

export interface ModelRef {
  readonly providerId: string;
  readonly modelId: string;
  readonly quotaPool: string;
}

export interface IndependenceConstraint {
  readonly models: readonly ModelRef[];
  readonly mode: "required" | "preferred";
}

export interface RouteRequest {
  readonly role: ModelRole;
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly writeRequired: boolean;
  readonly independence?: IndependenceConstraint;
  readonly excludeProviders?: readonly string[];
  readonly maxFallbacks?: number;
}

export interface RouteCandidate {
  readonly model: RegisteredModel;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface RouteRejection {
  readonly model: ModelRef;
  readonly reasons: readonly string[];
}

export interface RouteResult {
  readonly role: ModelRole;
  readonly selected: RouteCandidate;
  readonly fallbacks: readonly RouteCandidate[];
  readonly rejected: readonly RouteRejection[];
  readonly rationale: readonly string[];
}
