import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import type { WorkflowRole } from "@braingate/workflows";
import {
  CODEX_PROBE_VERSION,
  acceptedFeatureKeys,
  codexReviewerConfigArgs,
  validCodexIsolationAttestation,
  type CodexIsolationAttestation,
} from "./codex-isolation.js";
import { GROK_SANDBOX_PROFILE, GROK_SNAPSHOT_READ_SANDBOX, validGrokIsolationAttestation, validGrokSnapshotReadAttestation, type GrokIsolationAttestation } from "./grok-isolation.js";
import { jsonSchemaArgument, jsonSchemaFor } from "./response-schema.js";
import { subagentsArgument } from "./subagents.js";
import { grants, guaranteesFor, measuredSurface, resolveToolGrant, type MeasuredCapabilities, type ProviderGrantSurface, type ToolGrant } from "./tool-grants.js";
import type { SnapshotPrimaryIneligibleReason } from "./snapshot-provider.js";
import type { ShadowGuarantees } from "./types.js";
import { NO_NATIVE_SESSION, STAGE_PATH_TOKEN, type OperatorProviderAcceptance, type PlannedNativeSession, type ShadowInvocationPlan, type ShadowInvocationPreview, type ShadowRolePayload, type SubscriptionAttestation } from "./types.js";

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

/**
 * The instruction for a DIRECT read: the workspace itself is the source, and the worker has tools.
 *
 * The staged prompt says "do not run commands, access the network, or use external tools", which is
 * right for a run whose whole input is the payload and whose tools are denied. Reused under DIRECT
 * it is a contradiction, and real dogfood showed what a worker does with one: Codex and Antigravity
 * both answered "the file's contents were not provided, and I am prohibited from reading it", the
 * contract parse failed, and two providers looked broken while the bug was the instruction.
 */
const DIRECT_PROMPT = [
  "You receive one JSON request object (appended below this instruction).",
  "Use its `task` field as the request and its `context` field as supporting data.",
  "You are running in the workspace itself: inspect the files it names with your own tools, and answer from what you actually find there.",
  "Do not modify any file unless the task asks for a change.",
  "Answer with real values you produce; the response shape is enforced for you.",
  "If you cannot complete the request, still answer in that shape and put the reason in the text field.",
].join(" ");

/**
 * The DIRECT instruction for a runtime that answers in prose rather than under an enforced schema.
 *
 * Measured 2026-09-19 on grok 1.0.30, in the workspace of a real Arabic dogfood run: with
 * `--json-schema` the model produced the schema-shaped object in its first turn and stopped — no
 * tool call, one turn, an `output` that *promised* to inspect the files ("سأفحص حالة المستودع…") and
 * never did — in both `streaming-json` and `json` output. The same prompt without the schema ran
 * `list_dir`, `grep` and the terminal, and answered correctly from the files. So a Grok DIRECT read
 * asks for plain text and the invoker accepts the prose as the answer; the contract's `output` is
 * the answer, and a schema that costs the inspection is not worth its shape.
 */
const DIRECT_PROSE_PROMPT = [
  "You receive one JSON request object (appended below this instruction).",
  "Use its `task` field as the request and its `context` field as supporting data.",
  "You are running in the workspace itself: inspect the files it names with your own tools, and answer from what you actually find there.",
  "Do not modify any file unless the task asks for a change.",
  "Answer in plain text, in the language of the request, with the real values you found.",
  "If you cannot complete the request, say why in plain text.",
].join(" ");

/**
 * The flags that name or continue a native session, from the decision that was made.
 *
 * It reads the decision rather than the runtime, so one place decides and one place acts: a decision
 * of `handoff` produces no flags at all, and a runtime whose continuity is not offered cannot
 * acquire it here through a later edit going unnoticed.
 *
 * Measured 2026-09-13 against claude 2.1.269: `--session-id <uuid>` names the id of a *new*
 * conversation and `--resume <uuid>` continues one, both in print mode. Exactly one of them is
 * passed, never both — the help text does not document the two together, and an undocumented
 * combination is not something to build continuity on.
 */
function sessionFlags(session: PlannedNativeSession): readonly string[] {
  if (session.sessionId === null) return [];
  if (session.kind === "resumed") return ["--resume", session.sessionId];
  if (session.kind === "fresh") return ["--session-id", session.sessionId];
  return [];
}

/** Where a staged response schema is written for a CLI that takes it as a path. */
export const STAGED_SCHEMA_FILE = "braingate-response-schema.json";

/**
 * The reasoning effort for an Antigravity run, which is the model's own and not BrainGate's to pick.
 *
 * Measured 2026-09-19 on agy 1.2.7: the effort tier is part of the model id — `agy models` lists
 * `gemini-3.8-flash-{low,medium,high}`, `gemini-3.1-pro-{low,high}` — and `--effort` has to agree
 * with it or the run never starts:
 *
 *     --model gemini-3.8-flash-medium --effort low
 *       → invalid model selection: --model gemini-3.8-flash-medium conflicts with --effort=low
 *     --model gemini-3.8-flash-low --effort medium
 *       → invalid model selection: --model gemini-3.8-flash-low conflicts with --effort=medium
 *
 * So the hard-coded `--effort medium` that used to sit here refused every Antigravity model the
 * operator might choose whose id does not end in `-medium`, including the `gemini-3.1-pro-high`
 * in their own catalogue — an instant ERROR envelope, zero tokens spent, no answer. What is passed
 * now is the tier the chosen model already names, and nothing at all when it names none, which
 * leaves the CLI's own default rather than contradicting it.
 *
 * This is also why M23's "run T0/T1 reads at `--effort low`" is not implementable on this build:
 * effort is a property of the model the operator scored, not a per-task knob.
 */
