import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import type { WorkflowRole } from "@braingate/workflows";
import {
  acceptedFeatureKeys,
  codexReviewerConfigArgs,
  validCodexIsolationAttestation,
  type CodexIsolationAttestation,
} from "./codex-isolation.js";
import { GROK_SANDBOX_PROFILE, validGrokIsolationAttestation, type GrokIsolationAttestation } from "./grok-isolation.js";
import { jsonSchemaArgument, jsonSchemaFor } from "./response-schema.js";
import { subagentsArgument } from "./subagents.js";
import { grants, guaranteesFor, resolveToolGrant, type ProviderGrantSurface, type ToolGrant } from "./tool-grants.js";
import { STAGE_PATH_TOKEN, type OperatorProviderAcceptance, type ShadowInvocationPlan, type ShadowInvocationPreview, type ShadowRolePayload, type SubscriptionAttestation } from "./types.js";

const CLAUDE_MINIMUM = "2.1.248";
// The release where a custom sandbox profile that cannot be applied refuses to start rather
// than warning and continuing. Below it, `--sandbox` is a request, not a guarantee.
const GROK_MINIMUM = "1.0.13";
const ATTACHMENT_TOKEN = "__BRAINGATE_SHADOW_INPUT__";
/**
 * The instruction for a CLI that enforces the response schema itself.
 *
 * Everything the long prompt spends on the shape of the reply — the keys, the literals, the no
 * fences, the worked example — is a constraint the provider now applies. What is left is the
 * part a schema cannot express: what the request is, and that this run analyses rather than acts.
 */
const SCHEMA_PROMPT = [
  "You receive one JSON request object (appended below this instruction, or supplied as the attached file).",
  "Use its `task` field as the request and its `context` field as supporting data.",
  "Analyze only; do not modify files, run commands, access the network, or use external tools.",
  "Answer with real values you produce; the response shape is enforced for you.",
  "If you cannot complete the request, still answer in that shape and put the reason in the text field.",
].join(" ");

/** Where a staged response schema is written for a CLI that takes it as a path. */
export const STAGED_SCHEMA_FILE = "braingate-response-schema.json";

const GENERIC_PROMPT = [
  "You receive one JSON request object (appended below this instruction, or supplied as the attached file).",
  "Use its `task` field as the request and its `context` field as supporting data.",
  "Its `responseContract` field describes the JSON object you must produce: each key is a field name, and each value describes that field's type or allowed values.",
  "Analyze only; do not modify files, run commands, access the network, or use external tools.",
  "Output one new top-level JSON object whose keys are exactly the keys of `responseContract`, filled with real values you produce.",
  "Include every key from `responseContract`, including any key whose described value is a fixed literal string.",
  "Do not echo the request back, do not nest your answer inside `responseContract`, and emit no prose and no markdown code fences.",
  "Example: for responseContract {\"kind\":\"work\",\"output\":\"string\"} the entire reply is exactly {\"kind\":\"work\",\"output\":\"<your answer here>\"}.",
  "If you cannot complete the request, still reply in that same shape and put the reason in the text field.",
].join(" ");

interface ProfileDefinition {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
  readonly minimumVersion: string | null;
  readonly blockedReason: string | null;
  /**
   * Roles this provider may take without proven per-invocation isolation (ADR 0008).
   *
   * These run `staged-clean`: a fresh temporary directory holding only what BrainGate put
   * there, so the provider cannot leak a repository it was never shown. Roles that read the
   * real checkout are not here, and need the operator's recorded acceptance instead.
   *
   * Planning belongs here: deciding an approach works from the task and the context BrainGate
   * supplies, not from reading the tree. A planner that cannot open the repository plans from
   * less, but it plans without being able to leak anything either — which is what makes the
   * strongest model in an otherwise unusable subscription reachable at all.
   */
  readonly stagedRoles?: readonly WorkflowRole[];
  /** True when project access is reachable only through an operator acceptance. */
  readonly needsOperatorAcceptance?: boolean;
  /**
   * What this CLI can be asked for, from the flags it actually exposes (ADR 0010).
   *
   * Not a judgement about the provider: a CLI with no way to deny a tool cannot be granted one,
   * because the grant would describe an intention instead of a boundary.
   */
  readonly surface: ProviderGrantSurface;
}

