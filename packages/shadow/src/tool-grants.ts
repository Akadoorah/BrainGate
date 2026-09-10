import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderId } from "@braingate/providers";
import type { WorkflowRole } from "@braingate/workflows";
import type { ShadowGuarantees } from "./types.js";

/**
 * Where a granted run happens.
 *
 * Wider than `ShadowWorkspaceMode` because the write path has a place the read path does not:
 * a task worktree BrainGate created, which is the only place an `edit` grant is meaningful.
 */
export type GrantWorkspace = "project" | "staged-clean" | "task-worktree";

/**
 * What a run may be permitted to do, as one list the type is derived from.
 *
 * These are not provider flags. They are the questions BrainGate has to be able to answer before
 * it hands work to a model — may this run change files, run a command, reach the network, spawn
 * helpers of its own — and until now it could not ask them at all. `guarantees` recorded what a
 * profile happened to disable, per provider, identically for every role, so "may the planner
 * search the web" had no place to be asked and was answered no everywhere.
 */
export const TOOL_CAPABILITIES = ["read", "edit", "shell", "web", "mcp", "subagents"] as const;
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

export function isToolCapability(value: string): value is ToolCapability {
  return (TOOL_CAPABILITIES as readonly string[]).includes(value);
}

/** Why a capability the role asked for is not in the grant it received. */
export interface GrantRefusal {
  readonly capability: ToolCapability;
  readonly reason: string;
}

export interface ToolGrant {
  readonly role: WorkflowRole;
  readonly providerId: ProviderId;
  readonly workspaceMode: GrantWorkspace;
  readonly requested: readonly ToolCapability[];
  /** The intersection of what the role asked for, what the provider proved, and what was accepted. */
  readonly granted: readonly ToolCapability[];
  readonly refused: readonly GrantRefusal[];
}

/**
 * What each role asks for before anything is checked.
 *
 * A ceiling, not a promise: a role asks for what it could use, and the grant is what survives the
 * checks below. Analysis roles read. A planner may reach the network, because deciding an
 * approach is the one job where a current answer beats a confident one, and may fan out to
 * helpers BrainGate defines. Only the executing role edits, and only it needs a shell — to run
 * the project's own verification, not to roam.
 */
export function requestedCapabilities(input: { readonly role: WorkflowRole; readonly writeMode: boolean }): readonly ToolCapability[] {
  if (input.role === "primary") {
    return input.writeMode
      ? Object.freeze(["read", "edit", "shell", "subagents"] as ToolCapability[])
      : Object.freeze(["read", "subagents"] as ToolCapability[]);
  }
  if (input.role === "planner") return Object.freeze(["read", "web", "subagents"] as ToolCapability[]);
  if (input.role === "reviewer") return Object.freeze(["read", "subagents"] as ToolCapability[]);
  // A judge decides between answers it was given. Sending it to read more is a different job
  // than the one it was routed for.
  return Object.freeze(["read"] as ToolCapability[]);
}

/**
 * What a provider can be *asked* for, given what its CLI actually exposes.
 *
 * Derived from the flags the capability probe reads, not from a provider's reputation: a CLI
 * with no way to deny a tool cannot be granted one safely, because the grant would describe an
 * intention rather than a boundary.
 */
/**
 * Narrows a declared surface to what a measured capability report actually found.
 *
 * The surface in a profile is a claim about a CLI; the report is a reading of the build that is
 * installed. Where they disagree the reading wins, and it can only ever take a capability away:
 * a probe that could not read the help text answers `unknown`, and an unknown must not be able
 * to grant anything the profile did not already declare.
 *
 * This is what makes "prove then enable" a wire rather than a slogan. Before it, a profile could
 * declare `declaredSubagents` for a build that had dropped the flag, and the run would fail at
 * the provider with a flag error instead of being refused here with a reason.
 */
