import { ModelCatalog, resolveOperatorState, type OperatorStatePaths } from "@braingate/operator";
import {
  RUNTIME_SESSION_POLICIES,
  SESSION_CONTINUITY_ROLES,
  computeGoalDelta,
  describeReason,
  describeSessionDecision,
  pinnedSessionId,
  renderGoalDelta,
  resolveSessionDecision,
  type GoalDelta,
  type GoalRecord,
  type GoalStore,
  type NativeSessionDecision,
  sessionEnvelopeFor,
  sessionEnvelopeReason,
  type SessionExecutionEnvelope,
} from "@braingate/goals";
import type { NativeSessionResolver } from "@braingate/shadow";
import type { ProviderId } from "@braingate/providers";

/**
 * Who is doing the work, and whether they are continuing a native session.
 *
 * The interactive session's own state, held in memory: `auto` means the router chooses, and a
 * manual choice names a provider and a model. Nothing here is persisted, and that is deliberate —
 * a manual switch is a decision about *this* conversation, and a stored override would silently
 * apply to a session opened next week by someone who had forgotten making it. The goal, which *is*
 * persisted, carries everything that should outlive the terminal.
 */
export type WorkerSelection =
  | { readonly mode: "auto" }
  | { readonly mode: "manual"; readonly providerId: string; readonly modelId: string; readonly fresh: boolean };

export const AUTO_WORKER: WorkerSelection = Object.freeze({ mode: "auto" });

export interface WorkerCommandResult {
  readonly selection: WorkerSelection;
  readonly ok: boolean;
  readonly message: string;
}

/** The route pin a selection implies, or `undefined` in auto mode. */
export function pinFor(selection: WorkerSelection): { readonly providerId: string; readonly modelId: string } | undefined {
  return selection.mode === "manual" ? { providerId: selection.providerId, modelId: selection.modelId } : undefined;
}

/**
 * Parses `/use <provider>/<model>`.
 *
 * The model id may itself contain slashes — providers publish ids like `anthropic/claude-sonnet-4`
 * — so the split is on the *first* slash only. Splitting on the last would silently turn a model id
 * into a provider id, and the operator would be told a model they never named was unavailable.
 */
export function parseUseTarget(input: string): { readonly providerId: string; readonly modelId: string; readonly fresh: boolean } | null {
  const parts = input.trim().split(/\s+/);
  const target = parts[0] ?? "";
  const fresh = parts.slice(1).some((token) => token === "--fresh" || token === "fresh");
  const separator = target.indexOf("/");
  if (separator <= 0 || separator === target.length - 1) return null;
  const providerId = target.slice(0, separator);
  const modelId = target.slice(separator + 1);
  if (providerId.length === 0 || modelId.length === 0) return null;
  return Object.freeze({ providerId, modelId, fresh });
}

/**
 * Resolves a manual choice against the operator's own catalogue.
 *
 * The catalogue is the only place a model id is authoritative: `braingate models add` writes it,
 * discovery fills it, and the router routes what is in it. A `/use` that accepted an id nobody
 * configured would produce a refusal two commands later, at the point where work was about to be
 * spent, instead of here where the mistake was made.
 */
