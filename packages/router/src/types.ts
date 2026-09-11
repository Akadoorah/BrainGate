import type { ExecutionBudget, TaskClassification } from "@braingate/core";

export type ModelRole = "scout" | "planner" | "coder" | "reviewer" | "judge" | "visual";
export type SpeedClass = "fast" | "balanced" | "deep";
export type QuotaState = "healthy" | "limited" | "unknown" | "exhausted";
export type IndependenceLevel = "cross-provider" | "different-model" | "fresh-session";

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
  /**
   * What a provider said about the pool, never what BrainGate inferred.
   *
   * Only a native statement can set this to anything but `unknown`; a stored status BrainGate
   * derived from its own traffic is history, not a reading, and acting on it means refusing to
   * dispatch a task on the strength of a number nobody measured.
   */
  readonly quotaState: QuotaState;
  /**
   * How full the pool's window looked the last time anyone saw it, 0–1.
   *
   * A hint, and labelled as one: it is anchored to `quotaObservedAt` and it never decays by
   * arithmetic, because BrainGate does not know the shape of a window it never measured.
   */
  readonly quotaHint: number | null;
  /** When that hint was seen, so a reader can decide for itself whether it is still interesting. */
  readonly quotaObservedAt: string | null;
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
  /** Defaults to cross-provider for backward-compatible strictness. */
  readonly level?: IndependenceLevel;
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
