import { BrainGateInvariantError } from "@braingate/core";
import type { ExecutionBudget, RegisteredProject, TaskClassification } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type ModelRef, type RouteResult } from "@braingate/router";
import {
  assertShadowProjectCwd,
  planShadowInvocation,
  previewShadowInvocation,
  shadowProviderRoleStatus,
  type CodexIsolationAttestation,
  type ShadowInvocationPreview,
  type ShadowRolePayload,
  type SubscriptionAttestation,
} from "@braingate/shadow";

export interface PlannedShadowRole {
  readonly role: "planner" | "primary" | "reviewer";
  readonly model: ModelRef;
  readonly route: RouteResult;
  readonly invocation: ShadowInvocationPreview;
}

export interface ShadowTaskPlan {
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly cwd: string;
  readonly roles: readonly PlannedShadowRole[];
}

function modelRef(route: RouteResult): ModelRef {
  const definition = route.selected.model.definition;
  return Object.freeze({ providerId: definition.providerId, modelId: definition.modelId, quotaPool: definition.quotaPool });
}

function payload(role: "planner" | "primary" | "reviewer", task: string, context: unknown): ShadowRolePayload {
  return Object.freeze({
    schemaVersion: 1,
    role,
    phase: "preflight",
    task,
    findings: Object.freeze([]),
    candidateOutput: null,
    context,
    responseContract: Object.freeze(role === "primary"
      ? { kind: "work", output: "string" }
      : { kind: "review", verdict: ["approve", "request_changes", "disagree"], findings: "string[]" }),
  });
}

function attestationFor(attestations: readonly SubscriptionAttestation[], providerId: string): Readonly<{ attestation?: SubscriptionAttestation }> {
  const value = attestations.find((item) => item.providerId === providerId);
  return value === undefined ? Object.freeze({}) : Object.freeze({ attestation: value });
}

function snapshotFor(snapshots: readonly ProviderSnapshot[], providerId: string): ProviderSnapshot {
  const value = snapshots.find((candidate) => candidate.providerId === providerId);
  if (value === undefined) throw new Error(`Missing provider snapshot for routed provider ${providerId}.`);
  return value;
}

function excludedProviders(input: {
  readonly providers: readonly ProviderSnapshot[];
  readonly role: "planner" | "primary" | "reviewer";
  readonly codexIsolation?: CodexIsolationAttestation;
}): readonly string[] {
  return Object.freeze(input.providers.filter((snapshot) => {
    if (!shadowProviderRoleStatus(snapshot.providerId, input.role).enabled) return true;
    if (snapshot.providerId === "openai" && input.role === "reviewer" && input.codexIsolation === undefined) return true;
    return false;
  }).map((snapshot) => snapshot.providerId));
}

export function buildShadowTaskPlan(input: {
  readonly project: RegisteredProject;
  readonly cwd: string;
  readonly router: CapabilityRouter;
  readonly providers: readonly ProviderSnapshot[];
  readonly attestations?: readonly SubscriptionAttestation[];
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly task: string;
  readonly context: unknown;
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly optionalReview?: boolean;
}): ShadowTaskPlan {
  const cwd = assertShadowProjectCwd(input.project, input.cwd);
  const attestations = input.attestations ?? [];
  const primaryRoute = input.router.route({
    role: "coder",
    classification: input.classification,
    budget: input.budget,
    requiredContextTokens: input.requiredContextTokens,
    writeRequired: false,
    excludeProviders: excludedProviders({ providers: input.providers, role: "primary", ...(input.codexIsolation === undefined ? {} : { codexIsolation: input.codexIsolation }) }),
  });
  const primaryModel = modelRef(primaryRoute);
  const primaryInvocation = planShadowInvocation({
    snapshot: snapshotFor(input.providers, primaryModel.providerId),
    model: primaryModel,
    cwd,
    payload: payload("primary", input.task, input.context),
    ...attestationFor(attestations, primaryModel.providerId),
  });
  const roles: PlannedShadowRole[] = [];

  // The planning pass, previewed before it is spent. A plan that showed only the executor would
  // hide the model the task actually leads with, which is the routing decision worth seeing.
  if (input.budget.separatePlanningPass) {
    try {
      const plannerRoute = input.router.route({
        role: "planner",
        classification: input.classification,
        budget: input.budget,
        requiredContextTokens: input.requiredContextTokens,
        writeRequired: false,
        excludeProviders: excludedProviders({ providers: input.providers, role: "planner", ...(input.codexIsolation === undefined ? {} : { codexIsolation: input.codexIsolation }) }),
      });
      const plannerModel = modelRef(plannerRoute);
      roles.push(Object.freeze({
        role: "planner",
        model: plannerModel,
        route: plannerRoute,
        invocation: previewShadowInvocation(planShadowInvocation({
          snapshot: snapshotFor(input.providers, plannerModel.providerId),
          model: plannerModel,
          cwd,
          payload: payload("planner", input.task, input.context),
          ...attestationFor(attestations, plannerModel.providerId),
        })),
      }));
    } catch (error) {
      // No model declares a planner capability; the task plans and executes in one pass.
      if (!(error instanceof BrainGateInvariantError && error.code === "ROUTE_NO_ELIGIBLE_MODEL")) throw error;
    }
  }

  roles.push(Object.freeze({ role: "primary", model: primaryModel, route: primaryRoute, invocation: previewShadowInvocation(primaryInvocation) }));

  const needsReview = input.budget.reviewerPolicy === "required" || (input.budget.reviewerPolicy === "optional" && (input.optionalReview ?? false));
  if (needsReview) {
    const independence = input.classification.risk === "high" || input.classification.risk === "critical"
      ? { mode: "required" as const, models: [primaryModel] }
      : { mode: "preferred" as const, models: [primaryModel] };
    const reviewerRoute = input.router.route({
      role: "reviewer",
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      writeRequired: false,
      independence,
      excludeProviders: excludedProviders({ providers: input.providers, role: "reviewer", ...(input.codexIsolation === undefined ? {} : { codexIsolation: input.codexIsolation }) }),
    });
    const reviewerModel = modelRef(reviewerRoute);
    const reviewerInvocation = planShadowInvocation({
      snapshot: snapshotFor(input.providers, reviewerModel.providerId),
      model: reviewerModel,
      cwd,
      payload: payload("reviewer", input.task, input.context),
      ...attestationFor(attestations, reviewerModel.providerId),
      ...(reviewerModel.providerId === "openai" && input.codexIsolation !== undefined ? { codexIsolation: input.codexIsolation } : {}),
    });
    roles.push(Object.freeze({ role: "reviewer", model: reviewerModel, route: reviewerRoute, invocation: previewShadowInvocation(reviewerInvocation) }));
  }

  return Object.freeze({ classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, cwd, roles: Object.freeze(roles) });
}
