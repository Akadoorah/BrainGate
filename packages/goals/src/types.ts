/**
 * What a Goal is, and what may be believed about it.
 *
 * M20 moves the first-class unit of work up one level. Until now the interactive product was
 * `user prompt -> classify -> one worker -> answer`, so a follow-up that said "how would you
 * implement the fix you just proposed?" arrived at BrainGate with no memory of the fix, was
 * classified on its own eight words, and could be routed to a cheaper model that then invented a
 * different diagnosis. The diagnosis had been *accepted* — it was the conclusion of a run whose
 * evidence was recorded — and nothing in the system had a place to say so.
 *
 * So the model here is deliberately two-layered, and the layer boundary is the point:
 *
 * - **Accepted state** is BrainGate's belief: findings the operator or the evidence established,
 *   which a worker may not overwrite by asserting something else.
 * - **Worker claims** are what a worker said. A claim is recorded, attributed, and *conflicts*
 *   with an accepted finding rather than replacing it.
 *
 * That is the whole reason `status: "conflicting"` exists as a value. ADR 0004 says conflicting
 * worker opinions must not silently become facts; this is the shape that keeps them from doing it
 * without also throwing them away, which would lose the one signal that reconciliation is owed.
 *
 * Nothing here is a truth engine. There is no scoring, no voting and no model in this file: a
 * finding is accepted because an operator or the recorded evidence says so, and a claim is
 * conflicting because its text contradicts an accepted one on the same subject. Deciding what to
 * do about that is a later milestone's job; refusing to let it disappear is this one's.
 */

import type { ProviderId } from "@braingate/providers";
import type { TaskComplexity, TaskRisk } from "@braingate/core";

/**
 * Whether a conversation is still being added to.
 *
 * Narrower than the goal vocabulary on purpose: a conversation is a container for goals, and the
 * only question asked of it is which goal is current.
 */
