import { BrainGateInvariantError } from "@braingate/core";
import type { ExecutionBudget, ExecutionProject, TaskClassification } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import {
  type RoutePin, CapabilityRouter, type ModelRef, type RouteResult } from "@braingate/router";
import {
  assertShadowProjectCwd,
  planShadowInvocation,
  previewShadowInvocation,
  shadowProviderRoleStatus,
  snapshotPrimaryEligibility,
  type CodexIsolationAttestation,
  type GrokIsolationAttestation,
  type MeasuredCapabilities,
  type OperatorProviderAcceptance,
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
    // A planner produces the approach, so its contract is work — the same one the executor
    // gets. Previewing it as a review would size and describe a request that is never sent.
    responseContract: Object.freeze(role === "primary" || role === "planner"
      ? { kind: "work", output: "string" }
      : { kind: "review", verdict: ["approve", "request_changes", "disagree"], findings: "string[]" }),
  });
}

function attestationFor(attestations: readonly SubscriptionAttestation[], providerId: string): Readonly<{ attestation?: SubscriptionAttestation }> {
  const value = attestations.find((item) => item.providerId === providerId);
  return value === undefined ? Object.freeze({}) : Object.freeze({ attestation: value });
}

/**
 * The per-provider proof a plan needs to preview an invocation the runner would accept.
 *
 * The preview and the run have to agree about eligibility, or the plan advertises a model the
 * invocation then refuses — which is the failure the operator sees only after committing.
 */
interface ProviderProof {
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly grokIsolation?: GrokIsolationAttestation;
  /** The snapshot posture's own proof: a different home and a different contract from the staged one. */
  readonly grokSnapshotIsolation?: GrokIsolationAttestation;
  readonly acceptances?: readonly OperatorProviderAcceptance[];
}

function measuredFor(input: { readonly measured?: Readonly<Record<string, MeasuredCapabilities>> }, providerId: string): Readonly<{ measured?: MeasuredCapabilities }> {
  const measured = input.measured?.[providerId];
  return measured === undefined ? Object.freeze({}) : Object.freeze({ measured });
}

function proofFor(proof: ProviderProof, providerId: string): Readonly<{ codexIsolation?: CodexIsolationAttestation; grokIsolation?: GrokIsolationAttestation; acceptance?: OperatorProviderAcceptance; networkAcceptance?: OperatorProviderAcceptance }> {
  const acceptance = (proof.acceptances ?? []).find((item) => item.providerId === providerId && item.source === "operator-accepted-unscoped-provider");
  const networkAcceptance = (proof.acceptances ?? []).find((item) => item.providerId === providerId && item.source === "operator-accepted-network-access");
  return Object.freeze({
    ...(providerId === "openai" && proof.codexIsolation !== undefined ? { codexIsolation: proof.codexIsolation } : {}),
    ...(providerId === "xai" && proof.grokIsolation !== undefined ? { grokIsolation: proof.grokIsolation } : {}),
    ...(providerId === "xai" && proof.grokSnapshotIsolation !== undefined ? { grokSnapshotIsolation: proof.grokSnapshotIsolation } : {}),
    ...(acceptance === undefined ? {} : { acceptance }),
    ...(networkAcceptance === undefined ? {} : { networkAcceptance }),
  });
}

function snapshotFor(snapshots: readonly ProviderSnapshot[], providerId: string): ProviderSnapshot {
  const value = snapshots.find((candidate) => candidate.providerId === providerId);
  if (value === undefined) throw new Error(`Missing provider snapshot for routed provider ${providerId}.`);
  return value;
}