export function resolveManualWorker(input: {
  readonly target: string;
  readonly state?: OperatorStatePaths;
  readonly env?: NodeJS.ProcessEnv;
}): WorkerCommandResult {
  const parsed = parseUseTarget(input.target);
  if (parsed === null) {
    return Object.freeze({ selection: AUTO_WORKER, ok: false, message: "Usage: /use <provider>/<model> [--fresh] — for example /use anthropic/claude-sonnet-4-5" });
  }
  let configured: readonly { readonly providerId: string; readonly modelId: string }[];
  try {
    const paths = input.state ?? resolveOperatorState(input.env ?? process.env);
    configured = new ModelCatalog(paths.modelCatalogPath).configured();
  } catch {
    return Object.freeze({ selection: AUTO_WORKER, ok: false, message: "The model catalogue could not be read, so a manual choice cannot be checked against it. Fix that first, or stay on /auto." });
  }
  if (configured.length === 0) {
    return Object.freeze({ selection: AUTO_WORKER, ok: false, message: "No models are configured yet. Run `braingate discover`, then `braingate models add`, before choosing one by hand." });
  }
  const known = configured.some((entry) => entry.providerId === parsed.providerId && entry.modelId === parsed.modelId);
  if (!known) {
    // Naming a few that do exist turns a refusal into a next step, and the list is short because it
    // is the operator's own catalogue rather than a provider's full published set.
    const nearby = configured
      .filter((entry) => entry.providerId === parsed.providerId)
      .map((entry) => `${entry.providerId}/${entry.modelId}`)
      .slice(0, 6);
    const hint = nearby.length > 0
      ? ` Configured for ${parsed.providerId}: ${nearby.join(", ")}.`
      : ` Nothing is configured for ${parsed.providerId}.`;
    return Object.freeze({
      selection: AUTO_WORKER,
      ok: false,
      message: `${parsed.providerId}/${parsed.modelId} is not in your model catalogue.${hint} Selection is unchanged.`,
    });
  }
  const policy = RUNTIME_SESSION_POLICIES[parsed.providerId as ProviderId];
  const continuity = policy?.resumeOffered === true
    ? "native session continuity is supported for this runtime"
    : `no native session continuity for this runtime (${describeReason(policy?.notOfferedBecause ?? "provider-does-not-expose-session-ids")})`;
  return Object.freeze({
    selection: Object.freeze({ mode: "manual" as const, providerId: parsed.providerId, modelId: parsed.modelId, fresh: parsed.fresh }),
    ok: true,
    message: `Next work will go to ${parsed.providerId}/${parsed.modelId}${parsed.fresh ? " with a fresh native session" : ""}. ${continuity}. Every availability, quota, capability and isolation check still applies; /auto returns to automatic selection.`,
  });
}

/** What `/worker` prints: the selection, the goal it applies to, and what the next run would do. */
export function describeWorker(input: {
  readonly selection: WorkerSelection;
  readonly goal: GoalRecord | null;
  readonly lastRun: { readonly label: string | null; readonly session: NativeSessionDecision | null } | null;
  readonly knownSessions: readonly {
    readonly providerId: string;
    readonly modelId: string | null;
    readonly sessionId: string;
    readonly resumeMode: string;
    readonly lastUsedAt: string;
    readonly envelope?: SessionExecutionEnvelope | null;
  }[];
}): readonly string[] {
  const lines: string[] = [];
  const pin = pinFor(input.selection);
  lines.push(`  Worker: ${pin === undefined ? "auto — BrainGate routes each turn to the cheapest capable model" : `manual — ${pin.providerId}/${pin.modelId}`}`);
  if (input.selection.mode === "manual" && input.selection.fresh) {
    lines.push("  Fresh session requested for the next run; the BrainGate goal is still continued.");
  }
  lines.push(`  Goal: ${input.goal === null ? "none yet — the next request starts one" : `${input.goal.goalId.slice(0, 8)} · ${input.goal.objective}`}`);
  if (input.lastRun !== null) {
    lines.push(`  Last run: ${input.lastRun.label ?? "unknown worker"}`);
    if (input.lastRun.session !== null) lines.push(`  Native session: ${describeSessionDecision(input.lastRun.session)}`);
  }
  if (pin !== undefined) {
    const policy = RUNTIME_SESSION_POLICIES[pin.providerId as ProviderId];
    lines.push(`  If you run now: ${policy?.resumeOffered === true
      ? "BrainGate will resume this model's session for the goal when one is compatible, and start one when it is not."
      : `a fresh invocation with the goal handoff — ${describeReason(policy?.notOfferedBecause ?? "provider-does-not-expose-session-ids")}.`}`);
  }
  if (input.knownSessions.length > 0) {
    // The envelope is part of what a session *is*, so it is part of what this listing says. One
    // worker can hold several sessions for one goal — a read/direct one and a write/direct one — and
    // which is which is the operator's answer to "what will my next request resume".
    lines.push("  Sessions on record:");
    for (const session of input.knownSessions.slice(0, 6)) {
      const envelope = session.envelope === null || session.envelope === undefined
        ? "envelope unrecorded"
        : `${session.envelope.intent}/${session.envelope.policy}${session.envelope.readOnlyInstructions ? " · told not to modify files" : ""}`;
      lines.push(`    ${session.providerId}/${session.modelId ?? "-"} · ${session.sessionId.slice(0, 8)} · ${envelope} · ${session.resumeMode} · last used ${session.lastUsedAt}`);
    }
    lines.push("  A read session is never resumed for a write: the instruction it was created with lasts as long as it does.");
  }
  return Object.freeze(lines);
}