/**
 * Providers with an actual invocation profile below.
 *
 * Eligibility and execution have to agree. Declaring a role reachable for a provider that
 * `planShadowInvocation` then refuses is worse than declaring it closed: the router selects the
 * model, the operator sees it in the plan, and the failure arrives only after they have
 * committed to the run.
 */
const INVOCABLE: ReadonlySet<ProviderId> = new Set<ProviderId>(["anthropic", "openai", "github-copilot", "xai", "google"]);

/** Where the staged request body is written for providers that read their prompt from a path. */
export const STAGED_REQUEST_FILE = "braingate-request.txt";

const PROFILES: Readonly<Record<ProviderId, ProfileDefinition>> = Object.freeze({
  anthropic: { providerId: "anthropic", enabled: true, minimumVersion: CLAUDE_MINIMUM, blockedReason: null, surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: true, enforcedSandbox: false } },
  // `--agent` selects an agent Copilot already has; it does not accept one BrainGate wrote, so
  // there is nothing here to bound and subagents stay closed.
  "github-copilot": { providerId: "github-copilot", enabled: true, minimumVersion: null, blockedReason: null, surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: false, enforcedSandbox: false } },
  // M10 opened Codex as a reviewer because that was the role the milestone needed, and the
  // restriction outlived its reason: a planner and a judge run in the same staged workspace,
  // under the same attestation, reading nothing the reviewer does not read. What stays closed is
  // `primary`, which would need the real checkout.
  openai: { providerId: "openai", enabled: true, stagedRoles: ["planner", "reviewer", "judge"], minimumVersion: null, blockedReason: "Staged roles only; requires a current Codex sandbox self-test attestation.", surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: false, enforcedSandbox: true } },
  // Grok was blocked for two reasons, and grok 1.0.13 ended both (ADR 0009). `GROK_HOME` now
  // carries configuration and credentials together, so an isolated HOME removes the other
  // tool's settings file — `grok inspect` reports `Permissions: (none)` — while authentication
  // survives; and a custom sandbox profile that cannot be applied now aborts the run instead of
  // warning. What remains is proven per invocation by a self-test rather than assumed, so Grok
  // is enabled for staged roles and still closed for anything that reads the real checkout.
  xai: { providerId: "xai", enabled: true, stagedRoles: ["planner", "reviewer", "judge"], minimumVersion: GROK_MINIMUM, blockedReason: "Staged roles only; requires a current Grok sandbox self-test attestation.", surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: true, enforcedSandbox: true } },
  // Headless `agy` is fail-closed about tools — one needing permission is auto-denied, because
  // there is nobody to prompt, and the denial is reported in `denied_actions`. What is still
  // missing is any way to scope it per invocation: permissions and credentials share HOME, and
  // unlike Grok there is no second variable that separates them, so BrainGate cannot hand this
  // one an isolated home the way it does for Codex and Grok. A staged run therefore keeps the
  // operator's real home, and what agy may reach elsewhere on the machine is unchecked — which
  // is the residual only the operator can accept (ADR 0008).
  google: { providerId: "google", enabled: false, stagedRoles: ["planner", "reviewer", "judge"], needsOperatorAcceptance: true, minimumVersion: null, blockedReason: "Antigravity has no per-invocation permission scope: settings and credentials share HOME, so BrainGate cannot prove what one call may reach outside the project.", surface: { isolatedPerInvocation: false, toolDenial: false, declaredSubagents: false, enforcedSandbox: false } },
});