export function antigravityEffortArgs(modelId: string): readonly string[] {
  const tier = /-(low|medium|high)$/.exec(modelId)?.[1];
  return tier === undefined ? Object.freeze([]) : Object.freeze(["--effort", tier]);
}

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
  /**
   * Whether this provider may run the read-primary role against a BrainGate-made project snapshot.
   *
   * The flag is a statement about the *provider's* surface (it can be confined to a workspace it was
   * pointed at), not about its scores. It is not enough on its own: eligibility also requires the
   * provider's current sandbox attestation and the snapshot contract below.
   */
  readonly snapshotPrimary?: boolean;
  /** True when project access is reachable only through an operator acceptance. */
  readonly needsOperatorAcceptance?: boolean;
  /**
   * Whether this CLI has a DIRECT invocation: its own harness, in the workspace the operator chose.
   *
   * Separate from `enabled` and from `stagedRoles`, because DIRECT is a third way to reach a
   * provider rather than a widening of the first two. A staged run substitutes BrainGate's argv for
   * the CLI's and therefore needs an attestation about the sandbox BrainGate wrote; a DIRECT run
   * keeps the CLI's own argv, points it at the workspace the operator selected, and is authorized by
   * the operator's own approval of that run (ADR 0017). What BrainGate still owns is the workspace
   * boundary, the diff it observes afterwards, and the grant it publishes — not the tool set.
   */
  readonly nativeDirect?: boolean;
  /**
   * Why a CLI that looks like it could run natively cannot, with the measurement.
   *
   * Recorded rather than left as a bare `false`, because the difference between "untried" and
   * "measured and blocked" is the difference between a limitation and an omission — and because the
   * operator is the one who can lift it.
   */
  readonly nativeDirectBlockedBecause?: string;
  /**
   * A DIRECT invocation that exists but is usable only when a capability probe says so.
   *
   * For Antigravity the probe reads the operator's own settings file: its print mode auto-denies
   * every tool that would have prompted, takes no allow-list per invocation, and honours the
   * `permissions.allow` rules the operator keeps there. `nativeDirect` stays false because the CLI
   * alone cannot run DIRECT; this flag says the gate is a measurement rather than a constant.
   */
  readonly nativeDirectWhenMeasured?: boolean;
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

/** Where Antigravity keeps the rules its headless runs honour; named so a refusal can say where to look. */
export const ANTIGRAVITY_SETTINGS_HINT = "~/.gemini/antigravity-cli/settings.json";
const ANTIGRAVITY_DIRECT_REFUSAL =
  `Antigravity auto-denies every tool it would need in headless mode unless its own settings allow it (measured 2026-09-19 on agy 1.2.7: a print-mode run that needed the workspace ended with denied_actions and no answer, and with read_file(*) alone it still reached for the shell and was denied; on agy 1.2.2 read_file was denied under --mode accept-edits, --mode plan and --sandbox), so a DIRECT run cannot inspect the workspace. Allow headless tools under permissions.allow in Antigravity's own settings (${ANTIGRAVITY_SETTINGS_HINT}) with both rules read_file(*) and command(*); then this opens. BrainGate reads that file and never writes it.`;

const PROFILES: Readonly<Record<ProviderId, ProfileDefinition>> = Object.freeze({
  anthropic: { providerId: "anthropic", enabled: true, nativeDirect: true, minimumVersion: CLAUDE_MINIMUM, blockedReason: null, surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: true, enforcedSandbox: false } },
  // `--agent` selects an agent Copilot already has; it does not accept one BrainGate wrote, so
  // there is nothing here to bound and subagents stay closed.
  "github-copilot": { providerId: "github-copilot", enabled: true, minimumVersion: null, blockedReason: null, surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: false, enforcedSandbox: false } },
  // M10 opened Codex as a reviewer because that was the role the milestone needed, and the
  // restriction outlived its reason: a planner and a judge run in the same staged workspace,
  // under the same attestation, reading nothing the reviewer does not read. What stays closed is
  // `primary`, which would need the real checkout.
  openai: { providerId: "openai", enabled: true, nativeDirect: true, stagedRoles: ["planner", "reviewer", "judge"], snapshotPrimary: true, minimumVersion: null, blockedReason: "Staged roles only; requires a current Codex sandbox self-test attestation.", surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: false, enforcedSandbox: true } },
  // Grok was blocked for two reasons, and grok 1.0.13 ended both (ADR 0009). `GROK_HOME` now
  // carries configuration and credentials together, so an isolated HOME removes the other
  // tool's settings file — `grok inspect` reports `Permissions: (none)` — while authentication
  // survives; and a custom sandbox profile that cannot be applied now aborts the run instead of
  // warning. What remains is proven per invocation by a self-test rather than assumed, so Grok
  // is enabled for staged roles and still closed for anything that reads the real checkout.
  xai: { providerId: "xai", enabled: true, nativeDirect: true, stagedRoles: ["planner", "reviewer", "judge"], snapshotPrimary: true, minimumVersion: GROK_MINIMUM, blockedReason: "Staged roles only; requires a current Grok sandbox self-test attestation.", surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: true, enforcedSandbox: true } },
  // Headless `agy` is fail-closed about tools — one needing permission is auto-denied, because
  // there is nobody to prompt, and the denial is reported in `denied_actions`. What is still
  // missing is any way to scope it per invocation: permissions and credentials share HOME, and
  // unlike Grok there is no second variable that separates them, so BrainGate cannot hand this
  // one an isolated home the way it does for Codex and Grok. A staged run therefore keeps the
  // operator's real home, and what agy may reach elsewhere on the machine is unchecked — which
  // is the residual only the operator can accept (ADR 0008).
  // Measured 2026-09-14 against agy 1.2.2 and again 2026-09-19 against agy 1.2.7: headless
  // Antigravity auto-denies every tool that would need a prompt, and a DIRECT run needs tools — it
  // has to read the workspace it was pointed at. `--mode accept-edits`, `--mode plan` and `--sandbox`
  // were all denied for `read_file`; with a project-local allow-rule for reads it was then denied for
  // `command`; on 1.2.7 a run that needed the workspace ended with `denied_actions` and an empty
  // answer. The CLI's own answer is the `permissions.allow` rules in the operator's settings.json,
  // which every `agy` run honours. So the DIRECT gate for this provider is a *reading* of that file
  // (`nativeDirectWhenMeasured`): open when the operator has allowed headless reads there, closed
  // otherwise, and BrainGate never writes the rules on their behalf. The blanket bypass flag is not
  // used under any policy.
  google: { providerId: "google", enabled: false, nativeDirect: false, nativeDirectWhenMeasured: true, nativeDirectBlockedBecause: ANTIGRAVITY_DIRECT_REFUSAL, stagedRoles: ["planner", "reviewer", "judge"], needsOperatorAcceptance: true, minimumVersion: null, blockedReason: "Antigravity has no per-invocation permission scope: settings and credentials share HOME, so BrainGate cannot prove what one call may reach outside the project.", surface: { isolatedPerInvocation: false, toolDenial: false, declaredSubagents: false, enforcedSandbox: false } },
});

