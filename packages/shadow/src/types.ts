import type { RegisteredProject } from "@braingate/core";
import type { ProviderId } from "@braingate/providers";
import type { WorkflowRole } from "@braingate/workflows";
import type { StreamDialect } from "./streaming.js";
import type { ToolGrant } from "./tool-grants.js";

/**
 * Placeholder for the staged workspace path, substituted at spawn time.
 *
 * A staged invocation has to name its workspace on the command line, but the directory does not
 * exist when the plan is built — and a plan that carried a real path would be a plan whose
 * preview no longer described the run. Every provider that stages uses this one token, so the
 * executor's "no unresolved token reached the child" check covers all of them rather than one.
 */
export const STAGE_PATH_TOKEN = "__BRAINGATE_STAGE_PATH__";

export interface SubscriptionAttestation {
  readonly providerId: ProviderId;
  readonly mode: "subscription";
  readonly source: "user-confirmed-oauth";
  readonly observedAt: string;
  readonly expiresAt?: string | null;
}

/**
 * The operator accepting, for one provider, a residual risk BrainGate cannot remove (ADR 0008).
 *
 * A provider whose permissions BrainGate cannot scope may read or write outside the project,
 * elsewhere on the machine. No guard here sees that. It is the same exposure as running the CLI
 * by hand, which the operator already does, but it is not zero — so it is accepted explicitly,
 * per provider, with a timestamp, and never inferred from the provider being installed,
 * authenticated, or previously used.
 */
export interface OperatorProviderAcceptance {
  readonly providerId: ProviderId;
  /**
   * Which decision this record is.
   *
   * Accepting an unscoped provider says what a CLI may reach on this machine; allowing network
   * access says what may leave it. They expire separately and neither implies the other.
   */
  readonly source: "operator-accepted-unscoped-provider" | "operator-accepted-network-access";
  readonly acceptedAt: string;
  readonly expiresAt?: string | null;
}

export interface ShadowGuarantees {
  readonly projectOnlyRead: boolean;
  readonly noProjectWrites: boolean;
  readonly noShell: boolean;
  readonly noNetworkTools: boolean;
  readonly noMcp: boolean;
  readonly noSessionPersistence: boolean;
  readonly isolatedUserConfig: boolean;
}

export interface ShadowRolePayload {
  readonly schemaVersion: 1;
  readonly role: WorkflowRole;
  readonly phase: string;
  readonly task: string;
  readonly findings: readonly string[];
  /** Current candidate output for review/judge/repair phases; omitted only by legacy/preflight callers. */
  readonly candidateOutput?: string | null;
  /** What the candidate is for this role: an approach to follow, or a result to judge. */
  readonly candidateOutputRole?: "approach-to-follow" | "prior-result-under-review" | null;
  readonly context: unknown;
  readonly responseContract: Readonly<Record<string, unknown>>;
}

/**
 * How the request body reaches the provider.
 *
 * `staged-file` writes it inside the staged workspace: the only route for a CLI that takes its
 * prompt from a path rather than stdin, and safe precisely because the staged workspace is the
 * one directory such a provider is confined to.
 */
export type ShadowInputMode = "stdin" | "temp-attachment" | "staged-file";
/**
 * Where a provider's run is pointed.
 *
 * `project` is the operator's registered checkout. `staged-clean` is a workspace BrainGate builds for
 * the run, holding only the context the role was given. `staged-read-snapshot` is that same idea with
 * the project itself in it: a read-only copy of the checkout, made by BrainGate, so a provider that
 * must not see the operator's working directory can still be asked about their project.
 */
export type ShadowWorkspaceMode = "project" | "staged-clean" | "staged-read-snapshot";

export interface ShadowInvocationPlan {
  readonly providerId: ProviderId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspaceMode: ShadowWorkspaceMode;
  /**
   * The prepared workspace a `staged-read-snapshot` run is pointed at.
   *
   * Present only in that mode, and always a BrainGate-owned directory: the source checkout never
   * appears here, which is what keeps the operational mode and the security boundary the same fact.
   */
  readonly workspaceRoot?: string;
  /**
   * Set on a plan built only to be validated — a dry run, or a route check before execution.
   *
   * A preview states the mode a real run would use without claiming a workspace exists, and the
   * executor refuses to run one, so "this is what would happen" can never quietly become "this ran".
   */
  readonly preview?: boolean;
  readonly modelId: string;
  readonly quotaPool: string;
  readonly inputMode: ShadowInputMode;
  readonly stdin: string | null;
  readonly attachmentContent: string | null;
  readonly attachmentToken: string | null;
  /**
   * Extra files written into the staged workspace before the run, by plain file name.
   *
   * A CLI that enforces a response schema wants it as a path, not a string, and the staged
   * workspace is the one directory such a provider is confined to — so the schema goes there
   * rather than into a temporary file the sandbox would refuse to open.
   */
  readonly stagedFiles?: Readonly<Record<string, string>>;
  readonly allowedEnvKeys: readonly string[];
  readonly envOverrides: Readonly<Record<string, string>>;
  /**
   * What this run was permitted to do, and what it asked for and did not get (ADR 0010).
   *
   * On the plan rather than only in the executor, because the operator reads the plan before
   * committing to the run — and "the planner asked for web search and did not get it, because
   * nobody accepted network access" is exactly the sentence that used to be missing.
   */
  readonly grant: ToolGrant;
  /** The stream shape this invocation produces, for the providers whose shape was measured. */
  readonly streamDialect: StreamDialect | null;
  readonly guarantees: ShadowGuarantees;
  readonly minimumVersion: string | null;
}

export interface ShadowInvocationPreview {
  readonly providerId: ProviderId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspaceMode: ShadowWorkspaceMode;
  readonly modelId: string;
  readonly quotaPool: string;
  readonly inputMode: ShadowInputMode;
  /** What the run may do, and what it asked for and was refused (ADR 0010). */
  readonly grant: ToolGrant;
  readonly guarantees: ShadowGuarantees;
  readonly minimumVersion: string | null;
}

export interface ShadowProcessResult {
  /**
   * The answer assembled from a streamed run, when the plan was streamed.
   *
   * A token stream has no envelope to parse: the answer is the concatenation of its pieces, and
   * the retained output deliberately no longer contains them.
   */
  readonly assembled?: string | null;
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The last of what the run wrote, kept only for diagnosing a failure.
   *
   * A streamed provider's stdout is thinned as it arrives, so a redacted tail of the raw lines is
   * the only record of the CLI's own words when a call is refused. Redacted and bounded by the
   * executor; optional so a fake executor need not invent one.
   */
  readonly stdoutTail?: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly removedEnvironmentKeys: readonly string[];
}

export interface ShadowProcessExecutor {
  run(input: {
    readonly project: RegisteredProject;
    readonly plan: ShadowInvocationPlan;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    /**
     * Told the model's prose as it arrives, when the provider streams and the plan asked for it.
     *
     * The answer under an enforced schema is JSON, so what reaches here is the readable field
     * inside it rather than the fragments themselves.
     */
    readonly onText?: (text: string) => void;
    /** Told once, when the provider starts reasoning and has not said anything yet. */
    readonly onThinking?: () => void;
  }): Promise<ShadowProcessResult>;
}
