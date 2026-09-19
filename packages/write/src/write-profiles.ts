import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import type { MeasuredCapabilities } from "@braingate/shadow";
import {
  GROK_SANDBOX_PROFILE,
  GROK_WRITE_SANDBOX,
  antigravityEffortArgs,
  jsonSchemaFor,
  resolveToolGrant,
  validCodexIsolationAttestation,
  validGrokIsolationAttestation,
  type CodexIsolationAttestation,
  type GrokIsolationAttestation,
  type SubscriptionAttestation,
  type ToolGrant,
} from "@braingate/shadow";
import { assertClaudeWriteEligible, planClaudeWriteInvocation } from "./claude-write-profile.js";
import type { WriteProviderPlan } from "./types.js";

/**
 * The providers that may hold the executing role, and what each has to prove first.
 *
 * Until now this was one provider, because M11 opened the write path with the one CLI whose
 * boundary had been measured. That was scope, not a finding — and leaving it in place is what
 * concentrated every change on a single subscription while three others sat idle.
 *
 * What protects the checkout was never the provider's good behaviour. It is BrainGate's own
 * checks on the outcome: work happens in a task worktree, the source checkout is fingerprinted
 * before and after, every changed path passes the diff guard, and no merge happens without a
 * human. Those apply identically whoever did the typing (ADR 0008). What a second provider has
 * to add is a bounded place to work — which is exactly what a grant now expresses (ADR 0010).
 */
export const WRITE_PROVIDERS: readonly ProviderId[] = Object.freeze(["anthropic", "xai", "openai"]);

export function isWriteProvider(providerId: string): providerId is ProviderId {
  return (WRITE_PROVIDERS as readonly string[]).includes(providerId);
}

/** Where Grok reads a project sandbox profile from, relative to the working directory. */
export const GROK_WRITE_SANDBOX_FILE = ".grok/sandbox.toml";
export const GROK_WRITE_PROFILE = GROK_WRITE_SANDBOX.name;

const GROK_MINIMUM = "1.0.13";

/**
 * The providers whose DIRECT write invocation was measured after Claude's (2026-09-14).
 *
 * Claude is not in this list because it is the reference implementation and has had one since
 * ADR 0017: this is the set of providers that gained a DIRECT write in the multi-provider
 * milestone, and `directWriteCapable` is the question callers should ask instead of membership.
 */
export const DIRECT_WRITE_PROVIDERS: readonly ProviderId[] = Object.freeze(["xai", "openai"]);

/**
 * Every provider that could hold a DIRECT write, before the per-machine reading is applied.
 *
 * Antigravity is here and not in `WRITE_PROVIDERS` because it has a DIRECT write invocation and no
 * worktree one: whether the DIRECT write may run is decided by `directWriteCapable`, from the
 * operator's own Antigravity settings, rather than by membership.
 */
export const DIRECT_WRITE_CANDIDATES: readonly ProviderId[] = Object.freeze(["anthropic", "xai", "openai", "google"]);

/**
 * Whether this provider may write the workspace itself under the DIRECT policy.
 *
 * Claude, Grok and Codex by measured invocation. Antigravity by the same measurement its DIRECT
 * read is gated on: its headless mode auto-denies every tool that would have prompted, and the
 * only rules it honours are the operator's own `permissions.allow` — so a DIRECT write is offered
 * exactly when those rules allow headless reads, and `--mode accept-edits` supplies the edit
 * posture the same way `acceptEdits` does for Claude and Grok. A caller that measured nothing gets
 * the answer for an unconfigured machine: no.
 */
export function directWriteCapable(providerId: ProviderId, measured: MeasuredCapabilities | null = null): boolean {
  if (providerId === "anthropic" || DIRECT_WRITE_PROVIDERS.includes(providerId)) return true;
  return providerId === "google" && measured?.headlessReads === true && measured?.headlessShell === true;
}

const ANTIGRAVITY_WRITE_REFUSAL =
  "Antigravity auto-denies every tool it would need in headless mode unless its own settings allow it, so BrainGate has no DIRECT write for it until they do: allow headless tools under permissions.allow in ~/.gemini/antigravity-cli/settings.json with both rules read_file(*) and command(*) (measured 2026-09-19 on agy 1.2.7: with the read rule alone it still reached for the shell and was denied). BrainGate reads that file and never writes it. Its DIRECT read is gated on the same rules.";

