import type { ProviderId } from "@braingate/providers";
import { randomUUID } from "node:crypto";
import { isNativeSessionKind, type NativeSessionDecision, type NativeSessionKind, type ProviderSessionRecord, type SessionExecutionEnvelope, type SessionUnusableReason } from "./types.js";

/**
 * What one runtime can actually do about native sessions, as measured.
 *
 * These are readings with a date and a version, not standing facts. Each CLI here ships weekly, so
 * a limitation recorded today is a measurement that expires — re-measure before building anything
 * on a `false`, and before telling an operator their subscription cannot do something it now can.
 *
 * Measured 2026-09-13 against: claude 2.1.269, codex-cli 0.153.4, agy 1.2.2, grok 1.0.24,
 * copilot 0.0.358. Read from each CLI's own `--help`; no model call was made to obtain any of it.
 */
/** How a runtime's session id becomes known to BrainGate. */
export const SESSION_ID_SOURCES = ["pinned", "reported", "none"] as const;
export type SessionIdSource = (typeof SESSION_ID_SOURCES)[number];

export interface RuntimeSessionPolicy {
  /**
   * Where a fresh run's session id comes from.
   *
   *   `pinned`   the caller names it before the run, so the reference exists even if the process
   *              dies mid-run. Claude and Grok.
   *   `reported` the CLI mints it and publishes it in its own output, which BrainGate reads back.
   *              Codex (`thread.started.thread_id`) and Antigravity (`conversation_id`). Measured
   *              2026-09-14: both publish it in the first structured line, before any model work,
   *              so the window in which a run has no id yet is the window before it starts.
   *   `none`     no id to be had; continuity is the goal handoff.
   */
  readonly idSource: SessionIdSource;
  /**
   * Whether invoking this runtime writes a session that can be resumed later.
   *
   * Separate from `idSource` because a runtime can pin an id *and* be told not to persist, and
   * because persistence has consequences of its own: it is state the provider keeps.
   */
  readonly persistsSessions: boolean;
  /** The flag that names a new session, as `[flag, value]` pairs. Empty when nothing can be pinned. */
  readonly newSessionArgs: (sessionId: string) => readonly string[];
  /** The flag that resumes an existing session. */
  readonly resumeArgs: (sessionId: string) => readonly string[];
  /** The flag that suppresses persistence entirely, when the run may not leave a session behind. */
  readonly noPersistenceArgs: readonly string[];
  /**
   * Whether resuming is offered at all, and if not, why not.
   *
   * A runtime can have the flags and still not be offered: `grok` supports both pinning and
   * resuming, and its sessions are recorded per working directory *outside* the sandbox that the
   * rest of Grok's isolation is earned on — so persisting one would leave a record of the run in
   * the operator's own home, which is a change to the security posture rather than a feature. The
   * policy says no and the reason says which kind of no it is.
   */
  readonly resumeOffered: boolean;
  readonly notOfferedBecause: SessionUnusableReason | null;
  /**
   * The capability-probe feature whose reading must agree before continuity is offered.
   *
   * The policy is a claim about a CLI; the probe is a reading of the build that is installed. Where
   * they disagree the reading wins, and it can only ever take the capability away — a build that
   * dropped `--session-id` refuses continuity rather than failing at the provider with a flag error.
   */
  readonly probeFeature: "sessionIdPinning" | "sessionResume";
}

const ANTHROPIC_SESSION: RuntimeSessionPolicy = Object.freeze({
  idSource: "pinned" as const,
  persistsSessions: true,
  newSessionArgs: (sessionId: string) => Object.freeze(["--session-id", sessionId]),
  resumeArgs: (sessionId: string) => Object.freeze(["--resume", sessionId]),
  noPersistenceArgs: Object.freeze(["--no-session-persistence"]),
  resumeOffered: true,
  notOfferedBecause: null,
  probeFeature: "sessionIdPinning" as const,
});