function excludedProviders(input: {
  readonly providers: readonly ProviderSnapshot[];
  readonly role: "planner" | "primary" | "reviewer";
  readonly proof: ProviderProof;
  /**
   * The providers this policy reaches even where the staged gates would close them.
   *
   * Under DIRECT that is every provider whose installed build can run the policy — measured by the
   * caller and passed in — plus the pinned one. It applies to every role, not only the primary: a
   * DIRECT run keeps the runtime's own harness for the planner and the reviewer too, so the staged
   * proofs below are not what decides whether they can run. It used to be the pinned provider alone, on the
   * reasoning that selecting a worker was the operator's act; the automatic route then judged
   * everyone else by the *staged* proofs, so a provider that runs DIRECT perfectly well was
   * excluded from every automatic DIRECT turn for want of an attestation about a sandbox DIRECT
   * does not use. The staged roles still answer to the staged gates: they are not DIRECT runs.
   */
  readonly directProviders?: readonly string[];
  /** The per-provider capability reading; Antigravity's DIRECT answer is in it, so the status has to see it. */
  readonly measured?: Readonly<Record<string, MeasuredCapabilities>>;
}): readonly string[] {
  const excludedList = Object.freeze(input.providers.filter((snapshot) => {
    const acceptance = (input.proof.acceptances ?? []).find((item) => item.providerId === snapshot.providerId && item.source === "operator-accepted-unscoped-provider");
    // The same question the runner asks, from the same function: a plan that hid a provider the runner
    // would accept is as wrong as one that named a provider the runner would refuse — and the read
    // primary's snapshot posture is exactly the case where the two drifted apart.
    const snapshotEligible = input.role === "primary" && snapshotPrimaryEligibility({
      providerId: snapshot.providerId,
      snapshot,
      ...(input.proof.codexIsolation === undefined ? {} : { codexIsolation: input.proof.codexIsolation }),
      ...(input.proof.grokIsolation === undefined ? {} : { grokIsolation: input.proof.grokIsolation }),
      ...(input.proof.grokSnapshotIsolation === undefined ? {} : { grokSnapshotIsolation: input.proof.grokSnapshotIsolation }),
    }).eligible;
    const directHere = (input.directProviders ?? []).includes(snapshot.providerId);

    if (!shadowProviderRoleStatus(snapshot.providerId, input.role, { ...(acceptance === undefined ? {} : { acceptance }), snapshotPrimary: snapshotEligible, direct: directHere, measured: input.measured?.[snapshot.providerId] ?? null }).enabled) return true;
    // The proofs below are for a staged or snapshot posture: a sandbox profile BrainGate wrote, and
    // a copy it made. A DIRECT run has neither, so demanding them excluded exactly the worker the
    // operator named — the plan refusing the model the operator had just asked for.
    if (directHere) return false;
    if (snapshot.providerId === "openai" && input.role === "reviewer" && input.proof.codexIsolation === undefined) return true;
    if (snapshot.providerId === "xai" && (input.role === "primary" ? input.proof.grokSnapshotIsolation === undefined : input.proof.grokIsolation === undefined)) return true;
    return false;
  }).map((snapshot) => snapshot.providerId));
  return excludedList;
}