const WRITE_SCHEMA = Object.freeze({ kind: "work", summary: "string" });

const WRITE_INSTRUCTION = [
  "The JSON you receive is the complete BrainGate task brief.",
  "Make only the requested change, inside the current working directory.",
  "Do not touch secrets, agent or control-plane configuration, or version-control internals.",
  "Finish with the structured summary you were asked for.",
].join(" ");

function tuple(value: string | null): readonly [number, number, number] | null {
  const match = value?.match(/(\d+)\.(\d+)\.(\d+)/) ?? null;
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function versionAtLeast(actual: string | null, minimum: string): boolean {
  const a = tuple(actual); const m = tuple(minimum);
  if (a === null || m === null) return false;
  for (let index = 0; index < 3; index += 1) { if (a[index]! > m[index]!) return true; if (a[index]! < m[index]!) return false; }
  return true;
}

/**
 * Whether a local subscription attestation currently covers this provider.
 *
 * The same rule the read path applies (`assertAuth` in the shadow profiles): a CLI that will not say
 * how it is billed is covered by the operator's own statement, which expires with the acceptance it
 * came from.
 */
function validSubscriptionAttestation(attestations: readonly SubscriptionAttestation[], providerId: string, now: Date): boolean {
  const value = attestations.find((entry) => entry.providerId === providerId && entry.mode === "subscription");
  if (value === undefined) return false;
  const observed = new Date(value.observedAt);
  if (Number.isNaN(observed.getTime()) || observed.getTime() > now.getTime() + 60_000 || now.getTime() - observed.getTime() > 30 * 24 * 60 * 60 * 1000) return false;
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    const expires = new Date(value.expiresAt);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return false;
  }
  return true;
}

function assertCommonEligibility(snapshot: ProviderSnapshot, model: ModelRef, options: { readonly nativeHarness?: boolean; readonly measured?: MeasuredCapabilities | null; readonly attestations?: readonly SubscriptionAttestation[]; readonly now?: Date } = {}): void {
  if (snapshot.providerId !== model.providerId) throw new BrainGateInvariantError("WRITE_PROVIDER_MISMATCH", "Provider snapshot and routed model do not match.");
  // A worktree write needs a worktree profile. A DIRECT write needs a DIRECT one, which is a
  // different list: Antigravity has the second and not the first.
  const hasProfile = options.nativeHarness === true
    ? directWriteCapable(snapshot.providerId, options.measured ?? null) || DIRECT_WRITE_CANDIDATES.includes(snapshot.providerId)
    : isWriteProvider(snapshot.providerId);
  if (!hasProfile) throw new BrainGateInvariantError("WRITE_PROVIDER_BLOCKED", `${snapshot.displayName} has no write profile: BrainGate cannot bound where a change it makes would land.`);
  if (snapshot.available.value !== true) throw new BrainGateInvariantError("WRITE_PROVIDER_UNAVAILABLE", `${snapshot.displayName} CLI is unavailable.`);
  // The read path's rule, applied to the write: native proof first, the operator's own attestation
  // when discovery reports unknown, and a refusal for API billing or a signed-out CLI either way.
  // Antigravity is the case: its CLI never says how it is billed, the operator's acceptance says
  // subscription, and the write path was refusing what the read path had already accepted.
  if (snapshot.authMode.value === "api") {
    throw new BrainGateInvariantError("WRITE_SUBSCRIPTION_REQUIRED", `${snapshot.displayName} is authenticated for API billing, not subscription write usage.`);
  }
  if (snapshot.authState.value === "unauthenticated") {
    throw new BrainGateInvariantError("WRITE_SUBSCRIPTION_REQUIRED", `${snapshot.displayName} is not authenticated.`);
  }
  const natively = snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription";
  if (!natively && !validSubscriptionAttestation(options.attestations ?? [], snapshot.providerId, options.now ?? new Date())) {
    throw new BrainGateInvariantError("WRITE_SUBSCRIPTION_REQUIRED", `${snapshot.displayName} write mode requires proven subscription authentication; API/unknown auth is refused.`);
  }
  if (snapshot.capabilities.value.headless !== true || snapshot.capabilities.value.modelPinning !== true) {
    throw new BrainGateInvariantError("WRITE_CAPABILITY_UNPROVEN", `${snapshot.displayName} headless/model-pinning capability is not proven by discovery.`);
  }
  if (snapshot.models.value !== null && snapshot.models.value.length > 0 && !snapshot.models.value.includes(model.modelId)) {
    throw new BrainGateInvariantError("WRITE_MODEL_UNAVAILABLE", `Routed model ${model.modelId} is not in ${snapshot.displayName}'s discovered model list.`);
  }
}