export const RUNTIME_SESSION_POLICIES: Readonly<Record<ProviderId, RuntimeSessionPolicy>> = Object.freeze({
  anthropic: ANTHROPIC_SESSION,
  openai: Object.freeze({
    // Measured 2026-09-14 against codex-cli 0.153.4: `codex exec --json` opens its stream with
    // `{"type":"thread.started","thread_id":"…"}`, and `codex exec resume <id>` continued that
    // session in a real probe — the second turn answered from the first turn's instruction.
    idSource: "reported" as const,
    persistsSessions: true,
    newSessionArgs: () => Object.freeze([]),
    resumeArgs: (sessionId: string) => Object.freeze(["exec", "resume", sessionId]),
    noPersistenceArgs: Object.freeze(["--ephemeral"]),
    resumeOffered: true,
    notOfferedBecause: null,
    probeFeature: "sessionResume" as const,
  }),
  google: Object.freeze({
    // Measured 2026-09-14 against agy 1.2.2: `--output-format json` answers with a
    // `conversation_id`, and `--conversation <id>` continued it — the second run reported
    // `num_turns: 2` and answered from the first run's instruction.
    idSource: "reported" as const,
    persistsSessions: true,
    newSessionArgs: () => Object.freeze([]),
    resumeArgs: (sessionId: string) => Object.freeze(["--conversation", sessionId]),
    noPersistenceArgs: Object.freeze([]),
    resumeOffered: true,
    notOfferedBecause: null,
    probeFeature: "sessionResume" as const,
  }),
  xai: Object.freeze({
    idSource: "pinned" as const,
    persistsSessions: true,
    newSessionArgs: (sessionId: string) => Object.freeze(["--session-id", sessionId]),
    resumeArgs: (sessionId: string) => Object.freeze(["--resume", sessionId]),
    noPersistenceArgs: Object.freeze([]),
    // Grok has no flag that suppresses persistence, and it does not need one: its sessions are its
    // own, in its own home, exactly as they are when the operator runs `grok` directly. BrainGate
    // holding a reference to one is not a claim to own it, and where a runtime keeps its files was
    // never a reason to refuse continuity.
    //
    // Offered on the same evidence as Claude and after the same measurement (grok 1.0.24,
    // 2026-09-13): `-s, --session-id <UUID>` names a new conversation and `-r, --resume <id>`
    // continues it. Whether a *particular* session can be continued is decided per run by the
    // workspace check, which is a fact about where the session was written rather than a policy
    // about where the runtime may keep it.
    resumeOffered: true,
    notOfferedBecause: null,
    probeFeature: "sessionIdPinning" as const,
  }),
  "github-copilot": Object.freeze({
    idSource: "none" as const,
    persistsSessions: true,
    newSessionArgs: () => Object.freeze([]),
    resumeArgs: (sessionId: string) => Object.freeze(["--resume", sessionId]),
    noPersistenceArgs: Object.freeze([]),
    resumeOffered: false,
    notOfferedBecause: "provider-does-not-expose-session-ids" as const,
    probeFeature: "sessionIdPinning" as const,
  }),
});

/**
 * Which roles may hold a native session.
 *
 * The primary only, and this is a design decision rather than an omission. A planner is asked for
 * an approach and a reviewer is asked for an independent verdict; resuming either one would hand
 * it its own earlier opinion and quietly turn a second opinion into a first. Independence is the
 * whole value of those roles, so their sessions are not persisted across turns.
 */
export const SESSION_CONTINUITY_ROLES: readonly string[] = Object.freeze(["primary"]);

/**
 * What kind of reason a restriction has, per ADR 0014.
 *
 * `legacy` is the one that matters: a restriction with no current justification, which the default
 * interactive experience should not keep without a concrete reason. Naming the classes in code keeps
 * the ADR's table and the product's defaults from drifting, and gives the next slice a list to work
 * through rather than a paragraph to re-read.
 */
export const RESTRICTION_CLASSES = ["native-runtime", "operator-policy", "unattended-safety", "legacy", "strict-mode"] as const;
export type RestrictionClass = (typeof RESTRICTION_CLASSES)[number];

export interface RestrictionClassification {
  readonly id: string;
  readonly classification: RestrictionClass;
  readonly note: string;
}

/**
 * The restrictions ADR 0014 classifies, as data.
 *
 * Kept next to the session policy because the two are read together — whether continuity is offered
 * depends on what the runtime permits, and whether a *capability* is offered depends on which class
 * its restriction falls in.
 */
