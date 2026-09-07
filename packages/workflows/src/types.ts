import type { BudgetSnapshot, ExecutionBudget, TaskClassification } from "@braingate/core";
import type { ModelRef, RouteCandidate } from "@braingate/router";

export type WorkflowRole = "primary" | "reviewer" | "judge";
export type ReviewVerdict = "approve" | "request_changes" | "disagree";
export type JudgeVerdict = "approve" | "request_changes";

export interface AgentRequest {
  readonly role: WorkflowRole;
  readonly model: ModelRef;
  readonly phase: string;
  readonly task: string;
  readonly findings: readonly string[];
}

export type AgentResponse =
  | { readonly kind: "work"; readonly output: string }
  | { readonly kind: "review"; readonly verdict: ReviewVerdict; readonly findings: readonly string[] }
  | { readonly kind: "judge"; readonly verdict: JudgeVerdict; readonly rationale: string; readonly findings: readonly string[] };

export interface AgentInvoker {
  invoke(request: AgentRequest): Promise<AgentResponse>;
}

export interface WorkflowEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly role: WorkflowRole | null;
  readonly model: ModelRef | null;
  readonly detail: string;
}

export type WorkflowOutcome =
  | "completed_without_review"
  | "approved"
  | "approved_after_repair"
  | "approved_by_judge"
  | "repaired_needs_review"
  | "blocked_disagreement"
  | "blocked_changes_required";

export interface WorkflowReceipt {
  readonly outcome: WorkflowOutcome;
  readonly primary: RouteCandidate;
  readonly reviewer: RouteCandidate | null;
  readonly judge: RouteCandidate | null;
  readonly events: readonly WorkflowEvent[];
  readonly budget: BudgetSnapshot;
  readonly finalOutput: string;
}

export interface WorkflowInput {
  readonly task: string;
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly writeRequired: boolean;
  readonly optionalReview: boolean;
  readonly excludeProviders?: Readonly<Partial<Record<WorkflowRole, readonly string[]>>>;
}