export interface WriteEligibilityProof {
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly grokIsolation?: GrokIsolationAttestation;
  /** The operator's subscription attestations, for a CLI whose discovery reports unknown billing. */
  readonly attestations?: readonly SubscriptionAttestation[];
  /**
   * Whether this write runs in the workspace itself under the DIRECT policy (ADR 0017).
   *
   * Only Claude has an invocation that can honour it: the Codex and Grok write argv are built
   * around a task worktree and a sandbox profile earned against one, so they refuse rather than
   * silently running with a boundary they were not proven under.
   */
  readonly nativeHarness?: boolean;
  /**
   * What a capability probe found for this build, when one has been run.
   *
   * The write path's copy of the same reading the read path takes. It decides one thing here: whether
   * Antigravity's own settings allow the headless reads a DIRECT write needs before it can edit.
   */
  readonly measured?: MeasuredCapabilities | null;
  /**
   * The native session this write runs in, when one was resolved.
   *
   * Structural rather than imported: the decision is made above this layer and passed down as data,
   * exactly as the read path does it. Absent, the write profile behaves as it always did — no id
   * pinned, no session resumed, and the run told not to persist one.
   */
  readonly session?: WriteNativeSession | null;
  readonly now?: Date;
}

/** The subset of the session decision a write profile needs to write its flags. */
export interface WriteNativeSession {
  readonly kind: "fresh" | "resumed" | "handoff" | "unsupported" | "disabled";
  readonly sessionId: string | null;
  readonly persistent: boolean;
}

/**
 * Whether this provider may hold the executing role at all.
 *
 * Grok and Codex both work inside a sandbox, and a sandbox nobody checked is a claim rather than
 * a boundary — so each needs the same self-test attestation the read path already requires,
 * bound to this build, this platform, and the policy it was earned under.
 */
export function assertWriteEligible(snapshot: ProviderSnapshot, model: ModelRef, proof: WriteEligibilityProof = {}): void {
  if (snapshot.providerId === "anthropic") { assertClaudeWriteEligible(snapshot, model); return; }
  const now = proof.now ?? new Date();
  assertCommonEligibility(snapshot, model, { ...(proof.nativeHarness === true ? { nativeHarness: true } : {}), measured: proof.measured ?? null, attestations: proof.attestations ?? [], now });
  if (proof.nativeHarness === true) {
    // DIRECT. The boundary is the workspace the operator selected and the run they approved, and
    // the permission posture is the CLI's own: Codex's kernel sandbox at `workspace-write`, Grok's
    // `acceptEdits`, Antigravity's `--mode accept-edits` on top of the reads its own settings allow.
    // There is no BrainGate-written sandbox profile here, so there is no self-test about one to
    // demand — asking for it would refuse the very invocation this path exists to make, for a
    // boundary it does not use.
    if (!directWriteCapable(snapshot.providerId, proof.measured ?? null)) {
      throw new BrainGateInvariantError(
        "WRITE_NATIVE_HARNESS_UNSUPPORTED",
        snapshot.providerId === "google" ? ANTIGRAVITY_WRITE_REFUSAL : `${snapshot.displayName} has no measured DIRECT write invocation.`,
      );
    }
    return;
  }
  if (snapshot.providerId === "xai") {
    if (!versionAtLeast(snapshot.version.value, GROK_MINIMUM)) {
      throw new BrainGateInvariantError("WRITE_VERSION_TOO_OLD", `Grok must be at least ${GROK_MINIMUM}: below it a sandbox profile that cannot be applied warns and continues.`);
    }
    // Bound to the write profile's own hash: a proof earned under the read-only staged profile
    // says nothing about the one that grants writes.
    if (!validGrokIsolationAttestation(proof.grokIsolation, snapshot, { now, policy: GROK_WRITE_SANDBOX })) {
      throw new BrainGateInvariantError("WRITE_GROK_ISOLATION_REQUIRED", "A Grok write requires a current sandbox self-test attestation for this version/platform, earned under the write profile.");
    }
    return;
  }
  if (snapshot.providerId !== "openai") {
    // Antigravity has a DIRECT write and no worktree profile. Saying so here rather than falling
    // through to Codex's rule keeps the reason the operator sees the true one.
    throw new BrainGateInvariantError(
      "WRITE_NATIVE_HARNESS_UNSUPPORTED",
      `${snapshot.displayName} has a DIRECT write profile only. Choose the direct policy for it, or a provider with a worktree write profile.`,
    );
  }
  if (!validCodexIsolationAttestation(proof.codexIsolation, snapshot, { now })) {
    throw new BrainGateInvariantError("WRITE_CODEX_ISOLATION_REQUIRED", "A Codex write requires a current sandbox self-test attestation for this version/platform/profile.");
  }
}