export const RESTRICTION_CLASSIFICATIONS: readonly RestrictionClassification[] = Object.freeze([
  Object.freeze({ id: "codex-ephemeral", classification: "native-runtime", note: "Part of the isolation contract the Codex snapshot proof was earned under." }),
  Object.freeze({ id: "grok-sandbox-profile", classification: "native-runtime", note: "The CLI's own enforcement, proven per run by self-test." }),
  Object.freeze({ id: "codex-sandbox-profile", classification: "native-runtime", note: "The CLI's own enforcement, proven per run by self-test." }),
  Object.freeze({ id: "grok-not-read-primary", classification: "native-runtime", note: "Its sandbox writes to its own working directory; snapshot-read is the mode that removes the reason." }),
  Object.freeze({ id: "project-scoped-data", classification: "operator-policy", note: "ADR 0002. Unrelated to tool breadth." }),
  Object.freeze({ id: "budget-and-concurrency-ceilings", classification: "operator-policy", note: "The operator's spend and runaway bounds." }),
  Object.freeze({ id: "read-primary-without-shell", classification: "legacy", note: "No current justification for denying a read-only run the shell its runtime would give it. Lifting it needs a read-only-repository overlay, not a blanket denial." }),
  Object.freeze({ id: "universal-mcp-refusal", classification: "legacy", note: "Contradicts preservation. Replacing it needs a per-server policy rather than none-or-all." }),
  Object.freeze({ id: "braingate-declared-subagents", classification: "legacy", note: "Should be an option, not the only way helpers exist." }),
  Object.freeze({ id: "snapshot-worktree-isolation", classification: "strict-mode", note: "Kept and selectable." }),
]);

/** The restrictions a future slice should work through first. */
export function legacyRestrictions(): readonly RestrictionClassification[] {
  return Object.freeze(RESTRICTION_CLASSIFICATIONS.filter((item) => item.classification === "legacy"));
}

/**
 * The envelope a run is about to execute under, from what the run is for.
 *
 * Computed from the same inputs both times — intent, policy, role, provider — so the envelope
 * recorded when a session is created and the envelope compared when it is resumed are the same
 * function of the same facts. That is what makes compatibility a comparison rather than a guess.
 */
export function sessionEnvelopeFor(input: {
  readonly intent: "read" | "write";
  readonly policy: string;
  readonly role: string;
  readonly providerId: ProviderId;
}): SessionExecutionEnvelope {
  // What the invocation tells the runtime, per provider and intent. The read profile's prompt is a
  // standing instruction the session carries for its whole life, and it is the reason a read session
  // cannot be handed a write: the CLI would be refusing its own earlier instruction, not ours.
  const readOnlyInstructions = input.intent === "read";
  const permissionMode = input.providerId === "anthropic"
    ? (input.intent === "write" ? "acceptEdits" : "default")
    : input.role === "primary" ? "acceptEdits" : null;
  return Object.freeze({ intent: input.intent, policy: input.policy, role: input.role, readOnlyInstructions, permissionMode });
}

/**
 * Whether a stored session may be resumed for a request with this envelope, and why not.
 *
 * The rule, stated once so every surface reports the same answer:
 *
 * - a **read** session may serve a read request in the same role, policy and permission posture;
 * - a **write** session may serve a write request on the same terms;
 * - **any change of intent is refused**, in both directions. A read session carries a standing
 *   instruction not to modify anything, and asking it to modify would have it contradict itself; a
 *   write session was told to apply edits, which is not obviously the right conversation to ask for
 *   a read-only opinion. Both are cheap to replace and neither is worth guessing about;
 * - a session with no recorded envelope is resumed only for a read, because a row from before
 *   envelopes existed cannot be shown to have been created for a change.
 */
export function sessionEnvelopeReason(
  stored: SessionExecutionEnvelope | null,
  requested: SessionExecutionEnvelope,
): SessionUnusableReason | null {
  if (stored === null) return requested.intent === "write" ? "envelope-intent-changed" : null;
  if (stored.intent !== requested.intent) return "envelope-intent-changed";
  if (stored.policy !== requested.policy) return "envelope-policy-changed";
  if (stored.role !== requested.role) return "envelope-role-changed";
  if (stored.permissionMode !== requested.permissionMode) return "envelope-permission-changed";
  if (stored.readOnlyInstructions !== requested.readOnlyInstructions) return "envelope-intent-changed";
  return null;
}

export interface SessionResolutionRequest {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly role: string;
  /** Whether the caller asked for a fresh native session on purpose. */
  readonly freshRequested: boolean;
  /** The capability probe's reading for this build, when one was taken. */
  readonly probedContinuity: boolean | "unknown" | null;
  readonly runtimeVersion: string | null;
  readonly workspace: string | null;
  readonly goalId: string | null;
  /**
   * The envelope this request executes under. Absent, the request is treated as a plain read with no
   * restrictions — the behaviour every caller before envelopes had.
   */
  readonly envelope?: SessionExecutionEnvelope;
}