/**
 * The attestation contract for read-primary on a project snapshot.
 *
 * A snapshot-primary run executes under the *same* sandbox policy the staged roles already use: for
 * Codex, the read-only sandbox with the same accepted control keys; for Grok, the same kernel profile
 * (`strict`, network restricted) with the same isolated home. The role differs and the workspace's
 * *content* differs — a snapshot rather than a handful of context files — and neither of those is part
 * of the policy the attestation is a hash over.
 *
 * That makes reusing the existing attestation legitimate, but only because it is checked rather than
 * assumed. This table is the explicit contract, and `snapshotProfileArguments` below is what a test
 * asserts equality of: if the snapshot-mode arguments ever stop matching the profile the attestation
 * was earned under, the attestation no longer covers this mode and the test fails before the code can
 * quietly keep trusting it.
 */
/** The profile name a snapshot-primary Grok run asks for. */
export const GROK_SNAPSHOT_READ_PROFILE = GROK_SNAPSHOT_READ_SANDBOX.name;

export const SNAPSHOT_PRIMARY_CONTRACT = Object.freeze({
  openai: Object.freeze({ attestationSource: "sandbox-self-test" as const, policy: "read-only sandbox, reviewer control keys", roles: Object.freeze(["primary"] as const) }),
  xai: Object.freeze({ attestationSource: "sandbox-event-self-test" as const, policy: `${GROK_SNAPSHOT_READ_PROFILE} (strict, network restricted, BrainGate-isolated home)`, roles: Object.freeze(["primary"] as const) }),
});

/** The workspace a run is pointed at, from the two facts that decide it. */
export function workspaceModeFor(providerId: ProviderId, role: WorkflowRole, snapshotPrimary: boolean): "project" | "staged-clean" | "staged-read-snapshot" {
  if (role !== "primary") return "staged-clean";
  if (!snapshotPrimary) return "project";
  if (!snapshotPrimaryCapable(providerId)) {
    throw new BrainGateInvariantError("SHADOW_SNAPSHOT_PROVIDER_UNSUPPORTED", `${providerId} cannot run read-primary against a project snapshot.`);
  }
  return "staged-read-snapshot";
}

/** Whether this build can run the given provider as read-primary against a snapshot at all. */
export function snapshotPrimaryCapable(providerId: ProviderId): boolean {
  return PROFILES[providerId].snapshotPrimary === true;
}

/**
 * Whether this build has a DIRECT invocation for the provider: its own harness, in the workspace.
 *
 * Exported so the status surfaces can distinguish "the CLI is available", "the CLI can be driven
 * headlessly" and "BrainGate can point this CLI at the operator's own workspace" — three different
 * facts that a single `enabled` boolean was flattening into one.
 */