/**
 * The grant a write runs under.
 *
 * `attested` is derived from the same check that decided eligibility rather than written as a
 * literal beside it. They cannot disagree that way, and the ADR's sentence — nothing above read
 * without a current proof — is enforced by the code that reads the proof instead of by a
 * constant that happens to match it today.
 */
function writeGrant(providerId: ProviderId, attested: boolean, nativeHarness = false): ToolGrant {
  return resolveToolGrant({
    role: "primary",
    providerId,
    // The mode this invocation actually uses, so the plan and the receipt report the boundary the
    // run had rather than the one the strict modes have.
    workspaceMode: nativeHarness ? "project" : "task-worktree",
    writeMode: true,
    surface: {
      isolatedPerInvocation: true,
      toolDenial: true,
      // Only the two CLIs that take definitions BrainGate wrote; Codex has none to bound.
      declaredSubagents: providerId === "anthropic" || providerId === "xai",
      // Claude's write profile is bounded by its settings file, not by the kernel — which is
      // enough to withhold a shell and not enough to grant one.
      enforcedSandbox: providerId === "xai" || providerId === "openai",
    },
    attested,
    operatorAccepted: false,
    // A write is T0-T2 work, which is budgeted for one agent at a time.
    fanOutAllowed: false,
  });
}

export interface WriteInvocationInput {
  readonly snapshot: ProviderSnapshot;
  readonly model: ModelRef;
  /**
   * Where the worker runs: a task worktree under the worktree policy, the selected workspace under
   * DIRECT. Which one it is decides the boundary, so the caller states it rather than leaving it to
   * be inferred from the path.
   */
  readonly cwd: string;
  /** Whether the runtime keeps its own harness here, which only DIRECT asks for. */
  readonly nativeHarness?: boolean;
  /** The native session this write runs in, when one was resolved. */
  readonly session?: WriteNativeSession | null;
  readonly task: string;
  readonly context: unknown;
  readonly findings?: readonly string[];
  readonly candidateOutput?: string | null;
  readonly maxTurns?: number;
  readonly schemaPath?: string;
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly grokIsolation?: GrokIsolationAttestation;
  /** What a capability probe found for this build; decides Antigravity's DIRECT write. */
  readonly measured?: MeasuredCapabilities | null;
  /** The operator's subscription attestations, for a CLI whose discovery reports unknown billing. */
  readonly attestations?: readonly SubscriptionAttestation[];
  readonly now?: Date;
}

function brief(input: WriteInvocationInput): string {
  const body = JSON.stringify(Object.freeze({
    schemaVersion: 1,
    task: input.task,
    context: input.context,
    findings: Object.freeze([...(input.findings ?? [])]),
    candidateOutput: input.candidateOutput ?? null,
    // `worktreeOnly` was hard-coded true, so a DIRECT worker was told its change had to stay inside a
    // task worktree while its cwd was the operator's workspace — a contradiction in the brief, and
    // the kind a careful worker resolves by changing nothing.
    constraints: Object.freeze({ smallChangeOnly: true, worktreeOnly: input.nativeHarness !== true, noSecrets: true, noAgentConfigChanges: true }),
    responseContract: WRITE_SCHEMA,
  }));
  if (body.length === 0 || body.length > 2_000_000) throw new BrainGateInvariantError("WRITE_PAYLOAD_INVALID", "Write payload must be between 1 and 2,000,000 characters.");
  return body;
}