/**
 * Whether the next invocation for this provider and model may continue a native session.
 *
 * One function, so "will this resume or start fresh" has exactly one answer and every surface that
 * shows it shows the same one. It is deliberately total: every path returns a decision, including
 * the ones that refuse, because a caller that has to handle "no decision" will invent one.
 */
export function resolveSessionDecision(input: SessionResolutionRequest & { readonly stored: ProviderSessionRecord | null }): NativeSessionDecision {
  const policy = RUNTIME_SESSION_POLICIES[input.providerId];
  const base = { providerId: input.providerId, modelId: input.modelId, resumeMode: "unsupported" as const };

  // A role that must stay independent never holds a session. Reported as `handoff` rather than
  // `unsupported`, because the goal handoff still reaches it — the continuity is of the *work*.
  if (!SESSION_CONTINUITY_ROLES.includes(input.role)) {
    return Object.freeze({ ...base, kind: "handoff" as const, sessionId: null, reason: "provider-does-not-expose-session-ids" as const, persistent: false });
  }

  if (!policy.resumeOffered) {
    return Object.freeze({ ...base, kind: "handoff" as const, sessionId: null, reason: policy.notOfferedBecause, persistent: false });
  }

  // The probe can only take the capability away. A build that no longer publishes what continuity
  // needs — the flag that names an id, or the subcommand that resumes one — is not a build to hold
  // ids against, and neither is one nobody could read.
  if (policy.idSource === "none" || input.probedContinuity === false) {
    return Object.freeze({ ...base, kind: "handoff" as const, sessionId: null, reason: "provider-does-not-expose-session-ids" as const, persistent: false });
  }
  // A runtime that reports its own id cannot be given one: `fresh` without a session id is a run
  // whose id BrainGate learns from the CLI's output, which the caller records when it sees it.
  const reports = policy.idSource === "reported";

  if (input.freshRequested) {
    return Object.freeze({
      ...base,
      kind: "fresh" as const,
      sessionId: reports ? null : randomUUID(),
      resumeMode: "available" as const,
      reason: null,
      persistent: policy.persistsSessions,
    });
  }

  const stored = input.stored;
  if (stored === null) {
    // Nothing to resume, so a new session begins. Where the caller can name it, it does — that is
    // what makes the reference survive an interrupted run. Where the runtime names it, the run
    // starts without one and the id is recorded from the output that reports it.
    return Object.freeze({
      ...base,
      kind: "fresh" as const,
      sessionId: reports ? null : randomUUID(),
      resumeMode: "available" as const,
      reason: "not-yet-used" as const,
      persistent: policy.persistsSessions,
    });
  }

  const unusable = sessionUnusableReason({ stored, goalId: input.goalId, runtimeVersion: input.runtimeVersion, workspace: input.workspace, ...(input.envelope === undefined ? {} : { envelope: input.envelope }) });
  if (unusable !== null) {
    // The session it would have resumed is gone or wrong for this work. A pinning runtime is handed
    // a new id here; a reporting one is simply run fresh, and the id it reports is recorded.
    return Object.freeze({
      ...base,
      kind: "fresh" as const,
      sessionId: reports ? null : randomUUID(),
      resumeMode: "available" as const,
      reason: unusable,
      persistent: policy.persistsSessions,
    });
  }

  return Object.freeze({
    ...base,
    kind: "resumed" as const,
    sessionId: stored.sessionId,
    resumeMode: "available" as const,
    reason: null,
    persistent: policy.persistsSessions,
  });
}

/**
 * Why a stored session will not be resumed, or `null` when it will be.
 *
 * Each reason is a fact about the session, not a guess about the runtime: a version that changed
 * mid-goal may resume perfectly well, and BrainGate does not know, so it declines to promise
 * continuity rather than promising it and losing the session on the way.
 */
export function sessionUnusableReason(input: {
  readonly stored: ProviderSessionRecord;
  readonly goalId: string | null;
  readonly runtimeVersion: string | null;
  readonly workspace: string | null;
  readonly envelope?: SessionExecutionEnvelope;
}): SessionUnusableReason | null {
  const { stored } = input;
  if (stored.status === "closed") return "superseded";
  if (stored.status === "stale") return "stale-session";
  if (stored.status === "unavailable" || stored.status === "incompatible") return "recorded-unresumable";
  if (stored.resumeMode !== "available") return "recorded-unresumable";
  if (input.goalId !== null && stored.goalId !== null && stored.goalId !== input.goalId) return "goal-mismatch";
  // A session created against a different build may not be readable by this one. Recorded, not
  // assumed either way.
  if (stored.runtimeVersion !== null && input.runtimeVersion !== null && stored.runtimeVersion !== input.runtimeVersion) return "runtime-version-changed";
  if (stored.workspace !== null && input.workspace !== null && stored.workspace !== input.workspace) return "workspace-changed";
  // Asked last, because it is the newest reason and the least about the session's own health: the
  // session is fine, it was simply initialized for different work.
  if (input.envelope !== undefined) {
    const envelope = sessionEnvelopeReason(stored.envelope, input.envelope);
    if (envelope !== null) return envelope;
  }
  return null;
}