export function measuredSurface(declared: ProviderGrantSurface, measured: MeasuredCapabilities | null): ProviderGrantSurface {
  if (measured === null) return declared;
  const found = (feature: keyof MeasuredCapabilities): boolean => measured[feature] === true;
  const unknown = (feature: keyof MeasuredCapabilities): boolean => measured[feature] === "unknown";
  // An unreadable probe leaves the declaration standing; a probe that read the help and did not
  // find the flag removes it.
  const keep = (declaredValue: boolean, feature: keyof MeasuredCapabilities): boolean =>
    declaredValue && (found(feature) || unknown(feature));
  return Object.freeze({
    isolatedPerInvocation: declared.isolatedPerInvocation,
    toolDenial: keep(declared.toolDenial, "toolDenial"),
    declaredSubagents: keep(declared.declaredSubagents, "declaredSubagents"),
    enforcedSandbox: keep(declared.enforcedSandbox, "sandbox"),
  });
}

/**
 * What a capability probe found, in the vocabulary a grant needs.
 *
 * Deliberately the same three names the surface uses, so the two cannot drift into describing
 * different things under one word.
 */
export interface MeasuredCapabilities {
  readonly toolDenial: boolean | "unknown";
  readonly declaredSubagents: boolean | "unknown";
  readonly sandbox: boolean | "unknown";
}

/**
 * A capability report, in the three terms a grant reasons about.
 *
 * The report carries more than this — a schema flag, a prompt route, session resume — and those
 * shape how a provider is *driven* rather than what it is *allowed*. Only what bounds a
 * capability belongs here.
 */
export function measuredFrom(report: {
  readonly features: Readonly<Record<string, { readonly supported: boolean | "unknown" }>>;
}): MeasuredCapabilities {
  const read = (feature: string): boolean | "unknown" => report.features[feature]?.supported ?? "unknown";
  return Object.freeze({
    toolDenial: read("toolDenial"),
    declaredSubagents: read("declaredSubagents"),
    sandbox: read("sandbox"),
  });
}

export interface ProviderGrantSurface {
  /** Proven per-invocation isolation — an isolated config home, or a sandbox that aborts when unapplied. */
  readonly isolatedPerInvocation: boolean;
  /** The CLI can be told which tools it may use. */
  readonly toolDenial: boolean;
  /** The CLI accepts subagent definitions BrainGate writes, rather than only allowing or banning its own. */
  readonly declaredSubagents: boolean;
  /** A kernel-enforced sandbox, not a request the CLI may warn about and continue past. */
  readonly enforcedSandbox: boolean;
}

export interface GrantRequest {
  readonly role: WorkflowRole;
  readonly providerId: ProviderId;
  readonly workspaceMode: GrantWorkspace;
  readonly writeMode: boolean;
  readonly surface: ProviderGrantSurface;
  /** True when a current self-test attestation covers this provider, version, platform and policy. */
  readonly attested: boolean;
  /** The operator's recorded acceptance of a provider BrainGate cannot scope per invocation. */
  readonly operatorAccepted: boolean;
  /**
   * The operator's recorded decision to let a role reach the network, which is a different
   * decision from the one above.
   *
   * A provider BrainGate can scope perfectly well still sends the task off the machine when it
   * searches; a provider it cannot scope may be accepted for reasons that have nothing to do
   * with the network. Neither implies the other.
   */
  readonly networkAccepted?: boolean;
  /**
   * Whether this task's budget allows more than one agent at once
   * (`ExecutionBudget.maxConcurrentAgents > 1`). Subagents are concurrent agents, so the number
   * that already bounds concurrency decides this rather than a new one invented here.
   *
   * It belongs in the grant rather than beside it: a plan that listed `subagents` as granted and
   * then ran without them would be describing a run that never happens.
   */
  readonly fanOutAllowed?: boolean;
}

function refusal(capability: ToolCapability, reason: string): GrantRefusal {
  return Object.freeze({ capability, reason });
}

/**
 * Decides one run's grant.
 *
 * Every capability above `read` is decided the same way: the role asked, the CLI can be told,
 * and a current self-test proves this build enforces it. A missing proof refuses the capability
 * and says which one is missing — never the whole provider, and never silently less than asked.
 */