/**
 * A DIRECT write, for the providers whose native write posture BrainGate has measured.
 *
 * Measured 2026-09-14 on this machine. Each of the three has a way to be told "make this edit
 * without asking me" that is narrower than a blanket bypass, and that is what an approved DIRECT
 * write uses:
 *
 *   codex-cli 0.153.4  `-s workspace-write`: the kernel sandbox allows writes inside the working
 *                      root and nowhere else, which is the workspace. No approval prompt exists in
 *                      `exec`, so nothing waits for an answer BrainGate could not give.
 *   grok 1.0.24        `--permission-mode acceptEdits`: edits are approved, everything else still
 *                      needs an approval a headless run cannot give.
 *   agy 1.2.2          `--mode accept-edits`: the same posture in Antigravity's own vocabulary.
 *
 * What is deliberately absent is every flag BrainGate used to substitute for the CLI's harness: no
 * isolated home, no `--ignore-user-config`, no tool allowlist, no sandbox profile BrainGate wrote,
 * no `--worktree`. The workspace is the boundary, the operator approved the run, and the diff
 * guard observes what actually changed afterwards.
 */
function planDirectWrite(input: WriteInvocationInput): WriteProviderPlan {
  const now = input.now ?? new Date();
  const body = brief({ ...input, context: input.context });
  const maxTurns = Math.max(1, Math.min(60, Math.floor(input.maxTurns ?? 20)));
  const schema = jsonSchemaFor(WRITE_SCHEMA);
  const session = input.session ?? null;
  const resumedId = session?.kind === "resumed" && session.sessionId !== null ? session.sessionId : null;
  const persistent = session?.persistent === true;
  const grant = writeGrant(input.snapshot.providerId, false, true);

  if (input.snapshot.providerId === "openai") {
    const schemaPath = input.schemaPath;
    if (schemaPath === undefined) throw new BrainGateInvariantError("WRITE_SCHEMA_PATH_REQUIRED", "A Codex write needs a schema path outside the workspace, so the schema cannot join the diff.");
    const args = Object.freeze(resumedId === null
      ? [
        "exec",
        "--json",
        "-C", input.cwd,
        "--sandbox", "workspace-write",
        "--model", input.model.modelId,
        ...(persistent ? [] : ["--ephemeral"]),
        "--output-schema", schemaPath,
        "-",
      ]
      : [
        "exec", "resume",
        "--json",
        "--model", input.model.modelId,
        "-c", 'sandbox_mode="workspace-write"',
        ...(persistent ? [] : ["--ephemeral"]),
        "--output-schema", schemaPath,
        resumedId,
        "-",
      ]);
    if (args.includes("--dangerously-bypass-approvals-and-sandbox") || args.includes("--add-dir") || args.includes("--ignore-user-config")) {
      throw new BrainGateInvariantError("WRITE_PROFILE_UNSAFE", "Unsafe or workspace-widening Codex flags are forbidden for a write.");
    }
    return Object.freeze({
      providerId: "openai",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      stdin: `${WRITE_INSTRUCTION}\n\n${body}`,
      allowedEnvKeys: Object.freeze([]),
      envOverrides: Object.freeze({}),
      grant,
      externalFiles: Object.freeze({ [schemaPath]: JSON.stringify(schema, null, 2) }),
    });
  }

  if (input.snapshot.providerId === "xai") {
    const args = Object.freeze([
      "-p", `${WRITE_INSTRUCTION}\n\n${body}`,
      "--cwd", input.cwd,
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema),
      "--model", input.model.modelId,
      "--max-turns", String(maxTurns),
      "--verbatim",
      // Edits approved; nothing else is. Never `--always-approve`, which approves every tool.
      "--permission-mode", "acceptEdits",
      "--no-alt-screen",
      ...(resumedId === null
        ? (session?.kind === "fresh" && session.sessionId !== null ? ["--session-id", session.sessionId] : [])
        : ["--resume", resumedId]),
    ]);
    if (args.some((argument) => argument === "--always-approve" || argument === "bypassPermissions" || argument === "--dangerously-skip-permissions" || argument === "--worktree" || argument === "--sandbox")) {
      throw new BrainGateInvariantError("WRITE_PROFILE_UNSAFE", "Unsafe, sandboxed or worktree-creating Grok flags are forbidden for a DIRECT write.");
    }
    return Object.freeze({
      providerId: "xai",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      stdin: "",
      allowedEnvKeys: Object.freeze(["GROK_HOME"]),
      envOverrides: Object.freeze({}),
      grant,
    });
  }

  if (input.snapshot.providerId !== "google") {
    throw new BrainGateInvariantError("WRITE_NATIVE_HARNESS_UNSUPPORTED", `${input.snapshot.displayName} has no measured DIRECT write invocation.`);
  }
  // Antigravity. Eligibility above has already read the operator's settings: headless reads are
  // allowed there, or this branch is never reached. `--mode accept-edits` is the edit posture in
  // Antigravity's own vocabulary (measured 2026-09-14 on agy 1.2.2, flag unchanged on 1.2.7);
  // anything else the run may do is decided by the same settings, and no bypass flag is passed.
  // `-p` takes its value attached, the one form no option can land inside.
  const args = Object.freeze([
    "--output-format", "json",
    "--model", input.model.modelId,
    // The tier the model id already names, never a fixed one: measured 2026-09-19 on agy 1.2.7 a
    // mismatched `--effort` aborts the run before a single token is spent (see
    // `antigravityEffortArgs`). The hard-coded `medium` here refused every write on a model whose
    // id ends in `-low` or `-high`.
    ...antigravityEffortArgs(input.model.modelId),
    "--mode", "accept-edits",
    ...(resumedId === null ? [] : ["--conversation", resumedId]),
    `-p=${WRITE_INSTRUCTION}\n\n${body}`,
  ]);
  if (args.some((argument) => argument === "--dangerously-skip-permissions" || argument === "--sandbox" || argument === "--add-dir")) {
    throw new BrainGateInvariantError("WRITE_PROFILE_UNSAFE", "Unsafe, sandboxed or workspace-widening Antigravity flags are forbidden for a DIRECT write.");
  }
  return Object.freeze({
    providerId: "google",
    executable: input.snapshot.binary,
    args,
    cwd: input.cwd,
    modelId: input.model.modelId,
    quotaPool: input.model.quotaPool,
    stdin: "",
    allowedEnvKeys: Object.freeze([]),
    envOverrides: Object.freeze({}),
    grant,
  });
}