/** What one run did about a session, for the receipt line and for `/worker`. */
export interface RunSessionSummary {
  readonly label: string | null;
  readonly session: NativeSessionDecision | null;
  readonly delta: GoalDelta | null;
}

/**
 * The session resolver the execution layer asks, per invocation.
 *
 * It is a factory rather than a function because it owns the mapping from `provider/model` — which
 * is a string pair by the time the invoker has it — back to the conversation and goal the session
 * belongs to. The invoker knows none of that, and should not: a session belongs to a goal, and the
 * goal belongs to the session's own store.
 */
export function createNativeSessionResolver(input: {
  readonly goals: GoalStore;
  readonly goal: () => GoalRecord | null;
  readonly conversationId: () => string | null;
  readonly freshRequested: () => boolean;
  readonly consumeFresh: () => void;
  /**
   * The capability probe's reading for a build, awaited.
   *
   * Allowed to be asynchronous because the first reading of a session may still be in flight, and
   * treating "not read yet" as a refusal would mean the first turn of every session could never
   * continue a session — which is the turn most likely to matter.
   */
  readonly probedPinning: (providerId: string) => Promise<boolean | "unknown" | null> | boolean | "unknown" | null;
  readonly runtimeVersion: (providerId: string) => string | null;
  readonly workspace: () => string | null;
  /**
   * What this run is for: the requested effect, and the boundary it runs inside (ADR 0017).
   *
   * Read here rather than inferred, because it decides whether a stored native session may be
   * resumed at all. The session a read-only request created was told not to modify anything, and
   * that instruction lives as long as the session does.
   */
  readonly intent: () => "read" | "write";
  readonly policy: () => string;
  readonly onResolved: (summary: RunSessionSummary) => void;
}): NativeSessionResolver {
  return async ({ role, model, task, context }) => {
    if (!SESSION_CONTINUITY_ROLES.includes(role)) return null;
    const goal = input.goal();
    if (goal === null) return null;
    const providerId = model.providerId as ProviderId;
    const policy = RUNTIME_SESSION_POLICIES[providerId];
    if (policy === undefined) return null;

    // The envelope this run will execute under, computed the same way it was when any stored session
    // was created. Compatibility is then a comparison of two values produced by one function.
    const envelope = sessionEnvelopeFor({ intent: input.intent(), policy: input.policy(), role, providerId });
    // Newest *compatible*, never newest regardless: a worker can hold a read session and a write
    // session for one goal, and the right one is the one that matches what this run is for.
    const compatible = input.goals.latestCompatibleSessionFor(providerId, model.modelId, envelope);
    // Nothing compatible, but something recorded: passed as the stored session anyway so the decision
    // says *why* continuity is breaking — "fresh, because that session was created for a read-only
    // request" rather than "fresh, nothing recorded here", which would be false and unhelpful.
    const stored = compatible ?? input.goals.latestSessionFor(providerId, model.modelId);
    const fresh = input.freshRequested();
    const decision = resolveSessionDecision({
      providerId,
      modelId: model.modelId,
      role,
      freshRequested: fresh,
      probedPinning: await input.probedPinning(providerId),
      runtimeVersion: input.runtimeVersion(providerId),
      workspace: input.workspace(),
      goalId: goal.goalId,
      envelope,
      stored,
    });
    if (fresh) input.consumeFresh();

    const label = `${providerId}/${model.modelId}`;
    if (decision.kind === "handoff" || decision.kind === "disabled") {
      input.onResolved(Object.freeze({ label, session: decision, delta: null }));
      return Object.freeze({ decision, note: describeReason(decision.reason) });
    }

    // Registered before the call, not after. The id is one BrainGate chose, so the reference exists
    // even if the process dies mid-run — which is the property that makes a pinned id worth more
    // than an id read back from a provider's output.
    try {
      input.goals.recordProviderSession({
        providerId,
        modelId: model.modelId,
        sessionId: decision.sessionId!,
        quotaPool: model.quotaPool,
        resumeMode: decision.resumeMode,
        status: "active",
        runtimeVersion: input.runtimeVersion(providerId),
        workspace: input.workspace(),
        envelope,
        goalId: goal.goalId,
        conversationId: input.conversationId(),
      });
    } catch { /* a session that cannot be registered is a lost reference, not a lost run */ }

    const turnSequence = stored?.lastTurnSequence ?? null;
    const previous = decision.kind === "resumed"
      ? input.goals.sessionStateSnapshot(providerId, model.modelId, decision.sessionId!)
      : null;

    // A resumed session is given a *delta*, because it already remembers its own turns. A session
    // with no baseline gets nothing extra and falls back to the handoff the run already carries —
    // a delta with no baseline would have to claim everything is new, or nothing is.
    if (decision.kind === "resumed" && previous !== null) {
      const conversationId = input.conversationId();
      const delta = computeGoalDelta({
        goal,
        previous,
        turns: conversationId === null ? [] : input.goals.recentTurns(conversationId, 50),
        sinceSequence: turnSequence,
        sinceWorker: label,
      });
      input.onResolved(Object.freeze({ label, session: decision, delta }));
      const base = (context ?? {}) as { readonly goal?: Record<string, unknown> };
      // The delta goes *inside* the goal layer, replacing the handoff that layer would otherwise
      // carry. Putting it beside the layer was the bug this replaced: everything that reads a
      // worker's context — a provider adapter, a test, a future surface — reads the goal layer, and
      // a field next to it is a field nobody looks at.
      const priorGoal = base.goal ?? {};
      const { handoff: _replacedHandoff, ...restOfGoal } = priorGoal;
      return Object.freeze({
        decision,
        // The work unit stays the request; what changes is the context. A resumed worker is asked to
        // do the new thing and told what changed, which is exactly what it cannot know on its own.
        context: Object.freeze({
          ...base,
          goal: Object.freeze({ ...restOfGoal, goalDelta: delta, handoffText: renderGoalDelta(delta, task) }),
        }),
        note: delta.empty ? "resumed; nothing changed since that session was last used" : "resumed with a goal delta",
      });
    }

    input.onResolved(Object.freeze({ label, session: decision, delta: null }));
    return Object.freeze({ decision, note: describeReason(decision.reason) });
  };
}