export function nativeDirectCapable(providerId: ProviderId, measured: MeasuredCapabilities | null = null): boolean {
  const profile = PROFILES[providerId];
  if (profile.nativeDirect === true) return true;
  // Antigravity: not a constant about the CLI but a reading of the operator's own settings. Its
  // print mode auto-denies every tool that would have prompted, and a DIRECT run has to read the
  // workspace it was pointed at — so the run is possible exactly when the operator's settings allow
  // headless reads, which is the runtime's own permission model doing what ADR 0017 says it does.
  // Both rules, because the model reaches for the shell even to read: measured 2026-09-19 on agy
  // 1.2.7 with `read_file(*)` alone, a DIRECT read still ended with `command` denied and no answer;
  // with `command(*)` beside it, the same run read the file and answered.
  return profile.nativeDirectWhenMeasured === true && measured?.headlessReads === true && measured?.headlessShell === true;
}

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
  eligibility: { readonly snapshotPrimary?: boolean; readonly direct?: boolean; readonly measured?: MeasuredCapabilities | null } = {},
): ProfileDefinition {
  if (snapshot.providerId !== model.providerId) throw new BrainGateInvariantError("SHADOW_PROVIDER_MISMATCH", "Provider snapshot and routed model do not match.");
  const profile = PROFILES[snapshot.providerId];
  if (!profile.enabled) {
    const status = shadowProviderRoleStatus(snapshot.providerId, role, { ...(acceptance === undefined ? {} : { acceptance }), now, snapshotPrimary: eligibility.snapshotPrimary === true, direct: eligibility.direct === true, measured: eligibility.measured ?? null });
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
  /** The operator's separate decision to let a role on this provider reach the network. */
  readonly networkAcceptance?: OperatorProviderAcceptance;
  readonly maxTurns?: number;
  /**
   * Set by the caller when this role runs read-primary against a BrainGate-made project snapshot,
   * with `workspaceRoot` pointing at the copy.
   *
   * Named for the *fact* rather than the provider: the caller establishes that the snapshot contract
   * holds (the explicit contract plus the provider's current sandbox attestation), and the profile
   * decides how that is executed.
   */
  readonly snapshotPrimary?: boolean;
  readonly workspaceRoot?: string;
  /** The snapshot-read attestation a Grok read-primary run is gated on. */
  readonly grokSnapshotIsolation?: GrokIsolationAttestation;
  /** This plan is being validated rather than executed, so no workspace has to exist yet. */
  readonly preview?: boolean;
  /**
   * Whether this task's budget allows more than one agent at once.
   *
   * Taken from `ExecutionBudget.maxConcurrentAgents` rather than invented here: subagents are
   * concurrent agents, so the budget that already bounds concurrency is the thing that decides
   * whether a run may fan out. T0-T2 do not; T3 and T4 do.
   */
  readonly fanOut?: boolean;
  /**
   * What a capability probe found for this build, when one has been run.
   *
   * It can only narrow the profile's declared surface, never widen it: the profile says what
   * BrainGate is willing to ask of a CLI, and the probe says what this installed build actually
   * accepts. A flag the build has dropped is refused here, with a reason, instead of failing at
   * the provider.
   */
  readonly measured?: MeasuredCapabilities;
  /**
   * How this invocation relates to a native provider session.
   *
   * Supplied by the invoker, which is the only layer that knows the model *and* the goal. Absent,
   * nothing about sessions changes: no id is pinned, no session is resumed, and the run is told not
   * to persist one — which is what every caller before M20.2 gets.
   */
  readonly nativeSession?: PlannedNativeSession;
  /**
   * Whether the runtime keeps its own harness rather than a BrainGate-declared subset of it.
   *
   * Set by the DIRECT policy (ADR 0017). What it removes is exactly the set ADR 0014 classifies as
   * legacy: the tool allowlist BrainGate wrote, the universal MCP refusal, and the declared
   * subagents that stood in for the runtime's own. What it does *not* do is grant anything: the
   * runtime's own permission mode still decides, and in a headless run a tool that would have
   * prompted is still refused — by the CLI, for its own reasons, rather than by BrainGate for a
   * reason it invented.
   *
   * Providers whose invocation is built around a staged copy refuse it rather than ignoring it,
   * because a plan that says `nativeHarness` and an argv that ignores user config is a lie.
   */
  readonly nativeHarness?: boolean;
  /**
   * Where a DIRECT Codex run's response schema is written, when one is supplied.
   *
   * Codex takes the schema as a path and enforces it; without one the model narrates, and a real run
   * did exactly that — it read the workspace correctly with its own tools and then answered in prose,
   * which the role contract could not parse. The file lives outside the workspace so it cannot join
   * the diff, and at an absolute path the run is not confined to.
   */
  readonly schemaPath?: string;
  readonly now?: Date;
}): ShadowInvocationPlan {
  const now = input.now ?? new Date();
  const snapshotPrimary = input.snapshotPrimary === true;
  const nativeHarness = input.nativeHarness === true;
  if (nativeHarness && !nativeDirectCapable(input.snapshot.providerId, input.measured ?? null)) {
    // Not a capability judgement about the CLI: it is about BrainGate's own argv for it. A provider
    // without a DIRECT branch below is invoked with a staged-copy argv — `--ignore-user-config`,
    // `--ignore-rules`, a sandbox profile earned against a copy — and re-deriving each one needs a
    // measurement this build has not taken. Reported, not silently downgraded. Antigravity is the
    // one whose answer is measured per machine: its gate is the operator's own settings.
    const blocked = PROFILES[input.snapshot.providerId].nativeDirectBlockedBecause;
    throw new BrainGateInvariantError(
      "SHADOW_NATIVE_HARNESS_UNSUPPORTED",
      blocked ?? `${input.snapshot.displayName} has no measured DIRECT invocation: its argv is built around a staged copy and a sandbox proof earned against it. Use the snapshot or worktree policy for it, or select a provider whose native harness BrainGate has measured.`,
    );
  }
  if (nativeHarness && snapshotPrimary) {
    throw new BrainGateInvariantError("SHADOW_NATIVE_HARNESS_CONFLICT", "A snapshot-primary run is the strict read posture; it cannot also be a native-harness run.");
  }
  if (snapshotPrimary && input.payload.role !== "primary") {
    throw new BrainGateInvariantError("SHADOW_SNAPSHOT_ROLE_INVALID", "A project snapshot is offered to the read-primary role only.");
  }
  if (snapshotPrimary && input.preview !== true && (input.workspaceRoot === undefined || input.workspaceRoot.length === 0)) {
    throw new BrainGateInvariantError("SHADOW_SNAPSHOT_ROOT_REQUIRED", "A snapshot-primary run requires the prepared workspace it must read.");
  }
  const profile = assertProfile(input.snapshot, input.model, input.attestation, input.acceptance, input.payload.role, now, { snapshotPrimary, direct: nativeHarness, measured: input.measured ?? null });
  const body = serializedPayload(input.payload);
  // The session decision, filled in with the real provider and model so the plan is
  // self-describing. Resolved once here rather than read from three places later.
  // Always named after the model this plan is actually for: a session decision that reached the
  // executor without a provider and model would be unusable by every reader downstream.
  const session: PlannedNativeSession = Object.freeze({
    ...(input.nativeSession ?? NO_NATIVE_SESSION),
    providerId: input.snapshot.providerId,
    modelId: input.model.modelId,
  });
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
    // The mode belongs to *this invocation*: decided by role and provider, never by a global setting.
    workspaceMode: workspaceModeFor(input.snapshot.providerId, input.payload.role, snapshotPrimary),
    writeMode: false,
    surface: measuredSurface(profile.surface, input.measured ?? null),
    attested,
    operatorAccepted: validOperatorAcceptance(input.acceptance, input.snapshot.providerId, now),
    networkAccepted: validOperatorAcceptance(input.networkAcceptance, input.snapshot.providerId, now, "operator-accepted-network-access"),
    fanOutAllowed: input.fanOut === true,
  });
  const subagents = grants(grant, "subagents") ? subagentsArgument(input.payload.role) : null;
  // A ceiling on pathology, not a budget: see ExecutionBudget.maxInspectionTurns. Clamping
  // lower than the budget asks for would silently reimpose the limit this stopped being.
  const maxTurns = Math.max(1, Math.min(60, Math.floor(input.maxTurns ?? 20)));

  if (input.snapshot.providerId === "anthropic") {
    const args = Object.freeze([
      "--restricted",
      // A DIRECT primary read answers in prose. Under an enforced schema claude 2.1.278 narrates
      // the whole answer as text and then fills the contract with a paraphrase of it through the
      // StructuredOutput tool, and both reached the terminal — every answer read twice (seen in the
      // operator's own session, 2026-09-19). The prose it streams is the answer of record, exactly
      // as for Grok and Antigravity; the staged roles and the reviewer keep the schema, because a
      // verdict has a shape and prose does not.
      "-p", nativeHarness ? (input.payload.role === "primary" ? DIRECT_PROSE_PROMPT : DIRECT_PROMPT) : SCHEMA_PROMPT,
      // A token stream, so a waiting terminal sees the answer being written rather than a
      // spinner. `--verbose` is not optional here: this build refuses stream-json without it.
      // The executor keeps only the lines the parse reads, so the extra events cost no cap.
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Session persistence is a per-invocation decision, not a property of the profile.
      //
      // M20.1 removed this flag unconditionally, which is not what native continuity needs either:
      // a run that is not continuing a goal should leave nothing behind, and a run that is should
      // leave exactly one session under an id BrainGate already knows. Measured 2026-09-13 against
      // claude 2.1.269: `--session-id <uuid>` names a new session and `--resume <uuid>` continues
      // one, both in print mode. The capability probe has to agree before either is used.
      ...(session.persistent ? [] : ["--no-session-persistence"]),
      ...sessionFlags(session),
      "--no-chrome",
      "--disable-slash-commands",
      // Exactly what the grant allows, and nothing standing by in case. The Agent tool appears
      // only when the grant and the budget both permit helpers — and the helpers are the ones
      // BrainGate defined, read-only and named. Search appears only where the operator has said
      // this provider may reach the network.
      // Under the DIRECT policy the runtime keeps its own tool set, its own MCP servers and its
      // own subagents: BrainGate wrote the allowlist, the `mcp__*` denial and the declared helpers
      // when it was substituting its own harness for the CLI's, and none of the three is a boundary
      // the operator asked for (ADR 0014, ADR 0017). The permission mode is the CLI's own, so a
      // headless run still refuses what it would have prompted for.
      ...(nativeHarness
        ? ["--permission-mode", "default"]
        : [
          "--tools", [
            "Read", "Glob", "Grep",
            ...(subagents === null ? [] : ["Agent"]),
            ...(grants(grant, "web") ? ["WebSearch", "WebFetch"] : []),
          ].join(","),
          ...(subagents === null ? [] : ["--agents", subagents]),
          "--disallowedTools", "mcp__*",
          // Denying the tools is not the same as not loading the servers: a run's own init event
          // listed the operator's MCP servers as connected while every mcp__ tool was denied. The
          // guarantee this profile publishes is `noMcp`, so the servers do not get to be there.
          "--strict-mcp-config",
          "--mcp-config", "{\"mcpServers\":{}}",
        ]),
      "--max-turns", String(maxTurns),
      "--model", input.model.modelId,
      ...(nativeHarness && input.payload.role === "primary" ? [] : ["--json-schema", schema]),
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
      nativeSession: session,
      streamDialect: "anthropic",
      // The guarantees are the ones this argv actually earns. `noMcp` and `noNetworkTools` were
      // properties of the denial flags, so with the native harness they are not claimed: what holds
      // is that the run is confined to the workspace (`--restricted`, the settings deny list for
      // secrets and version-control internals) and that the runtime's own permission mode decides
      // everything else.
      guarantees: guaranteesFor(grant, Object.freeze({
        projectOnlyRead: true,
        noProjectWrites: !nativeHarness,
        noShell: !nativeHarness,
        noNetworkTools: !nativeHarness,
        noMcp: !nativeHarness,
        noSessionPersistence: !session.persistent,
        isolatedUserConfig: !nativeHarness,
      })),
      ...(nativeHarness ? { nativeHarness: true } : {}),
      minimumVersion: profile.minimumVersion,
    });
  }

  // ------------------------------------------------------------------ DIRECT: the native harness
  //
  // Measured 2026-09-14 on this machine, by running each CLI once in a disposable git directory:
  // codex-cli 0.153.4 (`exec --json -C <dir> -s read-only`, thread id in the first JSONL event),
  // agy 1.2.2 (`--output-format json -p=...`, conversation id in the envelope), grok 1.0.24
  // (`-p --cwd <dir>`, `--session-id`/`--resume`). Each takes a prompt non-interactively, runs in a
  // working directory BrainGate chooses, and has a permission posture of its own that keeps a read
  // from writing: Codex a kernel sandbox set to `read-only`, Grok `--permission-mode default` (in a
  // headless run a tool that would prompt is refused by the CLI), Antigravity its print-mode
  // default, which is fail-closed about any tool needing permission.
  //
  // What BrainGate does *not* do here is write the argv that substitutes for the CLI's harness:
  // no tool allowlist, no MCP refusal, no isolated home, no staged copy. The operator approved this
  // run in this workspace, and the runtime's own permission mode decides the rest (ADR 0017).
  // The primary worker only. DIRECT is the policy the operator approves for the run they asked for;
  // the planner and reviewer are BrainGate's own staged roles, chosen for independence from the
  // primary, and they keep the staged posture they were built and attested for.
  if (nativeHarness && input.payload.role === "primary") {
    const directGrant = resolveToolGrant({
      role: input.payload.role,
      providerId: input.snapshot.providerId,
      workspaceMode: "project",
      writeMode: false,
      // Honest per provider: Codex keeps a kernel sandbox BrainGate did not write, and the two that
      // have none are not credited with one. No CLI here is handed a tool allowlist under DIRECT.
      surface: {
        isolatedPerInvocation: false,
        toolDenial: false,
        declaredSubagents: false,
        enforcedSandbox: input.snapshot.providerId === "openai",
      },
      attested: false,
      operatorAccepted: validOperatorAcceptance(input.acceptance, input.snapshot.providerId, now),
      networkAccepted: validOperatorAcceptance(input.networkAcceptance, input.snapshot.providerId, now, "operator-accepted-network-access"),
      fanOutAllowed: input.fanOut === true,
    });
    const directGuarantees = (base: Pick<ShadowGuarantees, "noProjectWrites" | "noShell" | "noNetworkTools" | "noMcp">) => guaranteesFor(directGrant, Object.freeze({
      projectOnlyRead: true,
      noProjectWrites: base.noProjectWrites,
      noShell: base.noShell,
      noNetworkTools: base.noNetworkTools,
      noMcp: base.noMcp,
      noSessionPersistence: !session.persistent,
      isolatedUserConfig: false,
    }));

    if (input.snapshot.providerId === "openai") {
      // `codex exec resume` accepts no `-C` and no `-s`: the working directory is the session's and
      // the sandbox is set through the config override the resume subcommand does take. Measured on
      // codex-cli 0.153.4 — `exec resume` rejects `-s` outright, and accepts `-c sandbox_mode="..."`.
      const resumeId = session.kind === "resumed" && session.sessionId !== null ? session.sessionId : null;
      const schemaArgs = input.schemaPath === undefined ? [] : ["--output-schema", input.schemaPath];
      const args = Object.freeze(resumeId === null
        ? [
          "exec",
          "--json",
          "-C", input.cwd,
          "--sandbox", "read-only",
          "--model", input.model.modelId,
          ...(session.persistent ? [] : ["--ephemeral"]),
          ...schemaArgs,
          "-",
        ]
        : [
          "exec", "resume",
          "--json",
          "--model", input.model.modelId,
          "-c", 'sandbox_mode="read-only"',
          ...(session.persistent ? [] : ["--ephemeral"]),
          ...schemaArgs,
          resumeId,
          "-",
        ]);
      if (args.includes("--dangerously-bypass-approvals-and-sandbox") || args.includes("--add-dir") || args.includes("--ignore-user-config")) {
        throw new BrainGateInvariantError("SHADOW_PROFILE_UNSAFE", "Unsafe or workspace-widening Codex flags are forbidden.");
      }
      return Object.freeze({
        providerId: "openai",
        executable: input.snapshot.binary,
        args,
        cwd: input.cwd,
        workspaceMode: workspaceModeFor("openai", input.payload.role, false),
        modelId: input.model.modelId,
        quotaPool: input.model.quotaPool,
        inputMode: "stdin",
        stdin: body,
        attachmentContent: null,
        attachmentToken: null,
        allowedEnvKeys: Object.freeze([]),
        envOverrides: Object.freeze({}),
        grant: directGrant,
        nativeSession: session,
        // Measured 2026-09-19 on codex-cli 0.153.4: `--json` is whole JSONL events, not deltas, so
        // this streams at message granularity — the narration item reaches the terminal while the
        // run is still working, and the final `agent_message` is still the answer of record.
        streamDialect: "openai",
        guarantees: directGuarantees(Object.freeze({ noProjectWrites: true, noShell: false, noNetworkTools: false, noMcp: false })),
        nativeHarness: true,
        ...(input.schemaPath === undefined ? {} : { externalFiles: Object.freeze({ [input.schemaPath]: schema }) }),
        minimumVersion: profile.minimumVersion,
      });
    }

    if (input.snapshot.providerId === "xai") {
      // No `--json-schema`: measured on grok 1.0.30, the enforced schema ends the run in one turn
      // with no tool call (see DIRECT_PROSE_PROMPT). The answer is the prose the model streams.
      const args = Object.freeze([
        "-p", `${DIRECT_PROSE_PROMPT}\n\n${body}`,
        "--cwd", input.cwd,
        "--output-format", "streaming-json",
        "--model", input.model.modelId,
        "--max-turns", String(maxTurns),
        "--verbatim",
        // The runtime's own read posture. Passed explicitly rather than left to config, because a
        // config that said `acceptEdits` would silently give a read run the write posture.
        "--permission-mode", "default",
        // Terminal presentation only: there is no alternate screen in a headless run.
        "--no-alt-screen",
        // No `--sandbox`: a profile is a staged-mode boundary BrainGate writes, and this run keeps
        // the CLI's own configuration. No `--no-subagents`, no `--disable-web-search`, no `--deny`:
        // those were BrainGate substituting its own harness, which DIRECT does not do.
        ...(session.sessionId === null ? [] : session.kind === "resumed" ? ["--resume", session.sessionId] : ["--session-id", session.sessionId]),
      ]);
      if (args.some((argument) => argument === "--always-approve" || argument === "--dangerously-skip-permissions" || argument === "bypassPermissions" || argument === "--worktree")) {
        throw new BrainGateInvariantError("SHADOW_PROFILE_UNSAFE", "Unsafe or worktree-creating Grok flags are forbidden for a DIRECT run.");
      }
      return Object.freeze({
        providerId: "xai",
        executable: input.snapshot.binary,
        args,
        cwd: input.cwd,
        workspaceMode: workspaceModeFor("xai", input.payload.role, false),
        modelId: input.model.modelId,
        quotaPool: input.model.quotaPool,
        inputMode: "stdin",
        stdin: "",
        attachmentContent: null,
        attachmentToken: null,
        allowedEnvKeys: Object.freeze(["GROK_HOME"]),
        envOverrides: Object.freeze({}),
        grant: directGrant,
        nativeSession: session,
        streamDialect: "xai",
        guarantees: directGuarantees(Object.freeze({ noProjectWrites: true, noShell: true, noNetworkTools: false, noMcp: false })),
        nativeHarness: true,
        minimumVersion: profile.minimumVersion,
      });
    }

    // Antigravity. `-p` takes its value attached, which is also the only form that cannot be broken
    // by an option landing between the flag and the prompt. No permission flag of any kind: the
    // run's tool policy is the operator's own settings file, which the gate above has already read.
    const args = Object.freeze([
      // NDJSON rather than one envelope, measured 2026-09-19 on agy 1.2.7: this build streams
      // `agent_response` text deltas as the model writes them, and its final `result` event still
      // carries `conversation_id`, `response` and `usage` — which is what makes the switch safe,
      // since goal continuity resumes on that id.
      "--output-format", "stream-json",
      "--model", input.model.modelId,
      ...antigravityEffortArgs(input.model.modelId),
      ...(session.kind === "resumed" && session.sessionId !== null ? ["--conversation", session.sessionId] : []),
      // Prose, like Grok: no schema flag is passed here either, and measured 2026-09-19 on agy 1.2.7
      // the model answers a DIRECT read in markdown. The invoker accepts that prose as the answer.
      `-p=${DIRECT_PROSE_PROMPT}\n\n${body}`,
    ]);
    if (args.some((argument) => argument === "--dangerously-skip-permissions" || argument === "--sandbox" || argument === "--add-dir" || argument === "--mode" || argument.startsWith("--mode="))) {
      throw new BrainGateInvariantError("SHADOW_PROFILE_UNSAFE", "Unsafe, sandboxed or workspace-widening Antigravity flags are forbidden for a DIRECT read.");
    }
    // What the operator's rules allow is what the plan claims: a shell rule in their settings means
    // this run may run commands, and the guarantee says so instead of promising a `noShell` the
    // runtime would not keep.
    const headlessShell = input.measured?.headlessShell === true;
    return Object.freeze({
      providerId: "google",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      workspaceMode: workspaceModeFor("google", input.payload.role, false),
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      inputMode: "stdin",
      stdin: "",
      attachmentContent: null,
      attachmentToken: null,
      allowedEnvKeys: Object.freeze([]),
      envOverrides: Object.freeze({}),
      grant: directGrant,
      nativeSession: session,
      // Measured 2026-09-19 on agy 1.2.7: token-level `text_delta` events, and the answer of record
      // still arrives in the retained `result` envelope.
      streamDialect: "google",
      guarantees: directGuarantees(Object.freeze({ noProjectWrites: true, noShell: !headlessShell, noNetworkTools: false, noMcp: false })),
      nativeHarness: true,
      minimumVersion: profile.minimumVersion,
    });
  }

  if (input.snapshot.providerId === "openai") {
    const codexStaged = PROFILES.openai.stagedRoles ?? [];
    if (!codexStaged.includes(input.payload.role) && !snapshotPrimary) {
      throw new BrainGateInvariantError("SHADOW_CODEX_ROLE_DENIED", `Codex runs staged roles only (${codexStaged.join(", ")}); ${input.payload.role} would need the real checkout, which the staged workspace does not contain.`);
    }
    const attested = snapshotPrimary
      ? validCodexIsolationAttestation(input.codexIsolation, input.snapshot, { now, minProbeVersion: CODEX_PROBE_VERSION })
      : validCodexIsolationAttestation(input.codexIsolation, input.snapshot, { now });
    if (!attested) {
      throw new BrainGateInvariantError("SHADOW_CODEX_ISOLATION_REQUIRED", snapshotPrimary
        ? "Codex read-primary requires a current sandbox self-test attestation earned under the current self-test contract, which attempts the writes a snapshot must refuse."
        : "Codex read-only workspace isolation requires a current sandbox self-test attestation for this version/platform/profile.");
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
      workspaceMode: workspaceModeFor("openai", input.payload.role, snapshotPrimary),
      ...(snapshotPrimary && input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      ...(input.preview === true ? { preview: true } : {}),
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
      nativeSession: session,
      streamDialect: null,
      guarantees: guaranteesFor(grant, Object.freeze({ projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true })),
      minimumVersion: profile.minimumVersion,
    });
  }

  if (input.snapshot.providerId === "xai") {
    const staged = PROFILES.xai.stagedRoles ?? [];
    if (!staged.includes(input.payload.role) && !snapshotPrimary) {
      throw new BrainGateInvariantError("SHADOW_GROK_ROLE_DENIED", `Grok runs staged roles only (${staged.join(", ")}); ${input.payload.role} would need the real checkout, which the sandbox does not grant.`);
    }
    // A read-primary run on a project copy executes from a BrainGate-owned home with no operator
    // plugins, so it needs the proof earned under *that* posture rather than the staged one.
    if (snapshotPrimary) {
      if (!validGrokSnapshotReadAttestation(input.grokSnapshotIsolation, input.snapshot, { now })) {
        throw new BrainGateInvariantError("SHADOW_GROK_SNAPSHOT_ISOLATION_REQUIRED", "Grok read-primary requires a current snapshot-read self-test attestation: the snapshot profile, an isolated home and no writable root.");
      }
    } else if (!validGrokIsolationAttestation(input.grokIsolation, input.snapshot, { now })) {
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
      // The policy is chosen by the mode, and its hash is what an attestation is bound to: a
      // snapshot-primary run names the snapshot-read profile, whose proof it was gated on above.
      "--sandbox", snapshotPrimary ? GROK_SNAPSHOT_READ_PROFILE : GROK_SANDBOX_PROFILE,
      // Measured: with a schema in force the stream carries the contract's JSON in `text`
      // pieces, so the answer is their concatenation and the readable part is extracted from it.
      "--output-format", "streaming-json",
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
      workspaceMode: workspaceModeFor("xai", input.payload.role, snapshotPrimary),
      ...(snapshotPrimary && input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      ...(input.preview === true ? { preview: true } : {}),
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
      nativeSession: session,
      streamDialect: "xai",
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
      // The DIRECT read's `google` dialect was measured on the print route (`-p=`) on 2026-09-19;
      // this staged run drives the CLI the other way, through `--input-format stream-json` and an
      // enforced schema, and that route's event stream has not been watched. A dialect is added
      // when someone has seen the shape, not because the flag shares a name — and a staged
      // reviewer has nobody watching a terminal anyway.
      streamDialect: null,
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
      nativeSession: session,
      streamDialect: null,
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
export function validOperatorAcceptance(
  value: OperatorProviderAcceptance | undefined,
  providerId: ProviderId,
  now = new Date(),
  // Which decision is being checked. A record of one kind never answers for the other.
  source: OperatorProviderAcceptance["source"] = "operator-accepted-unscoped-provider",
): boolean {
  if (value === undefined || value.providerId !== providerId || value.source !== source) return false;
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
  options: { readonly acceptance?: OperatorProviderAcceptance; readonly now?: Date; readonly snapshotPrimary?: boolean; readonly direct?: boolean; readonly measured?: MeasuredCapabilities | null } = {},
): Readonly<{ enabled: boolean; reason: string | null; acceptedByOperator: boolean }> {
  const profile = PROFILES[providerId];

  // DIRECT first, because it is a different question from every branch below. Those ask what
  // BrainGate can *prove* about a sandbox it wrote or a copy it made; this one asks whether the
  // operator pointed a worker at their own workspace and approved the run. The provider's own
  // permission mode is the boundary inside it, which is exactly how Claude has run under DIRECT
  // since ADR 0017 — and the reason a staged-only or acceptance-gated provider is not thereby
  // excluded: what those gates withhold is BrainGate's staged harness, not the CLI itself.
  if (options.direct === true && role === "primary") {
    if (!nativeDirectCapable(providerId, options.measured ?? null)) {
      return Object.freeze({
        enabled: false,
        reason: profile.nativeDirectBlockedBecause ?? `${profile.blockedReason ?? "Provider has no DIRECT invocation."} BrainGate has no measured native invocation for it.`,
        acceptedByOperator: false,
      });
    }
    return Object.freeze({
      enabled: true,
      reason: profile.nativeDirectWhenMeasured === true
        ? "Runs its own harness in the selected workspace under the DIRECT policy; its own settings allow headless reads and shell commands, and they decide everything else it may do inside."
        : "Runs its own harness in the selected workspace under the DIRECT policy; the operator approves the run, and the runtime's own permission mode decides what it may do inside.",
      acceptedByOperator: false,
    });
  }

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
    // The read-primary role was closed for the same reason the staged roles are open: it would need
    // the checkout. A snapshot removes that reason without granting the checkout — the provider reads
    // a copy BrainGate made — so it is the one widening this milestone makes, and only when the caller
    // has established the snapshot contract and the provider's sandbox attestation.
    if (role === "primary" && profile.snapshotPrimary === true && options.snapshotPrimary === true) {
      return Object.freeze({ enabled: true, reason: "Read-only project snapshot; requires the provider's current sandbox self-test attestation.", acceptedByOperator: false });
    }
    return Object.freeze({ enabled: false, reason: `Runs staged roles only (${staged.join(", ")}); ${role} would need the real checkout.`, acceptedByOperator: false });
  }
  if (providerId === "openai") return Object.freeze({ enabled: true, reason: "Requires current sandbox self-test attestation.", acceptedByOperator: false });
  if (staged !== undefined) return Object.freeze({ enabled: true, reason: "Runs in a kernel-sandboxed staged workspace; requires a current self-test attestation.", acceptedByOperator: false });
  return Object.freeze({ enabled: true, reason: null, acceptedByOperator: false });
}

/**
 * Whether a provider may take the read-primary path on a project snapshot, and why not when it may not.
 *
 * One function, used by the router's exclusion list, the invocation planner and the doctor, so the
 * question "may this provider read a snapshot?" has one answer rather than three that can drift. It is
 * deliberately *not* a capability score: it is a security question, and a model's scores never change
 * the answer.
 */
export function snapshotPrimaryEligibility(input: {
  readonly providerId: ProviderId;
  readonly snapshot: ProviderSnapshot;
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly grokIsolation?: GrokIsolationAttestation;
  /** The snapshot-read proof, which is a different posture from the staged one. */
  readonly grokSnapshotIsolation?: GrokIsolationAttestation;
  readonly now?: Date;
}): Readonly<{ eligible: boolean; reason: SnapshotPrimaryIneligibleReason | null; detail: string | null }> {
  const now = input.now ?? new Date();
  if (PROFILES[input.providerId].snapshotPrimary !== true) {
    return Object.freeze({
      eligible: false,
      reason: "provider-not-snapshot-capable",
      detail: input.providerId === "google"
        ? "Antigravity has no per-invocation permission scope, so it cannot be confined to a snapshot."
        : `${input.providerId} has no read-primary snapshot profile.`,
    });
  }
  if (input.snapshot.available.value !== true) {
    return Object.freeze({ eligible: false, reason: "provider-unavailable", detail: `${input.snapshot.displayName} CLI is unavailable.` });
  }
  if (input.providerId === "openai") {
    // The snapshot mode needs the *stronger* proof: the contract that demonstrated the denied writes,
    // not merely the profile hash every Codex proof shares.
    if (!validCodexIsolationAttestation(input.codexIsolation, input.snapshot, { now, minProbeVersion: CODEX_PROBE_VERSION })) {
      return Object.freeze({
        eligible: false,
        reason: "sandbox-attestation-missing-or-expired",
        detail: "Codex read-primary requires a current sandbox self-test attestation for this version, platform, profile and self-test contract (the one that proves the denied writes).",
      });
    }
    return Object.freeze({ eligible: true, reason: null, detail: null });
  }
  if (input.providerId === "xai") {
    // The staged proof is not the snapshot proof: the home, the profile and the write posture differ,
    // so a run on a project copy needs the attestation earned under that posture.
    if (!validGrokSnapshotReadAttestation(input.grokSnapshotIsolation, input.snapshot, { now })) {
      return Object.freeze({
        eligible: false,
        reason: "sandbox-attestation-missing-or-expired",
        detail: "Grok read-primary requires a current snapshot-read self-test attestation: the snapshot profile, an isolated home and no writable root.",
      });
    }
    return Object.freeze({ eligible: true, reason: null, detail: null });
  }
  return Object.freeze({ eligible: false, reason: "provider-not-snapshot-capable", detail: `${input.providerId} has no read-primary snapshot profile.` });
}
