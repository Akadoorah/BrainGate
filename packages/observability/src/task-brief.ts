import {
  BrainGateInvariantError,
  type BudgetSnapshot,
  type ExecutionBudget,
  type RegisteredProject,
  type TaskClassification,
  type TaskEvent,
  type TaskLedger,
  type TaskReceipt,
  type TaskRecord,
  type UsageRecord,
} from "@braingate/core";
import type { RouteResult } from "@braingate/router";
import { redactSecrets } from "@braingate/security";
import type { WorkflowReceipt } from "@braingate/workflows";

const MAX_LABEL = 500;
const MAX_LIST = 50;

function sanitizeText(value: string, maxLength = MAX_LABEL): string {
  return redactSecrets(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeList(values: readonly string[], maxItems = MAX_LIST): readonly string[] {
  return Object.freeze(values.slice(0, maxItems).map((value) => sanitizeText(value, 240)).filter(Boolean));
}

export type ApprovalStatus = "not-required" | "pending" | "approved";

export interface TaskBriefRouteRole {
  readonly role: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly quotaPool: string;
  /**
   * What BrainGate believed about this pool when it chose this model.
   *
   * Recorded because a refusal is only explicable against it: "dispatched to a provider we thought
   * was fine" and "dispatched to a provider we knew was exhausted" are different incidents, and
   * without this the ledger cannot tell them apart after the fact.
   */
  readonly quotaState: string;
  readonly quotaHint: number | null;
  readonly quotaObservedAt: string | null;
  readonly rationale: readonly string[];
  /**
   * Why *this* candidate won, in the router's own terms: the tier it was judged at, its capability,
   * and whether a warm session or the previous worker decided it.
   *
   * `rationale` above is the request's, and `rejected` below is everyone else's. Between them they
   * answered "why not Codex?" and left "so why this one?" to be reconstructed from a score nobody
   * recorded — which is the question an operator actually asks of an automatic choice.
   */
  readonly selectedReasons: readonly string[];
  readonly fallbackCount: number;
  /** Who else could have taken this role, and what disqualified them. */
  readonly rejected: readonly {
    readonly providerId: string;
    readonly modelId: string;
    readonly reasons: readonly string[];
  }[];
}

export interface TaskBrief {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly classification: {
    readonly complexity: TaskClassification["complexity"];
    readonly risk: TaskClassification["risk"];
    readonly reasons: readonly string[];
    readonly sensitiveDomains: readonly string[];
    readonly ruleVersion: string;
  };
  readonly limits: {
    readonly maxProviderCalls: number;
    readonly maxConcurrentAgents: number;
    readonly maxReviewers: number;
    readonly maxRepairRounds: number;
    readonly maxCouncilRounds: number;
    readonly maxContextTokens: number;
  };
  readonly route: readonly TaskBriefRouteRole[];
  readonly context: {
    readonly memoryRecords: number;
    readonly explicitCandidates: number;
    readonly includedItems: number;
    readonly estimatedTokens: number;
    readonly truncatedItems: number;
    readonly sourceLabels: readonly string[];
  };
  readonly skills: {
    readonly loaded: readonly string[];
    readonly denied: readonly string[];
  };
  readonly permissions: {
    readonly executionProfile: string;
    readonly networkAllowed: boolean;
    readonly productionSecretsAllowed: false;
    readonly originalCheckoutWriteAllowed: false;
    readonly humanApprovalRequired: boolean;
    readonly humanApprovalStatus: ApprovalStatus;
  };
  readonly worktree: {
    readonly enabled: boolean;
    readonly taskWorktreeLabel: string | null;
  };
  readonly createdAt: string;
}

export interface BuildTaskBriefInput {
  readonly project: RegisteredProject;
  readonly task: TaskRecord;
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly routes?: readonly RouteResult[];
  readonly context: {
    readonly memoryRecords: number;
    readonly explicitCandidates: number;
    readonly includedItems: number;
    readonly estimatedTokens: number;
    readonly truncatedItems: number;
    readonly sourceLabels?: readonly string[];
  };
  readonly skills?: {
    readonly loaded?: readonly string[];
    readonly denied?: readonly string[];
  };
  readonly permissions: {
    readonly executionProfile: string;
    readonly networkAllowed: boolean;
    readonly humanApprovalStatus?: ApprovalStatus;
  };
  readonly worktree?: {
    readonly enabled: boolean;
    readonly taskWorktreeLabel?: string | null;
  };
  readonly createdAt?: string;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new BrainGateInvariantError("OBSERVABILITY_COUNT_INVALID", `${label} must be a non-negative integer.`);
  }
  return value;
}

/**
 * The router's own vocabulary ("coder") is not the one every other surface reading a route already
 * uses ("primary"): `dashboard-snapshot.ts` builds `/status`'s attribution from whichever of
 * `workflow.roles`, this brief's route, or the executed roles is present, and the first and third
 * already say "primary" (`ObservationRole`'s own `coder → primary` mapping in
 * `packages/shadow/src/dogfood.ts`). Before this phase a write task never had a brief, so its route
 * fell through to the executed roles and nobody noticed the mismatch; the write runner recording one
 * now would otherwise put a route with `role: "coder"` ahead of them and silently drop the row
 * `/status` looks for by the name "primary".
 */
const ROUTE_ROLE_LABEL: Readonly<Record<string, string>> = Object.freeze({ coder: "primary" });

/**
 * Reduces one routed role to what an operator asks when a route is questioned: who won, why they
 * won, and who else was in the running and why they were not.
 *
 * Exported — not merely used by `buildTaskBrief` — so a plan that has not run yet can carry the
 * same shape the ledger's task brief carries once it has. `/why` reads either one through this
 * function's output, which is what makes "before the run" and "after the run" describe the route
 * the same way rather than two renderings that can drift apart.
 */
export function routeRole(route: RouteResult): TaskBriefRouteRole {
  const selected = route.selected.model.definition;
  const runtime = route.selected.model.runtime;
  return Object.freeze({
    role: ROUTE_ROLE_LABEL[route.role] ?? route.role,
    providerId: sanitizeText(selected.providerId, 120),
    modelId: sanitizeText(selected.modelId, 200),
    quotaPool: sanitizeText(selected.quotaPool, 160),
    quotaState: sanitizeText(runtime.quotaState, 40),
    quotaHint: runtime.quotaHint === null ? null : Math.round(runtime.quotaHint * 1000) / 1000,
    quotaObservedAt: runtime.quotaObservedAt,
    rationale: sanitizeList(route.rationale, 12),
    selectedReasons: sanitizeList(route.selected.reasons, 8),
    fallbackCount: route.fallbacks.length,
    // The reasons a candidate lost are what turn "it chose Anthropic" into an explanation. They
    // were computed and dropped before this, so the only person who could answer "why not Codex?"
    // was the one who was not there to ask.
    rejected: Object.freeze(route.rejected.slice(0, 12).map((rejection) => Object.freeze({
      providerId: sanitizeText(rejection.model.providerId, 120),
      modelId: sanitizeText(rejection.model.modelId, 200),
      reasons: sanitizeList(rejection.reasons, 8),
    }))),
  });
}

export function buildTaskBrief(input: BuildTaskBriefInput): TaskBrief {
  if (input.task.projectId !== input.project.projectId) {
    throw new BrainGateInvariantError("OBSERVABILITY_PROJECT_MISMATCH", "Task brief project does not match the task project.");
  }
  if (input.classification.complexity !== input.task.complexity && input.task.complexity !== null) {
    throw new BrainGateInvariantError("OBSERVABILITY_CLASSIFICATION_MISMATCH", "Task complexity differs from the brief classification.");
  }
  if (input.classification.risk !== input.task.risk && input.task.risk !== null) {
    throw new BrainGateInvariantError("OBSERVABILITY_CLASSIFICATION_MISMATCH", "Task risk differs from the brief classification.");
  }

  const approvalRequired = input.budget.humanApprovalBeforeWrite;
  const approvalStatus = approvalRequired ? (input.permissions.humanApprovalStatus ?? "pending") : "not-required";
  if (!approvalRequired && input.permissions.humanApprovalStatus === "approved") {
    throw new BrainGateInvariantError("OBSERVABILITY_APPROVAL_INVALID", "Approval cannot be marked approved when the task does not require approval.");
  }

  return Object.freeze({
    schemaVersion: 1,
    taskId: input.task.taskId,
    projectId: input.project.projectId,
    title: sanitizeText(input.task.title, 300),
    classification: Object.freeze({
      complexity: input.classification.complexity,
      risk: input.classification.risk,
      reasons: sanitizeList(input.classification.reasons, 24),
      sensitiveDomains: sanitizeList(input.classification.sensitiveDomains, 12),
      ruleVersion: sanitizeText(input.classification.ruleVersion, 80),
    }),
    limits: Object.freeze({
      maxProviderCalls: input.budget.maxProviderCalls,
      maxConcurrentAgents: input.budget.maxConcurrentAgents,
      maxReviewers: input.budget.maxReviewers,
      maxRepairRounds: input.budget.maxRepairRounds,
      maxCouncilRounds: input.budget.maxCouncilRounds,
      maxContextTokens: input.budget.maxContextTokens,
    }),
    route: Object.freeze((input.routes ?? []).map(routeRole)),
    context: Object.freeze({
      memoryRecords: nonNegativeInteger(input.context.memoryRecords, "memoryRecords"),
      explicitCandidates: nonNegativeInteger(input.context.explicitCandidates, "explicitCandidates"),
      includedItems: nonNegativeInteger(input.context.includedItems, "includedItems"),
      estimatedTokens: nonNegativeInteger(input.context.estimatedTokens, "estimatedTokens"),
      truncatedItems: nonNegativeInteger(input.context.truncatedItems, "truncatedItems"),
      sourceLabels: sanitizeList(input.context.sourceLabels ?? [], 30),
    }),
    skills: Object.freeze({
      loaded: sanitizeList(input.skills?.loaded ?? [], 30),
      denied: sanitizeList(input.skills?.denied ?? [], 30),
    }),
    permissions: Object.freeze({
      executionProfile: sanitizeText(input.permissions.executionProfile, 80),
      networkAllowed: input.permissions.networkAllowed,
      productionSecretsAllowed: false as const,
      originalCheckoutWriteAllowed: false as const,
      humanApprovalRequired: approvalRequired,
      humanApprovalStatus: approvalStatus,
    }),
    worktree: Object.freeze({
      enabled: input.worktree?.enabled ?? false,
      taskWorktreeLabel: input.worktree?.taskWorktreeLabel === undefined || input.worktree.taskWorktreeLabel === null
        ? null
        : sanitizeText(input.worktree.taskWorktreeLabel, 240),
    }),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function recordTaskBrief(ledger: TaskLedger, brief: TaskBrief): void {
  const task = ledger.requireTask(brief.taskId);
  if (task.projectId !== brief.projectId) {
    throw new BrainGateInvariantError("OBSERVABILITY_PROJECT_MISMATCH", "Cannot persist a brief into another project's ledger.");
  }
  ledger.appendEvent(brief.taskId, "task.brief", brief);
}

export interface WorkflowReceiptSummary {
  readonly outcome: WorkflowReceipt["outcome"];
  readonly roles: readonly {
    readonly role: "planner" | "planner-2" | "primary" | "reviewer" | "judge";
    readonly providerId: string;
    readonly modelId: string;
    readonly quotaPool: string;
  }[];
  readonly eventKinds: readonly string[];
  readonly budget: BudgetSnapshot;
}

function roleSummary(role: "planner" | "planner-2" | "primary" | "reviewer" | "judge", candidate: WorkflowReceipt["primary"] | null) {
  if (candidate === null) return null;
  const definition = candidate.model.definition;
  return Object.freeze({
    role,
    providerId: sanitizeText(definition.providerId, 120),
    modelId: sanitizeText(definition.modelId, 200),
    quotaPool: sanitizeText(definition.quotaPool, 160),
  });
}

export function summarizeWorkflowReceipt(receipt: WorkflowReceipt): WorkflowReceiptSummary {
  const roles = [
    // First, because it is the decision the rest of the task follows from.
    roleSummary("planner", receipt.planner),
    // Named separately, so a receipt for a task that spent two subscriptions on the approach
    // says both rather than one.
    roleSummary("planner-2", receipt.secondPlanner),
    roleSummary("primary", receipt.primary),
    roleSummary("reviewer", receipt.reviewer),
    roleSummary("judge", receipt.judge),
  ].filter((value): value is NonNullable<typeof value> => value !== null);
  return Object.freeze({
    outcome: receipt.outcome,
    roles: Object.freeze(roles),
    eventKinds: sanitizeList(receipt.events.map((event) => event.kind), 50),
    budget: Object.freeze({ ...receipt.budget }),
  });
}

export function recordWorkflowReceipt(ledger: TaskLedger, taskId: string, receipt: WorkflowReceipt): WorkflowReceiptSummary {
  ledger.requireTask(taskId);
  const summary = summarizeWorkflowReceipt(receipt);
  ledger.appendEvent(taskId, "workflow.receipt", summary);
  return summary;
}

export interface NormalizedTaskReceipt {
  readonly task: TaskRecord;
  readonly eventKinds: readonly string[];
  readonly transitions: readonly { readonly from: string | null; readonly to: string | null; readonly at: string }[];
  readonly usage: readonly UsageRecord[];
  readonly brief: TaskBrief | null;
  readonly workflow: WorkflowReceiptSummary | null;
  /**
   * The events themselves, kept because a summary cannot answer "what did BrainGate finally decide
   * about this task" — that lives in the finalization marker's payload, and a reader that has only
   * the summary would have to derive a second answer.
   */
  readonly events: readonly TaskEvent[];
}

function looksLikeBrief(value: unknown): value is TaskBrief {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && typeof record.taskId === "string" && typeof record.projectId === "string";
}

function looksLikeWorkflow(value: unknown): value is WorkflowReceiptSummary {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.outcome === "string" && Array.isArray(record.roles) && typeof record.budget === "object";
}

function latestPayload<T>(events: readonly TaskEvent[], kind: string, guard: (value: unknown) => value is T): T | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === kind && guard(event.payload)) return event.payload;
  }
  return null;
}

export function normalizeTaskReceipt(receipt: TaskReceipt): NormalizedTaskReceipt {
  const brief = latestPayload(receipt.events, "task.brief", looksLikeBrief);
  const workflow = latestPayload(receipt.events, "workflow.receipt", looksLikeWorkflow);
  if (brief !== null && brief.projectId !== receipt.task.projectId) {
    throw new BrainGateInvariantError("OBSERVABILITY_PROJECT_MISMATCH", "Persisted task brief belongs to a different project.");
  }
  return Object.freeze({
    task: receipt.task,
    eventKinds: Object.freeze(receipt.events.map((event) => sanitizeText(event.kind, 120))),
    transitions: Object.freeze(receipt.events
      .filter((event) => event.fromState !== null || event.toState !== null)
      .map((event) => Object.freeze({ from: event.fromState, to: event.toState, at: event.occurredAt }))),
    usage: Object.freeze(receipt.usage.map((usage) => Object.freeze({ ...usage }))),
    brief,
    workflow,
    events: receipt.events,
  });
}