export const CONVERSATION_STATUSES = ["active", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * Where a goal has got to.
 *
 * `open` and `done` are the honest ends. `diagnosed` is separate from `implementing` because the
 * SaudiGPT turn that motivated this milestone had concluded — evidence, scope, next action — while
 * nothing had been changed yet, and a follow-up asking how to implement it was continuing a
 * diagnosis rather than starting a change.
 */
export const GOAL_STATUSES = ["open", "diagnosed", "implementing", "blocked", "done", "abandoned"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export function isGoalStatus(value: string): value is GoalStatus {
  return (GOAL_STATUSES as readonly string[]).includes(value);
}

/**
 * How a finding stands.
 *
 * `accepted` is a belief. `conflicting` is a worker's contrary claim that has not displaced one.
 * `superseded` is the older half of a deliberate replacement, kept so the change of mind is
 * visible rather than erased. `rejected` was considered and set aside.
 */
export const FINDING_STATUSES = ["claim", "accepted", "conflicting", "rejected", "superseded"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export function isFindingStatus(value: string): value is FindingStatus {
  return (FINDING_STATUSES as readonly string[]).includes(value);
}

/**
 * What may be done about a provider's session.
 *
 * `unsupported` is a real value and currently the honest one almost everywhere: BrainGate's
 * profiles have never passed a resume flag, Claude runs `--no-session-persistence`, and no
 * provider-assigned session id is captured from any CLI's output. Recording `unsafe` or
 * `unsupported` now is what keeps a later slice from having to guess which sessions were resumed
 * and which were merely believed to have been.
 */
export const SESSION_RESUME_MODES = ["unsupported", "unsafe", "available"] as const;
export type SessionResumeMode = (typeof SESSION_RESUME_MODES)[number];

export function isSessionResumeMode(value: string): value is SessionResumeMode {
  return (SESSION_RESUME_MODES as readonly string[]).includes(value);
}

/** One worker's claim, or one established belief. The two are the same shape and different statuses. */
export interface Finding {
  readonly findingId: string;
  readonly status: FindingStatus;
  readonly claim: string;
  /**
   * What supports this. Required for `accepted` because an accepted finding is a belief BrainGate
   * will hand to the next worker as established state, and "established" with nothing behind it is
   * how a model's guess acquires the standing of a measurement.
   */
  readonly evidence: readonly string[];
  /**
   * The provider/model that claimed it, or `operator`.
   *
   * Kept so a receipt can distinguish what a worker asserted from what the operator decided — the
   * same distinction `memory note` draws when it attributes a proposal to the operator rather than
   * to BrainGate.
   */
  readonly assertedBy: string;
  /** The claim text this one contradicts, for a `conflicting` finding. */
  readonly conflictsWith: string | null;
  /** The finding this one replaced, for a `superseded` finding. */
  readonly supersededBy: string | null;
  readonly recordedAt: string;
}

/** A goal's recorded pointer at one provider's native session. The id itself lives in the registry. */
export interface ProviderSessionRef {
  readonly providerId: ProviderId;
  readonly modelId: string | null;
  readonly sessionId: string;
  /**
   * Whether this session may be resumed, as of when it was recorded.
   *
   * Optional because a goal written by the first M20 build carries no such field, and a goal that
   * refuses to load is a worse failure than one whose oldest session reference is conservatively
   * read as unresumable. Absent is read as `unsupported`, never as `available`.
   */
  readonly resumeMode?: SessionResumeMode | undefined;
  readonly recordedAt: string;
}

/**
 * How a native session ended up being used on one invocation.
 *
 * Recorded on the receipt so a reader can tell a continuation from a fresh start without inferring
 * it. `handoff` is the honest answer when a runtime cannot be resumed: the work continued because
 * the *goal* continued, and claiming otherwise would be the one lie this whole layer exists to
 * prevent.
 */
export const NATIVE_SESSION_KINDS = ["fresh", "resumed", "handoff", "unsupported", "disabled"] as const;
export type NativeSessionKind = (typeof NATIVE_SESSION_KINDS)[number];

export function isNativeSessionKind(value: string): value is NativeSessionKind {
  return (NATIVE_SESSION_KINDS as readonly string[]).includes(value);
}

/**
 * Whether a recorded session is still usable.
 *
 * `stale` and `incompatible` are kept apart from `unavailable` because they have different causes
 * and different next steps: a session that has aged out may come back if the runtime retains it, a
 * session recorded under a different runtime version or workspace may be resumable once the
 * mismatch is understood, and one the runtime has forgotten is simply gone.
 */
export const SESSION_STATUSES = ["active", "stale", "incompatible", "unavailable", "closed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export function isSessionStatus(value: string): value is SessionStatus {
  return (SESSION_STATUSES as readonly string[]).includes(value);
}

/** What has been decided or asked, as of the last recorded turn. */
export interface GoalStateUpdate {
  readonly status?: GoalStatus | undefined;
  readonly acceptedFindings?: readonly FindingClaim[] | undefined;
  readonly secondaryFindings?: readonly FindingClaim[] | undefined;
  readonly openQuestions?: readonly string[] | undefined;
  readonly approvedScope?: readonly string[] | undefined;
  readonly filesChanged?: readonly string[] | undefined;
  readonly testsRun?: readonly string[] | undefined;
  readonly nextAction?: string | null | undefined;
  /** The provider/model the update came from, or `operator`. */
  readonly assertedBy?: string | undefined;
}

/**
 * A claim on its way into goal state, with whatever supports it.
 *
 * Evidence travels *with* the claim rather than in a parallel list, because a parallel list cannot
 * say which citation belongs to which finding — the first version of this attached them
 * positionally and gave the secondary finding the root cause's evidence, which is a citation that
 * looks authoritative and supports the wrong sentence.
 *
 * A bare string is still accepted, because "the operator stated this" is a real and common case;
 * it is recorded as asserted-by and never as evidence.
 */
export type FindingClaim = string | { readonly claim: string; readonly evidence?: readonly string[] | undefined };

/**
 * The compact current state of a goal.
 *
 * Every list is bounded on the way in, and the bound is a product decision rather than a
 * limitation. The failure this milestone exists to fix was a *handoff that lost state*, and a
 * handoff that carries two hundred findings has the same effect by a different route. So state is
 * the current picture, not a transcript: full answers, diffs and test output belong in the result
 * store, and the timeline keeps the history that produced this.
 */
export interface GoalState {
  readonly status: GoalStatus;
  /** Findings BrainGate holds as established, and no worker may overwrite by asserting otherwise. */
  readonly acceptedFindings: readonly Finding[];
  /** Established, but not the root cause — the distinction that was lost between turn 1 and turn 2. */
  readonly secondaryFindings: readonly Finding[];
  /** Contrary claims that have *not* displaced an accepted finding. */
  readonly disputedFindings: readonly Finding[];
  readonly openQuestions: readonly string[];
  readonly approvedScope: readonly string[];
  readonly filesChanged: readonly string[];
  readonly testsRun: readonly string[];
  readonly nextAction: string | null;
  readonly providerSessions: readonly ProviderSessionRef[];
}

export interface ConversationRecord {
  readonly conversationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly activeGoalId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalRecord {
  readonly goalId: string;
  readonly conversationId: string;
  readonly projectId: string;
  /**
   * The workspace this goal belongs to.
   *
   * A goal reasons about local files and asks workers to change them, so it belongs to one concrete
   * directory rather than to the project as a whole. Two workspaces of one project hold two goal
   * stores, and this field is what makes a goal that arrives in the wrong one — a copied database,
   * say — refuse rather than execute. `null` only for a row written before workspaces existed, which
   * the migration binds to the workspace whose file it is already in.
   */
  readonly workspaceId: string | null;
  readonly objective: string;
  readonly state: GoalState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A turn on the timeline: what was asked, and what came back.
 *
 * The raw conversation history the product direction asks for, stored in the project's own
 * database rather than only in the eight-hour session thread. The thread is a convenience that
 * expires; this is the record. Answers are kept whole here and bounded only by the store's own
 * limit, because this is the source a handoff is derived *from* — bounding state is safe, bounding
 * the only copy of what a worker concluded is not.
 */
export interface ConversationTurn {
  readonly sequence: number;
  readonly conversationId: string;
  readonly projectId: string;
  readonly goalId: string | null;
  readonly taskId: string | null;
  readonly request: string;
  readonly answer: string;
  /** `provider/model`, in the order the run used them. Empty when nothing was spent. */
  readonly attributedTo: readonly string[];
  readonly occurredAt: string;
}

/**
 * One provider/model's native session.
 *
 * Kept apart from the goal so it survives the goal that found it, and keyed by
 * `(provider, model, sessionId)` so two models on one subscription are two workers with two
 * sessions — the hierarchy is Provider -> Runtime -> Model -> sessions, never Provider -> one worker.
 *
 * A session reference is an execution continuity reference. It is not memory, it is never promoted
 * to canonical memory, and it holds no credential: the id is a name the runtime chose or was given,
 * and the runtime's own authentication is what authorizes using it.
 */
export interface ProviderSessionRecord {
  readonly projectId: string;
  readonly providerId: ProviderId;
  readonly modelId: string | null;
  readonly sessionId: string;
  readonly quotaPool: string | null;
  readonly resumeMode: SessionResumeMode;
  readonly status: SessionStatus;
  /** The CLI build the session was created against, so a mismatch can be seen rather than guessed. */
  readonly runtimeVersion: string | null;
  /** Where the session was created, when the runtime scopes sessions by directory. */
  readonly workspace: string | null;
  /** The workspace identity of that directory, so a copied database cannot be resumed into. */
  readonly workspaceId: string | null;
  /**
   * The envelope this session was initialized under, or `null` for a row written before it existed.
   *
   * `null` is not compatible with anything that carries a restriction: a session from before
   * envelopes were recorded cannot be shown to have been created for this kind of work, and the
   * conservative reading of "unknown" is "do not resume it for a write".
   */
  readonly envelope: SessionExecutionEnvelope | null;
  readonly goalId: string | null;
  readonly conversationId: string | null;
  /** The BrainGate task that last used this session, so a receipt and a session can be joined. */
  readonly lastTaskId: string | null;
  /** The conversation turn that last used it, which is what a returning-worker delta is measured from. */
  readonly lastTurnSequence: number | null;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly updatedAt: string;
}

/**
 * Why a stored session will not be resumed, in the terms a user is shown.
 *
 * The `envelope-*` reasons are the execution-envelope class: the session exists, belongs to this
 * goal and workspace, and is readable by this build — and it was still initialized under a
 * different boundary. A session created for a read-only request carries a standing instruction not
 * to modify anything; handing it a write is not continuity, it is asking it to break its own
 * instructions, and Claude refused exactly that in real dogfood.
 */
export const SESSION_UNUSABLE_REASONS = [
  "provider-does-not-expose-session-ids",
  "recorded-unresumable",
  "runtime-version-changed",
  "workspace-changed",
  "goal-mismatch",
  "envelope-intent-changed",
  "envelope-policy-changed",
  "envelope-role-changed",
  "envelope-permission-changed",
  "superseded",
  "stale-session",
  "not-yet-used",
] as const;
export type SessionUnusableReason = (typeof SESSION_UNUSABLE_REASONS)[number];

export function isSessionUnusableReason(value: string): value is SessionUnusableReason {
  return (SESSION_UNUSABLE_REASONS as readonly string[]).includes(value);
}

/**
 * The constraints a native session was initialized under.
 *
 * A native session is not a generic attachment to a provider: it is a conversation whose first
 * message told the CLI what it was for. Claude Code, given the read-only profile, is told
 * "Analyze only; do not modify files, run commands, access the network, or use external tools" —
 * and it keeps that instruction for the life of the session, because that is what a session is.
 * Resuming it for a write asks the model to contradict the standing instruction it was given, which
 * is why the request was refused twice in dogfood rather than mis-executed.
 *
 * So continuity is decided per envelope. One worker may hold several sessions for one goal — a
 * read/direct one and a write/direct one — and the newest *compatible* one is the one to resume.
 */
export interface SessionExecutionEnvelope {
  /** The effect the session was created to produce. */
  readonly intent: "read" | "write";
  /** The boundary it was created under (ADR 0017). */
  readonly policy: string;
  /** The workflow role whose standing instructions were injected. */
  readonly role: string;
  /**
   * Whether the invocation told the runtime, in its own words, not to modify anything.
   *
   * Separate from `intent` because it is the field that makes the refusal explicable: a session can
   * be a read session and still be safe to reuse for a small write, but not when the CLI was told
   * not to touch files.
   */
  readonly readOnlyInstructions: boolean;
  /** The native permission posture the invocation ran with, when the profile sets one. */
  readonly permissionMode: string | null;
}

/**
 * Whether the next invocation may resume, and what happens instead.
 *
 * A decision, not a question. Every surface that shows session continuity shows this, so "will this
 * resume or start fresh" has one answer computed in one place.
 */
export interface NativeSessionDecision {
  /**
   * Which of the five things happened. Narrowed from `string` so a caller cannot pass, and a
   * consumer cannot accept, a kind that is not in the list.
   */
  readonly kind: NativeSessionKind;
  /** The session that will be used: resumed, or the id a new one was pinned to. */
  readonly sessionId: string | null;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly resumeMode: SessionResumeMode;
  readonly reason: SessionUnusableReason | null;
  /** True when the runtime persists sessions for this run, which is what makes an id usable later. */
  readonly persistent: boolean;
}

/**
 * What a worker is told when it picks a goal up.
 *
 * Built from `GoalState`, never from a conversation transcript, and the difference is the whole
 * "do not send a giant prompt every turn" requirement. It carries engineering state — findings
 * with their evidence, what changed, what ran, what is unresolved — and no hidden reasoning: there
 * is no field here a model's private thinking could arrive in, because none is ever read.
 */
export interface HandoffPackage {
  readonly goalId: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly acceptedFindings: readonly Finding[];
  readonly secondaryFindings: readonly Finding[];
  readonly disputedFindings: readonly Finding[];
  readonly openQuestions: readonly string[];
  readonly approvedScope: readonly string[];
  readonly filesChanged: readonly string[];
  readonly testsRun: readonly string[];
  readonly nextAction: string | null;
  /** The native session per provider, when one was recorded. Absent for a provider never used. */
  readonly providerSessions: readonly ProviderSessionRef[];
  /** The worker being addressed, when the handoff is aimed at one. */
  readonly addressedTo: string | null;
  /** The work unit this handoff accompanies. */
  readonly workUnit: string;
  /** Which surfaces already hold this goal's detail, so a worker may look rather than be told. */
  readonly evidenceRefs: readonly string[];
}

/** The context object a provider receives, in the layers the product direction names. */
export interface GoalContext {
  /** Layer 1: raw turns, most recent last, already bounded by the caller. */
  readonly recentTurns: readonly { readonly request: string; readonly answer: string }[];
  /** Layer 2: the handoff package, which is the compact current state. */
  readonly handoff: HandoffPackage;
  /** Layer 3: where artifacts and results live, without copying their bytes. */
  readonly evidenceRefs: readonly string[];
}
