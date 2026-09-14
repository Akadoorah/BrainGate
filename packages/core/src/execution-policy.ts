import { BrainGateInvariantError } from "./errors.js";

/**
 * Where and how a worker is allowed to run.
 *
 * Three things are separate and stay separate (ADR 0017):
 *
 * - **Role** is what a worker is for: plan, execute, review, judge.
 * - **Execution policy** is the boundary it runs inside, and it is chosen, not inferred.
 * - **The native CLI** is the harness that does the work: its tools, its shell, its subagents, its
 *   own permission model.
 *
 * The policy exists because the earlier model had one answer for every situation — a snapshot for a
 * read, a worktree for a write — and that answer was a strict mode imposed on ordinary interactive
 * work. It made a plain question cost a project copy, and it made a one-line fix land in a worktree
 * the operator then had to approve, merge and clean up. Both are still available and still correct
 * when they are *chosen*; neither is the default.
 *
 * Every field here is a claim the plan and the receipt repeat to the operator, so a policy cannot
 * quietly mean something different from what it says.
 */
export interface ExecutionPolicySpec {
  readonly id: ExecutionPolicyId;
  /** What the operator sees. */
  readonly label: string;
  /**
   * What bounds the worker's filesystem view.
   *
   * `none` is DIRECT: the workspace itself, shared with every other worker and with the operator.
   */
  readonly isolation: "none" | "read-only" | "worktree" | "snapshot";
  /** Whether a worker may modify files. Intent can narrow this; it can never widen it. */
  readonly allowWrites: boolean;
  /** Whether the workspace must be a Git repository for this policy to be offered. */
  readonly requiresRepository: boolean;
  /** Whether a human is present to approve what the runtime asks. */
  readonly attended: boolean;
  /**
   * Whether the native CLI keeps its own harness: its tool set, its MCP servers, its subagents and
   * its own permission model, rather than a BrainGate-declared subset.
   */
  readonly preservesNativeHarness: boolean;
  readonly summary: string;
}

export const EXECUTION_POLICY_IDS = ["direct", "read-only", "worktree", "snapshot", "unattended"] as const;
export type ExecutionPolicyId = (typeof EXECUTION_POLICY_IDS)[number];

export const EXECUTION_POLICIES: Readonly<Record<ExecutionPolicyId, ExecutionPolicySpec>> = Object.freeze({
  direct: Object.freeze({
    id: "direct",
    label: "direct",
    isolation: "none",
    allowWrites: true,
    requiresRepository: false,
    attended: true,
    preservesNativeHarness: true,
    summary: "the workspace itself: workers run in it, share it, and leave what they change for you to review",
  }),
  "read-only": Object.freeze({
    id: "read-only",
    label: "read-only",
    isolation: "read-only",
    allowWrites: false,
    requiresRepository: false,
    attended: true,
    preservesNativeHarness: true,
    summary: "the workspace, read but never written: no change is requested, and none is accepted",
  }),
  worktree: Object.freeze({
    id: "worktree",
    label: "worktree",
    isolation: "worktree",
    allowWrites: true,
    requiresRepository: true,
    attended: true,
    preservesNativeHarness: false,
    summary: "an isolated Git worktree: changes are proposed, never applied, until you merge them",
  }),
  snapshot: Object.freeze({
    id: "snapshot",
    label: "snapshot",
    isolation: "snapshot",
    allowWrites: false,
    requiresRepository: true,
    attended: true,
    preservesNativeHarness: false,
    summary: "an immutable copy of the workspace: a read that cannot touch what it is reading",
  }),
  unattended: Object.freeze({
    id: "unattended",
    label: "unattended",
    isolation: "none",
    allowWrites: true,
    requiresRepository: false,
    attended: false,
    preservesNativeHarness: false,
    summary: "the workspace, with nobody present: BrainGate's own bounds stand in for the runtime's approvals",
  }),
});

/** The ordinary interactive boundary. Everything else is chosen, or required by a workflow. */
export const DEFAULT_EXECUTION_POLICY: ExecutionPolicyId = "direct";

export function isExecutionPolicyId(value: string): value is ExecutionPolicyId {
  return (EXECUTION_POLICY_IDS as readonly string[]).includes(value);
}

/** The policy's own terms, refusing an id this build does not implement. */
export function executionPolicySpec(id: string): ExecutionPolicySpec {
  if (!isExecutionPolicyId(id)) {
    throw new BrainGateInvariantError("EXECUTION_POLICY_INVALID", `Unknown execution policy \`${id}\`. Known policies: ${EXECUTION_POLICY_IDS.join(", ")}.`);
  }
  return EXECUTION_POLICIES[id];
}

/** One line for `/policy` and `/worker`, so both read from the same table. */
export function describeExecutionPolicy(id: ExecutionPolicyId): string {
  const spec = EXECUTION_POLICIES[id];
  return `${spec.label}: ${spec.summary}`;
}

/**
 * Whether a policy may be used in this workspace, and why not when it may not.
 *
 * Asked before a plan is built rather than after a provider was chosen, because "the strict mode you
 * selected cannot represent this workspace" is a fact about the choice, not about the work.
 */
export function executionPolicyAvailability(input: {
  readonly policy: ExecutionPolicyId;
  /** Whether the selected workspace is inside a Git repository. */
  readonly hasRepository: boolean;
}): { readonly available: boolean; readonly reason: string | null } {
  const spec = EXECUTION_POLICIES[input.policy];
  if (spec.requiresRepository && !input.hasRepository) {
    return Object.freeze({
      available: false,
      reason: `${spec.label} needs a Git repository, and this workspace has none. \`direct\` works here.`,
    });
  }
  return Object.freeze({ available: true, reason: null });
}

/**
 * What a policy means for one request, given what the operator asked for.
 *
 * Intent can only ever *narrow* the boundary. A request that says "do not modify anything" is
 * read-only whatever the policy is; a request to make a change is still bounded by a policy that
 * does not allow writes. That is the whole of the relationship between the two: the classifier
 * decides what the operator wants, the policy decides where it may happen (ADR 0017).
 */
export function executionPolicyForIntent(input: {
  readonly policy: ExecutionPolicyId;
  readonly intent: "read" | "write";
}): ExecutionPolicySpec {
  const spec = EXECUTION_POLICIES[input.policy];
  if (input.intent === "read") return Object.freeze({ ...spec, allowWrites: false });
  return spec;
}

/**
 * Whether a write request may proceed under this policy, in the operator's terms.
 *
 * The message is the remedy rather than the rule: an operator who asked for a change and got a
 * refusal needs to know which policy to choose, not which invariant they crossed.
 */
export function assertWriteAllowed(policy: ExecutionPolicyId, intent: "read" | "write"): void {
  const spec = executionPolicyForIntent({ policy, intent });
  if (intent === "write" && !spec.allowWrites) {
    throw new BrainGateInvariantError(
      "EXECUTION_POLICY_READ_ONLY",
      `Execution policy \`${spec.label}\` does not allow changes in the workspace. Use \`/policy direct\` to work in it, or \`/policy worktree\` to propose the change in an isolated worktree.`,
    );
  }
}