/** The arguments a plan needs for a decision: the session flag, or the flag that suppresses one. */
export function sessionArgs(policy: RuntimeSessionPolicy, decision: NativeSessionDecision): readonly string[] {
  if (policy.idSource !== "pinned" || decision.sessionId === null) return Object.freeze([]);
  if (decision.kind === "resumed") return policy.resumeArgs(decision.sessionId);
  if (decision.kind === "fresh") return policy.newSessionArgs(decision.sessionId);
  return Object.freeze([]);
}

/**
 * The session id a fresh invocation will have, when the runtime lets one be chosen.
 *
 * Used by the recorder to know what to store before the run starts, which is the property that
 * makes an interrupted run recoverable: the reference exists even if the process never returns.
 */
export function pinnedSessionId(decision: NativeSessionDecision): string | null {
  if (decision.kind === "fresh" && decision.sessionId !== null) return decision.sessionId;
  return null;
}

export function sessionKindIs(value: string): value is NativeSessionKind {
  return isNativeSessionKind(value);
}

/**
 * The decision an unrecognised provider gets: no continuity, honestly labelled.
 *
 * Total on purpose. A provider added to the catalogue before a policy is measured for it must not
 * be able to acquire session continuity by omission.
 */
export function unsupportedSessionDecision(input: { readonly providerId: ProviderId; readonly modelId: string; readonly reason?: SessionUnusableReason | null }): NativeSessionDecision {
  return Object.freeze({
    providerId: input.providerId,
    modelId: input.modelId,
    kind: "handoff" as const,
    sessionId: null,
    resumeMode: "unsupported" as const,
    reason: input.reason ?? "provider-does-not-expose-session-ids",
    persistent: false,
  });
}

/** Where a session's continuity stands, for `/worker` and for a receipt line. */
export function describeSessionDecision(decision: NativeSessionDecision): string {
  switch (decision.kind) {
    case "resumed": return `resuming native session ${shortId(decision.sessionId)}`;
    case "fresh": {
      // A runtime that mints the id itself has none to show yet: the session is new and the CLI is
      // about to name it. Printing "none" there was the ledger and the terminal disagreeing again —
      // the decision was a new session, and `none` reads as no session at all. The shape of the
      // line is unchanged wherever an id exists.
      if (decision.sessionId === null) {
        return decision.reason === "not-yet-used"
          ? "new native session (the runtime names it)"
          : `new native session (the runtime names it) (${describeReason(decision.reason)})`;
      }
      return decision.reason === "not-yet-used"
        ? `new native session ${shortId(decision.sessionId)}`
        : `new native session ${shortId(decision.sessionId)} (${describeReason(decision.reason)})`;
    }
    case "unsupported": return `no native session (${describeReason(decision.reason)})`;
    case "disabled": return "native sessions disabled for this run";
    case "handoff": return `fresh invocation with a goal handoff (${describeReason(decision.reason)})`;
  }
}

export function describeReason(reason: SessionUnusableReason | null): string {
  switch (reason) {
    case null: return "nothing to report";
    case "provider-does-not-expose-session-ids": return "this runtime does not let BrainGate choose a session id";
    case "recorded-unresumable": return "the recorded session cannot be resumed";
    case "runtime-version-changed": return "the installed runtime version changed since that session";
    case "workspace-changed": return "that session belongs to a different workspace";
    case "envelope-intent-changed": return "that session was created for a read-only request, and this one asks for a change";
    case "envelope-policy-changed": return "that session was created under a different execution policy";
    case "envelope-role-changed": return "that session was created for a different role";
    case "envelope-permission-changed": return "that session was created with different native permissions";
    case "goal-mismatch": return "that session belongs to a different goal";
    case "superseded": return "that session is closed";
    case "stale-session": return "that session has gone stale";
    case "not-yet-used": return "nothing has been run yet";
  }
}

function shortId(value: string | null): string {
  return value === null ? "none" : value.slice(0, 8);
}