function versionTuple(value: string | null): readonly [number, number, number] | null {
  if (value === null) return null;
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function versionAtLeast(actual: string | null, minimum: string): boolean {
  const a = versionTuple(actual);
  const m = versionTuple(minimum);
  if (a === null || m === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! > m[index]!) return true;
    if (a[index]! < m[index]!) return false;
  }
  return true;
}

function validAttestation(attestation: SubscriptionAttestation | undefined, providerId: ProviderId, now: Date): boolean {
  if (attestation === undefined || attestation.providerId !== providerId || attestation.mode !== "subscription") return false;
  const observed = new Date(attestation.observedAt);
  if (Number.isNaN(observed.getTime())) return false;
  if (observed.getTime() > now.getTime() + 60_000) return false;
  if (now.getTime() - observed.getTime() > 30 * 24 * 60 * 60 * 1000) return false;
  if (attestation.expiresAt !== undefined && attestation.expiresAt !== null) {
    const expires = new Date(attestation.expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return false;
  }
  return true;
}

function assertAuth(snapshot: ProviderSnapshot, attestation: SubscriptionAttestation | undefined, now: Date): void {
  if (snapshot.authMode.value === "api") {
    throw new BrainGateInvariantError("SHADOW_API_AUTH_DENIED", `${snapshot.displayName} is authenticated for API billing, not subscription shadow usage.`);
  }
  if (snapshot.authState.value === "unauthenticated") {
    throw new BrainGateInvariantError("SHADOW_AUTH_REQUIRED", `${snapshot.displayName} is not authenticated.`);
  }
  if (snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription") return;
  if (validAttestation(attestation, snapshot.providerId, now)) return;
  throw new BrainGateInvariantError("SHADOW_AUTH_REQUIRED", `${snapshot.displayName} subscription authentication is not proven. A valid local user attestation is required when safe discovery reports unknown.`);
}

function assertProfile(
  snapshot: ProviderSnapshot,
  model: ModelRef,
  attestation: SubscriptionAttestation | undefined,
  acceptance: OperatorProviderAcceptance | undefined,
  role: WorkflowRole,
  now: Date,
): ProfileDefinition {
  if (snapshot.providerId !== model.providerId) throw new BrainGateInvariantError("SHADOW_PROVIDER_MISMATCH", "Provider snapshot and routed model do not match.");
  const profile = PROFILES[snapshot.providerId];
  if (!profile.enabled) {
    const status = shadowProviderRoleStatus(snapshot.providerId, role, { ...(acceptance === undefined ? {} : { acceptance }), now });
    if (!status.enabled) throw new BrainGateInvariantError("SHADOW_PROVIDER_BLOCKED", status.reason ?? profile.blockedReason ?? "Provider shadow profile is blocked.");
  }
  if (snapshot.available.value !== true) throw new BrainGateInvariantError("SHADOW_PROVIDER_UNAVAILABLE", `${snapshot.displayName} CLI is unavailable.`);
  if (snapshot.capabilities.value.headless !== true || snapshot.capabilities.value.modelPinning !== true) {
    throw new BrainGateInvariantError("SHADOW_CAPABILITY_UNPROVEN", `${snapshot.displayName} headless/model-pinning capability is not proven by discovery.`);
  }
  assertAuth(snapshot, attestation, now);
  if (profile.minimumVersion !== null && !versionAtLeast(snapshot.version.value, profile.minimumVersion)) {
    throw new BrainGateInvariantError("SHADOW_VERSION_TOO_OLD", `${snapshot.displayName} must be at least ${profile.minimumVersion}; discovered ${snapshot.version.value ?? "unknown"}.`);
  }
  if (snapshot.models.value !== null && snapshot.models.value.length > 0 && !snapshot.models.value.includes(model.modelId)) {
    throw new BrainGateInvariantError("SHADOW_MODEL_UNAVAILABLE", `Routed model ${model.modelId} is not in the provider's discovered model list.`);
  }
  return profile;
}

function serializedPayload(payload: ShadowRolePayload): string {
  const json = JSON.stringify(payload);
  if (json.length === 0 || json.length > 2_000_000) throw new BrainGateInvariantError("SHADOW_PAYLOAD_INVALID", "Shadow payload must be between 1 and 2,000,000 characters.");
  return json;
}

export function planShadowInvocation(input: {
  readonly snapshot: ProviderSnapshot;
  readonly model: ModelRef;
  readonly cwd: string;
  readonly payload: ShadowRolePayload;
  readonly attestation?: SubscriptionAttestation;
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly grokIsolation?: GrokIsolationAttestation;
  /** The operator's recorded decision, for a provider BrainGate cannot isolate (ADR 0008). */
  readonly acceptance?: OperatorProviderAcceptance;
  readonly maxTurns?: number;
  /**
   * Whether this task's budget allows more than one agent at once.
   *
   * Taken from `ExecutionBudget.maxConcurrentAgents` rather than invented here: subagents are
   * concurrent agents, so the budget that already bounds concurrency is the thing that decides
   * whether a run may fan out. T0-T2 do not; T3 and T4 do.
   */
  readonly fanOut?: boolean;
  readonly now?: Date;
}): ShadowInvocationPlan {
  const now = input.now ?? new Date();
  const profile = assertProfile(input.snapshot, input.model, input.attestation, input.acceptance, input.payload.role, now);
  const body = serializedPayload(input.payload);
  // The shape the provider must answer in, as a constraint it applies rather than a paragraph
  // it may ignore. Every CLI here except Copilot accepts one; Copilot keeps the long prompt.
  const schema = jsonSchemaArgument(input.payload.responseContract);
  const attested = input.snapshot.providerId === "openai"
    ? validCodexIsolationAttestation(input.codexIsolation, input.snapshot, { now })
    : input.snapshot.providerId === "xai"
      ? validGrokIsolationAttestation(input.grokIsolation, input.snapshot, { now })
      : profile.surface.isolatedPerInvocation;
  const grant = resolveToolGrant({
    role: input.payload.role,
    providerId: input.snapshot.providerId,
    // Every shadow role reads; nothing here edits, which is what keeps `edit` and `shell` out of
    // reach on this path however generous a provider's surface is.
    workspaceMode: input.snapshot.providerId === "anthropic" || input.snapshot.providerId === "github-copilot" ? "project" : "staged-clean",
    writeMode: false,
    surface: profile.surface,
    attested,
    operatorAccepted: validOperatorAcceptance(input.acceptance, input.snapshot.providerId, now),
  });
  // Two independent conditions, and both have to hold: the grant says this provider and role may
  // have helpers at all, and the budget says this task may run more than one agent at once.
  const subagents = grants(grant, "subagents") && input.fanOut === true ? subagentsArgument(input.payload.role) : null;
  // A ceiling on pathology, not a budget: see ExecutionBudget.maxInspectionTurns. Clamping
  // lower than the budget asks for would silently reimpose the limit this stopped being.
  const maxTurns = Math.max(1, Math.min(60, Math.floor(input.maxTurns ?? 20)));

  if (input.snapshot.providerId === "anthropic") {
    const args = Object.freeze([
      "--restricted",
      "-p", SCHEMA_PROMPT,
      "--output-format", "json",
      "--no-session-persistence",
      "--no-chrome",
      "--disable-slash-commands",
      // The Agent tool appears only when the grant and the budget both allow helpers, and the
      // helpers themselves are the ones BrainGate defined — read-only, named, and bounded.
      "--tools", subagents === null ? "Read,Glob,Grep" : "Read,Glob,Grep,Agent",
      ...(subagents === null ? [] : ["--agents", subagents]),
      "--disallowedTools", "mcp__*",
      "--max-turns", String(maxTurns),
      "--model", input.model.modelId,
      "--json-schema", schema,
    ]);
    if (args.includes("--bare") || args.includes("--dangerously-skip-permissions") || args.includes("--allow-dangerously-skip-permissions")) {
      throw new BrainGateInvariantError("SHADOW_PROFILE_UNSAFE", "Unsafe Claude permission/profile flags are forbidden.");
    }
    return Object.freeze({
      providerId: "anthropic",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      workspaceMode: "project",
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      inputMode: "stdin",
      stdin: body,
      attachmentContent: null,
      attachmentToken: null,
      allowedEnvKeys: Object.freeze([]),
      envOverrides: Object.freeze({}),
      grant,
      guarantees: guaranteesFor(grant, Object.freeze({ projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true })),
      minimumVersion: profile.minimumVersion,
    });
  }

  if (input.snapshot.providerId === "openai") {
    const codexStaged = PROFILES.openai.stagedRoles ?? [];
    if (!codexStaged.includes(input.payload.role)) {
      throw new BrainGateInvariantError("SHADOW_CODEX_ROLE_DENIED", `Codex runs staged roles only (${codexStaged.join(", ")}); ${input.payload.role} would need the real checkout, which the staged workspace does not contain.`);
    }
    if (!validCodexIsolationAttestation(input.codexIsolation, input.snapshot, { now })) {
      throw new BrainGateInvariantError("SHADOW_CODEX_ISOLATION_REQUIRED", "Codex reviewer isolation requires a current sandbox self-test attestation for this version/platform/profile.");
    }
    const args = Object.freeze([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--skip-git-repo-check",
      "--json",
      "--model", input.model.modelId,
      "-C", STAGE_PATH_TOKEN,
      // Only the keys this build proved it accepts during the self-test (ADR 0006). Sending a
      // key it does not know would abort the run under --strict-config.
      ...codexReviewerConfigArgs(STAGE_PATH_TOKEN, acceptedFeatureKeys(input.codexIsolation?.droppedFeatureKeys ?? [])),
      // Codex takes its schema as a path. The staged workspace is the only directory this run
      // can open, so that is where it goes.
      "--output-schema", `${STAGE_PATH_TOKEN}/${STAGED_SCHEMA_FILE}`,
      "-",
    ]);
    if (args.includes("--sandbox") || args.includes("--dangerously-bypass-approvals-and-sandbox") || args.includes("--full-auto")) {
      throw new BrainGateInvariantError("SHADOW_PROFILE_UNSAFE", "Unsafe or legacy Codex sandbox flags are forbidden for the reviewer profile.");
    }
    return Object.freeze({
      providerId: "openai",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      workspaceMode: "staged-clean",
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      inputMode: "stdin",
      stdin: body,
      attachmentContent: null,
      attachmentToken: null,
      stagedFiles: Object.freeze({ [STAGED_SCHEMA_FILE]: JSON.stringify(jsonSchemaFor(input.payload.responseContract), null, 2) }),
      allowedEnvKeys: Object.freeze(["CODEX_HOME"]),
      envOverrides: Object.freeze({}),
      grant,
      guarantees: guaranteesFor(grant, Object.freeze({ projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true })),
      minimumVersion: profile.minimumVersion,
    });
  }

  if (input.snapshot.providerId === "xai") {
    const staged = PROFILES.xai.stagedRoles ?? [];
    if (!staged.includes(input.payload.role)) {
      throw new BrainGateInvariantError("SHADOW_GROK_ROLE_DENIED", `Grok runs staged roles only (${staged.join(", ")}); ${input.payload.role} would need the real checkout, which the sandbox does not grant.`);
    }
    if (!validGrokIsolationAttestation(input.grokIsolation, input.snapshot, { now })) {
      throw new BrainGateInvariantError("SHADOW_GROK_ISOLATION_REQUIRED", "Grok requires a current sandbox self-test attestation for this version/platform/profile.");
    }
    const args = Object.freeze([
      // The prompt is a file inside the staged workspace rather than an argument, because a
      // task with context attached outgrows the platform's argument limit long before it
      // outgrows the payload cap.
      "--prompt-file", `${STAGE_PATH_TOKEN}/${STAGED_REQUEST_FILE}`,
      "--cwd", STAGE_PATH_TOKEN,
      // A custom profile, never a built-in one: only a custom profile that fails to apply
      // aborts the run. `--sandbox strict` would warn and continue unprotected.
      "--sandbox", GROK_SANDBOX_PROFILE,
      "--output-format", "json",
      "--model", input.model.modelId,
      "--max-turns", String(maxTurns),
      "--json-schema", schema,
      "--verbatim",
      ...(grants(grant, "web") ? [] : ["--disable-web-search"]),
      // Grok's own subagents are banned unless BrainGate supplied the definitions. The flag is
      // the difference between helpers whose reach nobody declared and helpers that are part of
      // the grant.
      ...(subagents === null ? ["--no-subagents"] : ["--agents", subagents]),
      "--no-plan",
      "--no-alt-screen",
    ]);
    if (args.some((argument) => argument === "--always-approve" || argument === "--dangerously-skip-permissions" || argument === "bypassPermissions")) {
      throw new BrainGateInvariantError("SHADOW_PROFILE_UNSAFE", "Unsafe Grok approval flags are forbidden.");
    }
    return Object.freeze({
      providerId: "xai",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      workspaceMode: "staged-clean",
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      inputMode: "staged-file",
      stdin: null,
      // The instruction has to travel with the payload: `--prompt-file` is the whole prompt,
      // so a file holding only the request object arrives with nothing telling the model what
      // shape to answer in — and it answers in prose, which fails the contract on parse.
      attachmentContent: `${SCHEMA_PROMPT}\n\n${body}`,
      attachmentToken: STAGED_REQUEST_FILE,
      allowedEnvKeys: Object.freeze(["GROK_HOME", "GROK_CLAUDE_MCPS_ENABLED", "GROK_CURSOR_MCPS_ENABLED", "GROK_MANAGED_MCPS_ENABLED"]),
      envOverrides: Object.freeze({
        // Belt and braces behind the isolated HOME: these scanners look for other vendors'
        // MCP configuration, and turning them off by name says so rather than relying on the
        // isolated home happening to be empty.
        GROK_CLAUDE_MCPS_ENABLED: "false",
        GROK_CURSOR_MCPS_ENABLED: "false",
        GROK_MANAGED_MCPS_ENABLED: "false",
      }),
      // Honest rather than aspirational. Grok keeps its shell tool — BrainGate has no
      // per-invocation way to remove it — and what stops that shell reaching the project is
      // the kernel, not a flag: an outside `cat` inside this profile fails with "Operation not
      // permitted". Network blocking is real on Linux and a documented no-op on macOS, so
      // noNetworkTools claims only the tools BrainGate actually disabled.
      grant,
      guarantees: guaranteesFor(grant, Object.freeze({ projectOnlyRead: true, noProjectWrites: true, noShell: false, noNetworkTools: true, noMcp: true, noSessionPersistence: false, isolatedUserConfig: true })),
      minimumVersion: profile.minimumVersion,
    });
  }

  if (input.snapshot.providerId === "google") {
    const args = Object.freeze([
      // Measured against agy 1.1.28: `--input-format stream-json` reads NDJSON from stdin, and
      // refuses a prompt on the command line rather than silently ignoring it. The 100 KB cap
      // that used to sit here was a property of an older build that had no stdin route at all.
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--json-schema", schema,
      "--model", input.model.modelId,
      "--disable-slash-commands",
      "--sandbox",
      "--print-timeout", `${String(Math.max(1, Math.ceil((input.maxTurns ?? 20) / 2)))}m`,
    ]);
    if (args.includes("--dangerously-skip-permissions")) {
      throw new BrainGateInvariantError("SHADOW_PROFILE_UNSAFE", "Antigravity's permission bypass is forbidden; headless auto-denial is the only tool policy BrainGate relies on here.");
    }
    return Object.freeze({
      providerId: "google",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      workspaceMode: "staged-clean",
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      inputMode: "stdin",
      // Measured against agy 1.1.28: the envelope key is `event`, not `type`, and a `user` event
      // must carry `message`. A wrong key is reported as an unknown event and silently produces
      // no turn at all, which is the failure mode worth pinning in a test.
      stdin: `${JSON.stringify({ event: "user", message: { role: "user", content: `${SCHEMA_PROMPT}\n\n${body}` } })}\n`,
      attachmentContent: null,
      attachmentToken: null,
      allowedEnvKeys: Object.freeze([]),
      envOverrides: Object.freeze({}),
      grant,
      // Deliberately the weakest guarantee set BrainGate publishes. The staged workspace holds
      // nothing but the run, and headless agy auto-denies any tool it lacks permission for —
      // but its home is the operator's own, so `isolatedUserConfig` is false and this profile
      // is reachable only through a recorded acceptance of exactly that. Re-measured on
      // 2026-09-09 against agy 1.1.28: an isolated HOME still loses authentication
      // (`agy models` answers "Please sign in"), so ADR 0008 stands for this provider.
      guarantees: guaranteesFor(grant, Object.freeze({ projectOnlyRead: true, noProjectWrites: true, noShell: false, noNetworkTools: false, noMcp: false, noSessionPersistence: false, isolatedUserConfig: false })),
      minimumVersion: profile.minimumVersion,
    });
  }

  if (input.snapshot.providerId === "github-copilot") {
    const args = Object.freeze([
      "-p", GENERIC_PROMPT,
      "--attachment", ATTACHMENT_TOKEN,
      `--model=${input.model.modelId}`,
      "--available-tools=view,grep,glob",
      "--allow-tool=read",
      "--deny-tool=write",
      "--deny-tool=shell",
      "--deny-tool=url",
      "--deny-tool=memory",
      "--disable-builtin-mcps",
      "--no-custom-instructions",
      "--no-ask-user",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-experimental",
      "--silent",
      "--stream=off",
      "--no-color",
    ]);
    return Object.freeze({
      providerId: "github-copilot",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      workspaceMode: "project",
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      inputMode: "temp-attachment",
      stdin: null,
      attachmentContent: body,
      attachmentToken: ATTACHMENT_TOKEN,
      allowedEnvKeys: Object.freeze(["COPILOT_HOME"]),
      envOverrides: Object.freeze({}),
      grant,
      guarantees: guaranteesFor(grant, Object.freeze({ projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true })),
      minimumVersion: profile.minimumVersion,
    });
  }

  throw new BrainGateInvariantError("SHADOW_PROVIDER_BLOCKED", "Provider has no enabled shadow invocation profile.");
}

export function previewShadowInvocation(plan: ShadowInvocationPlan): ShadowInvocationPreview {
  return Object.freeze({
    providerId: plan.providerId,
    executable: plan.executable,
    args: Object.freeze([...plan.args]),
    cwd: plan.cwd,
    workspaceMode: plan.workspaceMode,
    modelId: plan.modelId,
    quotaPool: plan.quotaPool,
    inputMode: plan.inputMode,
    grant: plan.grant,
    guarantees: plan.guarantees,
    minimumVersion: plan.minimumVersion,
  });
}

export function shadowProviderStatus(providerId: ProviderId): Readonly<{ enabled: boolean; minimumVersion: string | null; reason: string | null }> {
  const profile = PROFILES[providerId];
  return Object.freeze({ enabled: profile.enabled, minimumVersion: profile.minimumVersion, reason: profile.blockedReason });
}

/**
 * Whether the operator's acceptance of a provider is present and current (ADR 0008).
 *
 * Stale acceptance is refused rather than honoured: a decision made months ago about a provider
 * that has since changed is not a decision about the provider in front of you.
 */
export function validOperatorAcceptance(value: OperatorProviderAcceptance | undefined, providerId: ProviderId, now = new Date()): boolean {
  if (value === undefined || value.providerId !== providerId || value.source !== "operator-accepted-unscoped-provider") return false;
  const accepted = new Date(value.acceptedAt);
  if (Number.isNaN(accepted.getTime())) return false;
  if (accepted.getTime() > now.getTime() + 60_000) return false;
  if (now.getTime() - accepted.getTime() > 90 * 24 * 60 * 60 * 1000) return false;
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    const expires = new Date(value.expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return false;
  }
  return true;
}

export function shadowProviderRoleStatus(
  providerId: ProviderId,
  role: WorkflowRole,
  options: { readonly acceptance?: OperatorProviderAcceptance; readonly now?: Date } = {},
): Readonly<{ enabled: boolean; reason: string | null; acceptedByOperator: boolean }> {
  const profile = PROFILES[providerId];

  if (!profile.enabled) {
    if (!INVOCABLE.has(providerId)) {
      // The staged roles and the acceptance route are the policy for this provider; what is
      // missing is the code that would actually run it. Saying so is more useful than either
      // silently refusing or promising a role that fails once selected.
      return Object.freeze({
        enabled: false,
        reason: `${profile.blockedReason ?? "Provider is blocked."} A staged invocation profile for this provider is not implemented yet, so no role is reachable.`,
        acceptedByOperator: false,
      });
    }
    const staged = profile.stagedRoles ?? [];
    if (!staged.includes(role)) {
      return Object.freeze({ enabled: false, reason: `${profile.blockedReason ?? "Provider is blocked."} Only staged roles (${staged.join(", ")}) could ever be reachable for it.`, acceptedByOperator: false });
    }
    // ADR 0008, revised by what building it showed: a staged workspace bounds what the provider
    // is *shown*, and that is why only staged roles are on offer here. It does not bound what an
    // unscoped provider can reach on its own — the residual is present in every invocation, not
    // only the ones that open the checkout. So acceptance gates the provider, and the staged
    // role list gates the role, and a fresh install still routes to neither.
    if (profile.needsOperatorAcceptance !== true) {
      return Object.freeze({ enabled: false, reason: profile.blockedReason, acceptedByOperator: false });
    }
    if (!validOperatorAcceptance(options.acceptance, providerId, options.now)) {
      return Object.freeze({
        enabled: false,
        reason: `${profile.blockedReason ?? "Provider is blocked."} Run \`braingate providers accept ${providerId}\` to use it anyway, accepting that risk.`,
        acceptedByOperator: false,
      });
    }
    return Object.freeze({
      enabled: true,
      reason: "Enabled by operator acceptance; BrainGate cannot scope what this provider reaches outside the project.",
      acceptedByOperator: true,
    });
  }

  // An enabled provider that declares staged roles is enabled for those and closed for the
  // rest. Grok's sandbox confines it to the staged workspace, which is what makes the staged
  // roles safe and, by the same fact, makes a role that must read the checkout impossible.
  const staged = profile.stagedRoles;
  if (staged !== undefined && !staged.includes(role)) {
    return Object.freeze({ enabled: false, reason: `Runs staged roles only (${staged.join(", ")}); ${role} would need the real checkout.`, acceptedByOperator: false });
  }
  if (providerId === "openai") return Object.freeze({ enabled: true, reason: "Requires current sandbox self-test attestation.", acceptedByOperator: false });
  if (staged !== undefined) return Object.freeze({ enabled: true, reason: "Runs in a kernel-sandboxed staged workspace; requires a current self-test attestation.", acceptedByOperator: false });
  return Object.freeze({ enabled: true, reason: null, acceptedByOperator: false });
}