/**
 * What a run leaves behind for the next one.
 *
 * Both halves matter and neither is inferable from the other: the snapshot is the baseline the
 * *next* delta is measured against, and the turn sequence is where the timeline is resumed from. A
 * run that recorded one without the other would either report the same changes twice or lose them.
 */
export function recordSessionUse(input: {
  readonly goals: GoalStore;
  readonly summary: RunSessionSummary | null;
  readonly goal: GoalRecord | null;
  readonly taskId: string | null;
  readonly turnSequence: number | null;
}): void {
  const { summary, goal, goals } = input;
  if (summary?.session == null || goal === null) return;
  const decision = summary.session;
  if (decision.sessionId === null || decision.kind === "handoff" || decision.kind === "disabled") return;
  const [providerId, modelId] = splitLabel(summary.label);
  if (providerId === null || modelId === null) return;
  try {
    goals.markSessionUsed({
      providerId: providerId as ProviderId,
      modelId,
      sessionId: decision.sessionId,
      taskId: input.taskId,
      turnSequence: input.turnSequence,
      // The state *after* the turn, because that is what the next delta is measured from. Recorded
      // here rather than after, because a session that is used and never marked reads as unused and
      // would be resumed with a delta covering work it already did.
      stateSnapshot: goals.getGoal(goal.goalId)?.state ?? goal.state,
    });
  } catch { /* a lost position costs one redundant delta; it must not fail the run */ }
}

function splitLabel(label: string | null): readonly [string | null, string | null] {
  if (label === null) return [null, null];
  const separator = label.indexOf("/");
  if (separator <= 0) return [null, null];
  return [label.slice(0, separator), label.slice(separator + 1)];
}

/** The session id this run will use, for a receipt that has to name it before the run starts. */
export function sessionIdForRun(decision: NativeSessionDecision | null): string | null {
  return decision === null ? null : (decision.sessionId ?? pinnedSessionId(decision));
}