export function buildShadowTaskPlan(input: {
  readonly project: ExecutionProject;
  readonly cwd: string;
  readonly router: CapabilityRouter;
  readonly providers: readonly ProviderSnapshot[];
  /**
   * What a capability probe read from each installed build, keyed by provider.
   *
   * Optional, because a plan is still a plan without it — but supplied, it is what stops a
   * profile from declaring a flag this build no longer has.
   */
  readonly measured?: Readonly<Record<string, MeasuredCapabilities>>;
  readonly attestations?: readonly SubscriptionAttestation[];
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly grokIsolation?: GrokIsolationAttestation;
  readonly acceptances?: readonly OperatorProviderAcceptance[];
  readonly task: string;
  /** Whether this plan keeps the runtime's own harness: the DIRECT policy (ADR 0017). */
  readonly nativeHarness?: boolean;
  /** Which providers can execute this policy, measured from the installed builds by the caller. */
  readonly policyCapability?: { readonly id: string; readonly supportedProviders: readonly string[] };
  /** The sessions this goal already holds: a warm worker wins a close call, never a real gap. */
  readonly continuity?: {
    readonly warm: readonly { readonly providerId: string; readonly modelId: string }[];
    readonly previous?: { readonly providerId: string; readonly modelId: string } | null;
  };
  readonly context: unknown;
  readonly classification: TaskClassification;
  readonly budget: ExecutionBudget;
  readonly requiredContextTokens: number;
  readonly optionalReview?: boolean;
  /**
   * The worker the operator named by hand, when there is one.
   *
   * Applied to the primary route only. The planner and the reviewer are chosen for their
   * independence from the primary, and pinning them would defeat the reason they exist; the operator
   * chooses who does the work, not who checks it.
   */
  readonly pin?: RoutePin | undefined;
}): ShadowTaskPlan {
  const cwd = assertShadowProjectCwd(input.project, input.cwd);
  const attestations = input.attestations ?? [];
  const proof: ProviderProof = Object.freeze({
    ...(input.codexIsolation === undefined ? {} : { codexIsolation: input.codexIsolation }),
    ...(input.grokIsolation === undefined ? {} : { grokIsolation: input.grokIsolation }),
    acceptances: input.acceptances ?? [],
  });
  // Which providers this policy can actually reach. Under DIRECT that is the measured set, not the
  // operator's pin: the router is the thing choosing now, and it cannot choose a worker that was
  // excluded by a gate the policy does not use.
  const policyProviders = input.nativeHarness === true
    ? [...new Set([...(input.policyCapability?.supportedProviders ?? []), ...(input.pin === undefined ? [] : [input.pin.providerId])])]
    : [];
  const primaryRoute = input.router.route({
    role: "coder",
    classification: input.classification,
    budget: input.budget,
    requiredContextTokens: input.requiredContextTokens,
    writeRequired: false,
    ...(input.policyCapability === undefined ? {} : { policy: input.policyCapability }),
    ...(input.continuity === undefined ? {} : { continuity: input.continuity }),
    excludeProviders: excludedProviders({ providers: input.providers, ...(input.measured === undefined ? {} : { measured: input.measured }), role: "primary", proof, ...(policyProviders.length === 0 ? {} : { directProviders: policyProviders }) }),
    ...(input.pin === undefined ? {} : { pin: input.pin }),
  });
  const primaryModel = modelRef(primaryRoute);
  const primarySnapshot = snapshotFor(input.providers, primaryModel.providerId);
  const primarySnapshotEligible = snapshotPrimaryEligibility({
    providerId: primarySnapshot.providerId,
    snapshot: primarySnapshot,
    ...(proof.codexIsolation === undefined ? {} : { codexIsolation: proof.codexIsolation }),
    ...(proof.grokIsolation === undefined ? {} : { grokIsolation: proof.grokIsolation }),
    ...(proof.grokSnapshotIsolation === undefined ? {} : { grokSnapshotIsolation: proof.grokSnapshotIsolation }),
  }).eligible;
  const nativeHarness = input.nativeHarness === true ? { nativeHarness: true } : {};
  const primaryInvocation = planShadowInvocation({
    ...nativeHarness,
    snapshot: primarySnapshot,
    model: primaryModel,
    cwd,
    // Not under DIRECT: that policy reads the workspace itself, and a snapshot would put a copy
    // between the worker and the files the previous worker left.
    ...(primarySnapshotEligible && input.nativeHarness !== true ? { snapshotPrimary: true, preview: true } : {}),
    payload: payload("primary", input.task, input.context),
    fanOut: input.budget.maxConcurrentAgents > 1,
    ...measuredFor(input, primaryModel.providerId),
    ...attestationFor(attestations, primaryModel.providerId),
    ...proofFor(proof, primaryModel.providerId),
  });
  const roles: PlannedShadowRole[] = [];

  // The planning pass, previewed before it is spent. A plan that showed only the executor would
  // hide the model the task actually leads with, which is the routing decision worth seeing.
  if (input.budget.separatePlanningPass && input.budget.maxPlanners > 0) {
    const plannerExclusions = excludedProviders({ providers: input.providers, ...(input.measured === undefined ? {} : { measured: input.measured }), role: "planner", proof, ...(policyProviders.length === 0 ? {} : { directProviders: policyProviders }) });
    const routePlanner = (independence?: { readonly mode: "required"; readonly level: "cross-provider"; readonly models: readonly ModelRef[] }) => input.router.route({
      role: "planner",
      classification: input.classification,
      budget: input.budget,
      requiredContextTokens: input.requiredContextTokens,
      writeRequired: false,
      ...(independence === undefined ? {} : { independence }),
      ...(input.policyCapability === undefined ? {} : { policy: input.policyCapability }),
      excludeProviders: plannerExclusions,
    });
    const previewPlanner = (route: ReturnType<typeof routePlanner>, model: ModelRef): PlannedShadowRole => Object.freeze({
      role: "planner",
      model,
      route,
      invocation: previewShadowInvocation(planShadowInvocation({
        ...nativeHarness,
        snapshot: snapshotFor(input.providers, model.providerId),
        model,
        cwd,
        payload: payload("planner", input.task, input.context),
        fanOut: input.budget.maxConcurrentAgents > 1,
        ...measuredFor(input, model.providerId),
        ...attestationFor(attestations, model.providerId),
        ...proofFor(proof, model.providerId),
      })),
    });

    try {
      const plannerRoute = routePlanner();
      const plannerModel = modelRef(plannerRoute);
      roles.push(previewPlanner(plannerRoute, plannerModel));

      // The second approach, from a provider that shares no pool with the first. Previewed here
      // rather than discovered at run time, because a plan that showed one planner and then
      // spent two would be describing a task the operator did not approve.
      if (input.budget.maxPlanners > 1) {
        try {
          const secondRoute = routePlanner({ mode: "required", level: "cross-provider", models: [plannerModel] });
          roles.push(previewPlanner(secondRoute, modelRef(secondRoute)));
        } catch (error) {
          if (!(error instanceof BrainGateInvariantError && error.code === "ROUTE_NO_ELIGIBLE_MODEL")) throw error;
        }
      }
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
      ...(input.policyCapability === undefined ? {} : { policy: input.policyCapability }),
      excludeProviders: excludedProviders({ providers: input.providers, ...(input.measured === undefined ? {} : { measured: input.measured }), role: "reviewer", proof, ...(policyProviders.length === 0 ? {} : { directProviders: policyProviders }) }),
    });
    const reviewerModel = modelRef(reviewerRoute);
    const reviewerInvocation = planShadowInvocation({
      ...nativeHarness,
      snapshot: snapshotFor(input.providers, reviewerModel.providerId),
      model: reviewerModel,
      cwd,
      payload: payload("reviewer", input.task, input.context),
      fanOut: input.budget.maxConcurrentAgents > 1,
      ...measuredFor(input, reviewerModel.providerId),
      ...attestationFor(attestations, reviewerModel.providerId),
      ...proofFor(proof, reviewerModel.providerId),
    });
    roles.push(Object.freeze({ role: "reviewer", model: reviewerModel, route: reviewerRoute, invocation: previewShadowInvocation(reviewerInvocation) }));
  }

  return Object.freeze({ classification: input.classification, budget: input.budget, requiredContextTokens: input.requiredContextTokens, cwd, roles: Object.freeze(roles) });
}