export function resolveToolGrant(request: GrantRequest): ToolGrant {
  const requested = requestedCapabilities({ role: request.role, writeMode: request.writeMode });
  const granted: ToolCapability[] = [];
  const refused: GrantRefusal[] = [];

  for (const capability of requested) {
    if (capability === "read") { granted.push(capability); continue; }

    if (capability === "edit") {
      if (request.workspaceMode !== "task-worktree") {
        refused.push(refusal(capability, "Editing happens in a task worktree BrainGate owns; this run has no worktree."));
        continue;
      }
      granted.push(capability);
      continue;
    }

    if (capability === "shell") {
      if (request.workspaceMode === "project") {
        refused.push(refusal(capability, "A shell is never granted against the registered checkout."));
        continue;
      }
      if (!request.surface.enforcedSandbox) {
        refused.push(refusal(capability, "This CLI has no sandbox that fails closed, so a shell here would be bounded by nothing."));
        continue;
      }
      if (!request.attested) {
        refused.push(refusal(capability, "No current self-test proves this build applies its sandbox."));
        continue;
      }
      granted.push(capability);
      continue;
    }

    if (capability === "web") {
      // What leaves the machine is the one thing no outcome check downstream can see, so this
      // is the operator's decision rather than an attestation's.
      if (request.networkAccepted !== true) {
        refused.push(refusal(capability, "Network access sends project context off the machine; grant it with `braingate providers allow-web <provider>`."));
        continue;
      }
      if (!request.surface.toolDenial) {
        refused.push(refusal(capability, "This CLI cannot be told which tools to use, so network access could not be scoped to search."));
        continue;
      }
      granted.push(capability);
      continue;
    }

    if (capability === "subagents") {
      if (request.fanOutAllowed !== true) {
        refused.push(refusal(capability, "This task's budget allows one agent at a time; helpers are for work that was budgeted for more."));
        continue;
      }
      if (!request.surface.declaredSubagents) {
        refused.push(refusal(capability, "This CLI does not accept subagent definitions, so BrainGate could not bound what they may do."));
        continue;
      }
      if (!request.surface.isolatedPerInvocation && !request.operatorAccepted) {
        refused.push(refusal(capability, "Subagents inherit the run's reach, which is unproven for this provider without the operator's acceptance."));
        continue;
      }
      granted.push(capability);
      continue;
    }

    // MCP is declared so the vocabulary is complete and the refusal is legible. There is no
    // per-invocation proof that an MCP server is what it claims, so nothing grants it yet.
    refused.push(refusal(capability, "BrainGate has no way to prove what an MCP server reaches, so no role is granted one."));
  }

  return Object.freeze({
    role: request.role,
    providerId: request.providerId,
    workspaceMode: request.workspaceMode,
    requested,
    granted: Object.freeze([...granted]),
    refused: Object.freeze(refused),
  });
}

export function grants(grant: ToolGrant, capability: ToolCapability): boolean {
  return grant.granted.includes(capability);
}

/**
 * The honest description of a granted run.
 *
 * `guarantees` stays in the plan, where the operator and the receipt already read it — but it is
 * now derived from the grant rather than being the place capability is decided.
 *
 * The grant can only ever remove a claim, never add one. Grok keeps a shell BrainGate has no
 * flag to take away, so its profile does not claim `noShell`; a grant that withholds `shell`
 * must not turn that honest false into a comfortable true.
 */
export function guaranteesFor(grant: ToolGrant, base: ShadowGuarantees): ShadowGuarantees {
  return Object.freeze({
    projectOnlyRead: base.projectOnlyRead && !grants(grant, "edit"),
    noProjectWrites: base.noProjectWrites && !grants(grant, "edit"),
    noShell: base.noShell && !grants(grant, "shell"),
    noNetworkTools: base.noNetworkTools && !grants(grant, "web"),
    noMcp: base.noMcp && !grants(grant, "mcp"),
    noSessionPersistence: base.noSessionPersistence,
    isolatedUserConfig: base.isolatedUserConfig,
  });
}

export function assertGrantCovers(grant: ToolGrant, required: readonly ToolCapability[]): void {
  for (const capability of required) {
    if (grants(grant, capability)) continue;
    const reason = grant.refused.find((item) => item.capability === capability)?.reason ?? "not requested by this role";
    throw new BrainGateInvariantError("SHADOW_GRANT_INSUFFICIENT", `${grant.providerId} ${grant.role} needs ${capability}: ${reason}`);
  }
}