/**
 * The executing role's invocation, for whichever provider was routed to it.
 *
 * Claude keeps its own profile unchanged. The two additions work the same way as each other: a
 * bounded working directory, a kernel-enforced sandbox, a schema the CLI applies, and no route
 * to anything outside the worktree.
 */
export function planWriteInvocation(input: WriteInvocationInput): WriteProviderPlan {
  const now = input.now ?? new Date();
  assertWriteEligible(input.snapshot, input.model, {
    ...(input.codexIsolation === undefined ? {} : { codexIsolation: input.codexIsolation }),
    ...(input.grokIsolation === undefined ? {} : { grokIsolation: input.grokIsolation }),
    ...(input.nativeHarness === true ? { nativeHarness: true } : {}),
    ...(input.measured === undefined ? {} : { measured: input.measured }),
    ...(input.attestations === undefined ? {} : { attestations: input.attestations }),
    now,
  });

  if (input.snapshot.providerId === "anthropic") {
    // Claude's write boundary is its settings file and tool allowlist, not a kernel sandbox, so
    // there is no sandbox attestation to hold and none is claimed: the grant withholds `shell` on
    // exactly that ground.
    const plan = planClaudeWriteInvocation(input);
    return Object.freeze({ ...plan, grant: writeGrant("anthropic", false, input.nativeHarness === true) });
  }

  if (input.nativeHarness === true) return planDirectWrite(input);

  const body = brief(input);
  const maxTurns = Math.max(1, Math.min(60, Math.floor(input.maxTurns ?? 20)));
  const schema = jsonSchemaFor(WRITE_SCHEMA);

  if (input.snapshot.providerId === "xai") {
    const grant = writeGrant("xai", validGrokIsolationAttestation(input.grokIsolation, input.snapshot, { now, policy: GROK_WRITE_SANDBOX }));
    const args = Object.freeze([
      "-p", `${WRITE_INSTRUCTION}\n\n${body}`,
      "--cwd", input.cwd,
      // A custom profile, never a built-in one: only a custom profile that fails to apply aborts
      // the run (ADR 0009). `strict` confines writes to this worktree; the deny list puts secrets
      // out of reach of the kernel rather than out of bounds by instruction.
      "--sandbox", GROK_WRITE_PROFILE,
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema),
      "--model", input.model.modelId,
      "--max-turns", String(maxTurns),
      "--verbatim",
      "--permission-mode", "acceptEdits",
      "--disable-web-search",
      "--no-subagents",
      "--no-plan",
      "--no-alt-screen",
      "--deny", "WebFetch",
      "--deny", "WebSearch",
    ]);
    if (args.some((argument) => argument === "--always-approve" || argument === "bypassPermissions" || argument === "--dangerously-skip-permissions" || argument === GROK_SANDBOX_PROFILE)) {
      throw new BrainGateInvariantError("WRITE_PROFILE_UNSAFE", "Unsafe Grok approval flags, or the read-only staged profile, are forbidden for a write.");
    }
    return Object.freeze({
      providerId: "xai",
      executable: input.snapshot.binary,
      args,
      cwd: input.cwd,
      modelId: input.model.modelId,
      quotaPool: input.model.quotaPool,
      stdin: "",
      allowedEnvKeys: Object.freeze(["GROK_HOME", "GROK_CLAUDE_MCPS_ENABLED", "GROK_CURSOR_MCPS_ENABLED", "GROK_MANAGED_MCPS_ENABLED"]),
      envOverrides: Object.freeze({ GROK_CLAUDE_MCPS_ENABLED: "false", GROK_CURSOR_MCPS_ENABLED: "false", GROK_MANAGED_MCPS_ENABLED: "false" }),
      grant,
      runtimeFiles: Object.freeze({ [GROK_WRITE_SANDBOX_FILE]: GROK_WRITE_SANDBOX.toml }),
    });
  }

  if (input.snapshot.providerId !== "openai") {
    // Antigravity has a measured DIRECT write and no worktree profile: the only sandbox BrainGate
    // could point it at is one it wrote and proved, and it has proved none for this CLI.
    throw new BrainGateInvariantError(
      "WRITE_NATIVE_HARNESS_UNSUPPORTED",
      `${input.snapshot.displayName} has a DIRECT write profile only. Choose the direct policy for it, or a provider with a worktree write profile.`,
    );
  }
  const schemaPath = input.schemaPath;
  if (schemaPath === undefined) throw new BrainGateInvariantError("WRITE_SCHEMA_PATH_REQUIRED", "A Codex write needs a schema path outside the worktree, so the schema cannot join the diff.");
  const args = Object.freeze([
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--model", input.model.modelId,
    "-C", input.cwd,
    // Writes are confined to the working root by the sandbox, which is the worktree and nothing
    // else. `--add-dir` would widen exactly that, so it is never passed.
    "--sandbox", "workspace-write",
    "--output-schema", schemaPath,
    "-",
  ]);
  if (args.includes("--dangerously-bypass-approvals-and-sandbox") || args.includes("--full-auto") || args.includes("--add-dir") || args.includes("--approve-for-me")) {
    throw new BrainGateInvariantError("WRITE_PROFILE_UNSAFE", "Unsafe or workspace-widening Codex flags are forbidden for a write.");
  }
  return Object.freeze({
    providerId: "openai",
    executable: input.snapshot.binary,
    args,
    cwd: input.cwd,
    modelId: input.model.modelId,
    quotaPool: input.model.quotaPool,
    stdin: `${WRITE_INSTRUCTION}\n\n${body}`,
    allowedEnvKeys: Object.freeze(["CODEX_HOME"]),
    envOverrides: Object.freeze({}),
    grant: writeGrant("openai", validCodexIsolationAttestation(input.codexIsolation, input.snapshot, { now })),
    externalFiles: Object.freeze({ [schemaPath]: JSON.stringify(schema, null, 2) }),
  });
}
