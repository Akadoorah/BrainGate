import { BrainGateInvariantError, ProviderQuotaRefusalError, failureKindFromCode, type ExecutionProject, type TaskLedger } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import { redactSecrets } from "@braingate/security";
import type { AgentInvoker, AgentRequest, AgentResponse } from "@braingate/workflows";
import type { CodexIsolationAttestation } from "./codex-isolation.js";
import { grokSandboxNotApplied, type GrokIsolationAttestation } from "./grok-isolation.js";
import { planShadowInvocation, snapshotPrimaryEligibility } from "./profiles.js";
import type { TaskSnapshotEvidence, TaskSnapshotProvider } from "./snapshot-provider.js";
import { providerQuotaRefusal, quotaReadings, subagentUsage, type QuotaReading, type SubagentUsage } from "./quota-readings.js";
import { grants } from "./tool-grants.js";
import { NodeShadowProcessExecutor } from "./process-executor.js";
import type { OperatorProviderAcceptance, PlannedSessionKind, PlannedSessionReason, PlannedSessionResumeMode, ShadowInvocationPlan, ShadowProcessExecutor, ShadowRolePayload, SubscriptionAttestation } from "./types.js";

/** What a role is doing, as it happens. */
export interface RoleActivity {
  readonly stage: "started" | "completed";
  readonly role: AgentRequest["role"];
  readonly provider: string;
  readonly model: string;
  readonly quotaPool: string;
  /** The capabilities this role actually received, so the line says what it may do. */
  readonly grant: readonly string[];
  readonly durationMs?: number;
}

function responseContract(role: AgentRequest["role"]): Readonly<Record<string, unknown>> {
  // A plan is work: it produces the approach the executor then follows. It is not a review, and
  // asking for a verdict here would get an opinion about the task instead of a way to do it.
  if (role === "planner" || role === "primary") return Object.freeze({ kind: "work", output: "string" });
  if (role === "reviewer") return Object.freeze({ kind: "review", verdict: ["approve", "request_changes", "disagree"], findings: "string[]" });
  return Object.freeze({ kind: "judge", verdict: ["approve", "request_changes"], rationale: "string", findings: "string[]" });
}

function boundedText(value: unknown, max = 100_000): string {
  if (typeof value !== "string") throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Provider response field must be a string.");
  return redactSecrets(value).slice(0, max);
}

function boundedFindings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Provider findings must be an array.");
  return Object.freeze(value.slice(0, 8).map((item) => boundedText(item, 1_000)).filter((item) => item.trim().length > 0));
}

export function extractCodexAgentMessage(stdout: string): string {
  let finalMessage: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type === "agent_message" && typeof record.text === "string") finalMessage = record.text;
  }
  if (finalMessage === null) throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Codex JSONL did not contain a completed agent_message.");
  return finalMessage;
}


/**
 * The session id a runtime reported for the run it just finished, when it reports one.
 *
 * Measured 2026-09-14: Codex opens its JSONL stream with
 * `{"type":"thread.started","thread_id":"…"}` before any model work, and Antigravity's print-mode
 * envelope carries `conversation_id`. Both are read here rather than guessed at, and a run that
 * never reported one returns `null` — which is a fact about that run, not a failure.
 *
 * Deliberately not "the last session this CLI used": that would attach this goal's work to
 * whatever the operator happened to run in their own terminal.
 */
export function reportedSessionIdOf(providerId: string, stdout: string): string | null {
  if (providerId !== "openai" && providerId !== "google") return null;
  let found: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (providerId === "openai") {
      if (event.type === "thread.started" && typeof event.thread_id === "string") found = event.thread_id;
      continue;
    }
    // Antigravity: the id sits on the envelope itself, and on the inner `result` of a streamed run.
    if (typeof event.conversation_id === "string") found = event.conversation_id;
    const result = event.result;
    if (typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).conversation_id === "string") {
      found = (result as Record<string, unknown>).conversation_id as string;
    }
  }
  return found;
}

/**
 * The answer from an Antigravity stream-json run.
 *
 * One NDJSON object per line, and the reply is in the last line that carries one — as a
 * `result`/`response` string, or as Anthropic-shaped `message.content`. Three shapes rather than
 * one because the format is the CLI's, not BrainGate's, and a parser that knew only the shape it
 * was written against would fail the whole run on a rename. A line that parses as nothing useful
 * is skipped, never guessed at.
 */
/** The `result` object of an Antigravity stream-json run, or null when there is none. */
export function antigravityResultRecord(stdout: string): Record<string, unknown> | null {
  let latest: Record<string, unknown> | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    const result = event.result;
    if (typeof result === "object" && result !== null) latest = result as Record<string, unknown>;
  }
  return latest;
}

export function extractAntigravityResult(stdout: string): string | null {
  const record = antigravityResultRecord(stdout);
  if (record === null) return null;
  // The schema-conformant object the CLI enforced, when it is there. It is the same answer as
  // `response`, minus the model's narration around it — measured: a run replying "ready" puts
  // three lines in `response` and exactly the contracted object in `structured_output`.
  const structured = record.structured_output;
  if (typeof structured === "object" && structured !== null) return JSON.stringify(structured);
  const response = record.response;
  return typeof response === "string" && response.trim().length > 0 ? response : null;
}

/**
 * The last NDJSON line that yields something, by whatever rule the caller supplies.
 *
 * A streamed run's envelope is its final line; scanning from the end and taking the last hit is
 * what makes this work whether the provider emits one line or a thousand.
 */
/** The last NDJSON line that carries a `usage` object: the run's own accounting. */
function lastStreamEnvelope(stdout: string): Record<string, unknown> | null {
  let latest: Record<string, unknown> | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (typeof event.usage === "object" && event.usage !== null) latest = event;
  }
  return latest;
}

export function lastJsonLine(stdout: string, pick: (event: Record<string, unknown>) => string | null): string | null {
  let latest: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    const picked = pick(event);
    if (picked !== null) latest = picked;
  }
  return latest;
}

/**
 * The answer a run produced, in whichever dialect its CLI speaks, or `null` when it produced none.
 *
 * Exported because the write path needs the same reading: a builder that understood only Claude's
 * envelope reported "no report was returned by the worker" for a Codex, Grok or Antigravity run that
 * had answered perfectly well, and an unparseable answer had no words attached to diagnose it.
 */
export function providerAnswerText(providerId: string, stdout: string): string | null {
  try {
    return unwrapProviderOutput(providerId as ProviderId, stdout);
  } catch {
    return null;
  }
}

function unwrapProviderOutput(providerId: ProviderId, stdout: string): string {
  const trimmed = stdout.trim();
  if (providerId === "openai") return extractCodexAgentMessage(trimmed);
  if (providerId === "xai") {
    // A streamed run has no envelope: its answer is assembled from the pieces before this is
    // reached. What is left here is an error line, or an older non-streamed envelope whose
    // contract JSON is the `text` field.
    try {
      const outer = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof outer.text === "string") return outer.text;
      if (typeof outer.message === "string") throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", `Grok reported: ${boundedText(outer.message, 300)}`);
    } catch (error) {
      if (error instanceof BrainGateInvariantError) throw error;
    }
    const streamed = lastJsonLine(trimmed, (event) => (typeof event.message === "string" ? event.message : null));
    if (streamed !== null) throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", `Grok reported: ${boundedText(streamed, 300)}`);
  }
  if (providerId === "google") {
    // agy answers a stream-json run with NDJSON, and a single-shot run with one envelope. Both
    // shapes are read, because which one arrives depends on the build rather than on the request.
    const streamed = extractAntigravityResult(trimmed);
    if (streamed !== null) return streamed;
    try {
      const outer = JSON.parse(trimmed) as Record<string, unknown>;
      const response = outer.response;
      if (typeof response === "string" && response.trim().length > 0) return response;
      const denied = Array.isArray(outer.denied_actions) ? outer.denied_actions.length : 0;
      throw new BrainGateInvariantError(
        "SHADOW_RESPONSE_INVALID",
        denied > 0
          ? "Antigravity produced no answer because the tools it tried to use were auto-denied in headless mode."
          : "Antigravity returned an empty response.",
      );
    } catch (error) {
      if (error instanceof BrainGateInvariantError) throw error;
    }
  }
  if (providerId === "anthropic") {
    try {
      const outer = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof outer.result === "string") return outer.result;
      const structured = outer.structured_output;
      if (structured !== undefined) return JSON.stringify(structured);
    } catch { /* a streamed run is many lines, not one object */ }
    // The final envelope of a stream-json run, which is the last line rather than the whole
    // output. Reached only when the assembled answer was empty.
    const streamed = lastJsonLine(trimmed, (event) => {
      if (typeof event.result === "string") return event.result;
      return event.structured_output === undefined ? null : JSON.stringify(event.structured_output);
    });
    if (streamed !== null) return streamed;
  }
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

/**
 * The last complete JSON object in a string, or null.
 *
 * Walks backwards from each closing brace to its match, ignoring braces inside strings and
 * respecting escapes, and returns the first one that parses. That is the answer, because the
 * contract object is what a role emits last.
 */
export function lastBalancedJsonObject(text: string): Record<string, unknown> | null {
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let start = end; start >= 0; start -= 1) {
      const character = text[start]!;
      if (inString) {
        // Walking backwards, a quote ends the string only when it is not itself escaped, which
        // is decided by how many backslashes precede it.
        if (character === '"') {
          let slashes = 0;
          for (let back = start - 1; back >= 0 && text[back] === "\\"; back -= 1) slashes += 1;
          if (slashes % 2 === 0) inString = false;
        }
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === "}") depth += 1;
      else if (character === "{") {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; }
          catch { break; }
        }
      }
    }
    if (escaped) break;
  }
  return null;
}

/**
 * Parses the role contract from whichever of the two places this run put it.
 *
 * Both are tried rather than chosen by provider, because which one holds the answer is a
 * property of the run — whether the model filled the schema through a tool or wrote it out —
 * and not of the CLI's name.
 */
function parseRoleResponseWithFallback(role: AgentRequest["role"], providerId: ProviderId, stdout: string, assembled: string | null): AgentResponse {
  try {
    return parseRoleResponse(role, providerId, stdout);
  } catch (error) {
    if (assembled === null || assembled.trim().length === 0) throw error;
    return parseRoleResponse(role, providerId, assembled);
  }
}

function parseRoleResponse(role: AgentRequest["role"], providerId: ProviderId, stdout: string): AgentResponse {
  const candidate = unwrapProviderOutput(providerId, stdout);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    // The last complete object in the text, not everything between the first brace and the last.
    // A model that narrates before it answers puts braces in its prose — a code snippet, a JSON
    // example — and taking the outermost span then fails on a run that actually succeeded.
    const object = lastBalancedJsonObject(candidate);
    if (object === null) throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Provider did not return parseable JSON for the role contract.");
    parsed = object;
  }

  // `kind` only restates the role BrainGate already routed, so a provider that omits it has not
  // widened anything. A present-but-wrong `kind` still fails closed, because that means the
  // provider answered as a different role than the one that was requested.
  const expectedKind = role === "planner" || role === "primary" ? "work" : role === "reviewer" ? "review" : "judge";
  if (parsed.kind === undefined || parsed.kind === null) parsed = { ...parsed, kind: expectedKind };

  if (role === "planner" || role === "primary") {
    if (parsed.kind !== "work") throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Primary shadow response must have kind=work.");
    const output = boundedText(parsed.output);
    // An empty answer satisfies the contract's shape while saying nothing. Accepting it would
    // record a task as successful that produced no result at all — the one kind of completion the
    // operator cannot distinguish from real work.
    if (output.trim().length === 0) {
      throw new BrainGateInvariantError("SHADOW_RESPONSE_EMPTY", "The provider answered with an empty result.");
    }
    return Object.freeze({ kind: "work", output });
  }
  if (role === "reviewer") {
    if (parsed.kind !== "review" || !["approve", "request_changes", "disagree"].includes(String(parsed.verdict))) {
      throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Reviewer shadow response has an invalid verdict.");
    }
    return Object.freeze({ kind: "review", verdict: parsed.verdict as "approve" | "request_changes" | "disagree", findings: boundedFindings(parsed.findings) });
  }
  if (parsed.kind !== "judge" || !["approve", "request_changes"].includes(String(parsed.verdict))) {
    throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Judge shadow response has an invalid verdict.");
  }
  return Object.freeze({ kind: "judge", verdict: parsed.verdict as "approve" | "request_changes", rationale: boundedText(parsed.rationale, 4_000), findings: boundedFindings(parsed.findings) });
}


/**
 * Token counts a provider reports for itself, or null when it reports none.
 *
 * This is the difference between `native` and `estimated` in a receipt. Grok and Claude both
 * return their own accounting in headless JSON, and BrainGate was throwing it away and
 * recording `unknown` — which made "who burned what" the one question the ledger could not
 * answer, and that question is the reason the router exists.
 */
export function providerTokenUsage(providerId: string, stdout: string): { readonly input: number; readonly output: number; readonly cacheRead: number } | null {
  if (providerId !== "xai" && providerId !== "anthropic" && providerId !== "google") return null;
  let envelope: Record<string, unknown> | null = null;
  try { envelope = JSON.parse(stdout.trim()) as Record<string, unknown>; }
  catch { envelope = null; }
  // A stream reports its accounting inside the final result event rather than at the top level.
  // Reading only the outer object recorded `unknown` for a provider that had told us exactly
  // what it spent.
  if (envelope === null && providerId === "google") envelope = antigravityResultRecord(stdout);
  // A streamed run's accounting is in its last line — Claude's result envelope, Grok's `end`
  // event. Reading only the outer object recorded `unknown` for a provider that had said
  // exactly what it spent.
  if (envelope === null) envelope = lastStreamEnvelope(stdout);
  if (envelope === null) return null;
  const usage = envelope.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const input = record.input_tokens;
  const output = record.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  // Claude counts cached prompt tokens separately, so `input_tokens` alone reads as six tokens
  // for a request that actually carried thousands. Recording the cache read keeps the total
  // honest instead of flattering.
  const cached = record.cache_read_input_tokens ?? record.cache_read_tokens;
  const cacheRead = typeof cached === "number" && Number.isFinite(cached) && cached >= 0 ? cached : 0;
  return Object.freeze({ input, output, cacheRead });
}

/**
 * Recovers the provider's own account of why a run failed.
 *
 * A CLI that exits non-zero usually says what went wrong — turns exhausted, a denied tool, an
 * unreadable config — and BrainGate was discarding all of it in favour of "failed with exit 1".
 * That reduced an actionable failure to an opaque one: the user could not tell a budget that was
 * too small from a provider that was broken.
 *
 * Only recognised, bounded fields are surfaced. Provider output is untrusted and is not echoed
 * wholesale into an error message.
 */
export function providerFailureReason(providerId: string, stdout: string, stderr: string): string | null {
  if (providerId === "anthropic") {
    try {
      const parsed = JSON.parse(stdout.trim()) as { subtype?: unknown; errors?: unknown };
      const errors = Array.isArray(parsed.errors) ? parsed.errors.filter((entry): entry is string => typeof entry === "string") : [];
      if (errors.length > 0) return boundedText(errors[0], 300);
      if (typeof parsed.subtype === "string" && parsed.subtype !== "success") return boundedText(parsed.subtype, 120);
    } catch { /* not the structured shape; fall through to stderr */ }
  }
  const line = stderr.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0);
  return line === undefined ? null : boundedText(line, 300);
}

/** What to do about a failure BrainGate can recognise, so the message ends with a next step. */
function failureAdvice(reason: string | null): string {
  if (reason === null) return "";
  if (/maximum number of turns|max_turns/i.test(reason)) {
    return " The task needed more tool-use turns than its complexity was budgeted for; label the finished task with `dogfood feedback --actual-complexity` so routing raises the floor, or ask something narrower.";
  }
  if (/not logged in|authentication/i.test(reason)) return " Sign in with the provider's own CLI and re-run `braingate discover`.";
  return "";
}

/**
 * How one invocation relates to a native provider session, decided by the caller.
 *
 * The invoker knows the model and the role but not the goal, and the goal is what a session belongs
 * to; so the decision is asked for rather than made here. What comes back may also replace the
 * request's own `task` and `context`, which is how a returning worker is given a *delta* instead of
 * the whole handoff it already remembers living through.
 */
export interface NativeSessionResolution {
  readonly decision: {
    readonly kind: PlannedSessionKind;
    readonly sessionId: string | null;
    readonly providerId: ProviderId;
    readonly modelId: string;
    readonly resumeMode: PlannedSessionResumeMode;
    readonly reason: PlannedSessionReason | null;
    readonly persistent: boolean;
  };
  /** The request's own text, when the caller narrowed it — a delta plus the work unit. */
  readonly task?: string | undefined;
  readonly context?: unknown;
  /** Extra context for the receipt, describing what the caller decided and why. */
  readonly note?: string | undefined;
}

export type NativeSessionResolver = ((input: {
  readonly role: string;
  readonly phase: string;
  readonly model: { readonly providerId: string; readonly modelId: string; readonly quotaPool: string };
  readonly task: string;
  readonly context: unknown;
}) => Promise<NativeSessionResolution | null>) & {
  /**
   * What a run reported about its own session, when the runtime mints the id itself.
   *
   * A resolver that pins ids has nothing to report: the id was chosen before the call. This exists
   * for the runtimes that publish theirs in their output, where the reference can only be recorded
   * once the run has started saying what it is. Optional, because a caller that does not keep
   * sessions has nothing to record — and a resolver that cannot record must not stop the run.
   */
  readonly reportReported?: (input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly sessionId: string;
  }) => void;
};

export class SubscriptionShadowAgentInvoker implements AgentInvoker {
  readonly #project: ExecutionProject;
  readonly #cwd: string;
  readonly #snapshots: ReadonlyMap<string, ProviderSnapshot>;
  readonly #attestations: ReadonlyMap<string, SubscriptionAttestation>;
  // A list rather than a map, because one provider can carry two different decisions and a map
  // keyed by provider silently kept whichever was written last.
  readonly #acceptances: readonly OperatorProviderAcceptance[];
  readonly #codexIsolation: CodexIsolationAttestation | undefined;
  readonly #grokIsolation: GrokIsolationAttestation | undefined;
  readonly #grokSnapshotIsolation: GrokIsolationAttestation | undefined;
  readonly #context: unknown;
  readonly #executor: ShadowProcessExecutor;
  readonly #ledger: TaskLedger | null;
  readonly #taskId: string | null;
  readonly #maxTurns: number | undefined;
  readonly #fanOut: boolean;
  readonly #maxSubagents: number;
  #subagentsSpent = 0;
  readonly #onRoleActivity: ((activity: RoleActivity) => void) | undefined;
  readonly #onText: ((text: string) => void) | undefined;
  readonly #onThinking: (() => void) | undefined;
  readonly #onQuotaReading: ((reading: QuotaReading & { readonly quotaPool: string }) => void) | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #snapshotStore: TaskSnapshotProvider | undefined;
  readonly #nativeHarness: boolean;
  readonly #nativeSession: NativeSessionResolver | undefined;
  /**
   * The last plan this invoker built, so a caller can read back what actually ran.
   *
   * The plan is where the session decision and the arguments both live, and reconstructing either
   * from the response would be a second derivation of the same fact. Read, not decided, here.
   */
  #lastPlan: ShadowInvocationPlan | null = null;
  #lastSessionNote: string | null = null;

  constructor(input: {
    readonly project: ExecutionProject;
    readonly cwd: string;
    readonly snapshots: readonly ProviderSnapshot[];
    readonly attestations?: readonly SubscriptionAttestation[];
    readonly acceptances?: readonly OperatorProviderAcceptance[];
    readonly codexIsolation?: CodexIsolationAttestation;
    readonly grokIsolation?: GrokIsolationAttestation;
    /** The snapshot-read proof, which is a different posture from the staged one. */
    readonly grokSnapshotIsolation?: GrokIsolationAttestation;
    readonly context: unknown;
    readonly executor?: ShadowProcessExecutor;
    readonly ledger?: TaskLedger;
    readonly taskId?: string;
    /**
     * Where a read-primary run's project copy comes from.
     *
     * Injected rather than imported: this package must not depend on the package that copies projects.
     * A provider that is snapshot-capable and attestation-current but handed no provider fails closed
     * rather than falling back to the checkout, which is the whole point of the mode.
     */
    readonly snapshotStore?: TaskSnapshotProvider;
    /**
     * Asked, per invocation, whether this run continues a native provider session.
     *
     * Injected rather than reached for: the goals live in a package the execution layer must not
     * depend on, and the decision is a property of the *goal* rather than of the run. Absent, no
     * session is pinned, none is resumed, and nothing is persisted — the pre-M20.2 behaviour.
     */
    readonly nativeSession?: NativeSessionResolver;
    /**
     * Whether this run keeps the runtime's own harness (the DIRECT policy, ADR 0017). One flag for
     * one decision: the plan builder is the only place that turns it into argv.
     */
    readonly nativeHarness?: boolean;
    /** Tool-use turns a read-only inspection may spend; from the task's execution budget. */
    readonly maxTurns?: number;
    /** Wall-clock allowance for one invocation; from the task's execution budget. */
    readonly timeoutMs?: number;
    /**
     * Whether this task's budget allows more than one agent at once.
     *
     * `ExecutionBudget.maxConcurrentAgents > 1`, passed through rather than re-derived: subagents
     * are concurrent agents, so the number that already bounds concurrency decides whether a run
     * may hand work to helpers. A cheap question does not fan out; a T3 audit may.
     */
    readonly fanOut?: boolean;
    /**
     * Agent executions inside providers this whole task may spend, across every role.
     *
     * `maxConcurrentAgents` decided whether a run could have helpers at all; nothing counted
     * them once it did. This is the ceiling, and it is cumulative for the task rather than per
     * call — otherwise a task with four roles quietly gets four times the fan-out its budget
     * granted once.
     */
    readonly maxSubagents?: number;
    /**
     * Told, as each role starts and finishes, which provider and model is working.
     *
     * The ledger already records this, but only a reader who goes looking afterwards sees it.
     * A terminal watching a task run has one question while it waits — who is doing this right
     * now — and answering it is the whole difference between a spinner and a control plane.
     */
    readonly onRoleActivity?: (activity: RoleActivity) => void;
    /** Told the model's prose as it is written, for a provider whose stream shape is known. */
    readonly onText?: (text: string) => void;
    /** Told once per role, when the model starts reasoning before it says anything. */
    readonly onThinking?: () => void;
    /**
     * Told what the provider said about its own remaining window, when it says anything.
     *
     * Free: the reading arrives on its own alongside the answer. Routing has been comparing
     * pools against each other for want of exactly this.
     */
    readonly onQuotaReading?: (reading: QuotaReading & { readonly quotaPool: string }) => void;
  }) {
    this.#project = input.project;
    this.#cwd = input.cwd;
    this.#snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.providerId, snapshot]));
    this.#attestations = new Map((input.attestations ?? []).map((attestation) => [attestation.providerId, attestation]));
    this.#acceptances = Object.freeze([...(input.acceptances ?? [])]);
    this.#codexIsolation = input.codexIsolation;
    this.#grokIsolation = input.grokIsolation;
    this.#grokSnapshotIsolation = input.grokSnapshotIsolation;
    this.#context = input.context;
    this.#executor = input.executor ?? new NodeShadowProcessExecutor();
    this.#ledger = input.ledger ?? null;
    this.#taskId = input.taskId ?? null;
    this.#maxTurns = input.maxTurns;
    this.#fanOut = input.fanOut ?? false;
    this.#maxSubagents = Math.max(0, Math.floor(input.maxSubagents ?? 0));
    this.#onRoleActivity = input.onRoleActivity;
    this.#onText = input.onText;
    this.#onThinking = input.onThinking;
    this.#onQuotaReading = input.onQuotaReading;
    this.#timeoutMs = input.timeoutMs;
    this.#snapshotStore = input.snapshotStore;
    this.#nativeHarness = input.nativeHarness === true;
    this.#nativeSession = input.nativeSession;
    if ((this.#ledger === null) !== (this.#taskId === null)) throw new BrainGateInvariantError("SHADOW_LEDGER_INVALID", "ledger and taskId must be supplied together.");
  }

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const snapshot = this.#snapshots.get(request.model.providerId);
    if (snapshot === undefined) throw new BrainGateInvariantError("SHADOW_SNAPSHOT_MISSING", `No provider discovery snapshot for ${request.model.providerId}.`);

    // Asked before the payload is built, because what it answers decides the payload's own `task`
    // and `context`: a worker resuming its own session is handed the delta since its last turn
    // rather than the handoff it already remembers, and asking afterwards would mean building the
    // wrong prompt first and replacing it second.
    const resolution = await this.#resolveNativeSession(request);
    const session = resolution?.decision ?? null;
    const payload: ShadowRolePayload = Object.freeze({
      schemaVersion: 1,
      role: request.role,
      phase: request.phase,
      task: resolution?.task ?? request.task,
      findings: Object.freeze([...request.findings]),
      candidateOutput: request.candidateOutput == null ? null : boundedText(request.candidateOutput),
      // Without this the executor receives a plan in the same field a reviewer receives a draft,
      // and treats the approach it was given as something to critique rather than to follow.
      candidateOutputRole: request.candidateOutput == null ? null : (request.role === "primary" ? "approach-to-follow" : "prior-result-under-review"),
      context: resolution === null || resolution.context === undefined ? this.#context : resolution.context,
      responseContract: responseContract(request.role),
    });
    const attestation = this.#attestations.get(request.model.providerId);
    const acceptance = this.#acceptances.find((item) => item.providerId === request.model.providerId && item.source === "operator-accepted-unscoped-provider");
    const networkAcceptance = this.#acceptances.find((item) => item.providerId === request.model.providerId && item.source === "operator-accepted-network-access");
    // Read-primary on a snapshot-capable provider reads a copy BrainGate made for this task. The
    // decision is made here, from the provider's capability and its current sandbox attestation, and
    // the copy is created once per task and reused by every later attempt.
    // Read-primary only, and only for a provider whose sandbox BrainGate can currently attest. A
    // reviewer on the same provider keeps its staged workspace: the role decides the mode, not the
    // provider, so an attestation for one role never silently changes how another one executes.
    // A DIRECT run reads the workspace the operator selected. Substituting a copy for it would
    // make the plan say `project` and the run read something else, which is the one thing the
    // DIRECT contract forbids outright.
    const snapshotPrimary = this.#nativeHarness !== true && request.role === "primary" && snapshotPrimaryEligibility({
      providerId: snapshot.providerId,
      snapshot,
      ...(this.#codexIsolation === undefined ? {} : { codexIsolation: this.#codexIsolation }),
      ...(this.#grokIsolation === undefined ? {} : { grokIsolation: this.#grokIsolation }),
      ...(this.#grokSnapshotIsolation === undefined ? {} : { grokSnapshotIsolation: this.#grokSnapshotIsolation }),
    }).eligible;
    let snapshotEvidence: TaskSnapshotEvidence | null = null;
    if (snapshotPrimary) {
      if (this.#snapshotStore === undefined || this.#taskId === null) {
        throw new BrainGateInvariantError("SHADOW_SNAPSHOT_PROVIDER_MISSING", "A snapshot-primary run needs the snapshot provider, and it was not supplied.");
      }
      snapshotEvidence = this.#snapshotStore.ensure({ taskId: this.#taskId, source: this.#cwd });
      this.#event("task.snapshot", {
        snapshotId: snapshotEvidence.snapshotId,
        manifestHash: snapshotEvidence.manifestHash,
        fileCount: snapshotEvidence.fileCount,
        totalBytes: snapshotEvidence.totalBytes,
        policyVersion: snapshotEvidence.policyVersion,
        sourceFingerprint: snapshotEvidence.sourceFingerprint,
        workspaceMode: "staged-read-snapshot",
        role: request.role,
        provider: request.model.providerId,
        model: request.model.modelId,
      });
    }
    const plan = planShadowInvocation({
      snapshot,
      model: request.model,
      ...(session === null ? {} : { nativeSession: session }),
      ...(this.#nativeHarness ? { nativeHarness: true } : {}),
      cwd: this.#cwd,
      ...(snapshotEvidence === null ? {} : { snapshotPrimary: true, workspaceRoot: snapshotEvidence.root }),
      ...(this.#grokSnapshotIsolation === undefined ? {} : { grokSnapshotIsolation: this.#grokSnapshotIsolation }),
      payload,
      ...(this.#maxTurns === undefined ? {} : { maxTurns: this.#maxTurns }),
      // Closed once the task has spent what it was granted. Enforced before the call rather
      // than reported after it, so the ceiling costs nothing to hold.
      fanOut: this.#fanOut && this.#subagentsSpent < this.#maxSubagents,
      ...(attestation === undefined ? {} : { attestation }),
      ...(acceptance === undefined ? {} : { acceptance }),
      ...(networkAcceptance === undefined ? {} : { networkAcceptance }),
      ...(request.model.providerId === "openai" && this.#codexIsolation !== undefined ? { codexIsolation: this.#codexIsolation } : {}),
      ...(request.model.providerId === "xai" && this.#grokIsolation !== undefined ? { grokIsolation: this.#grokIsolation } : {}),
    });
    const safeMeta = Object.freeze({
      role: request.role,
      phase: request.phase,
      provider: request.model.providerId,
      model: request.model.modelId,
      quotaPool: request.model.quotaPool,
      // The workspace this attempt actually received. Recorded on every provider event so the mode
      // travels with the attempt instead of being inferred later from what was planned.
      workspaceMode: plan.workspaceMode,
    });
    this.#lastPlan = plan;
    this.#lastSessionNote = resolution?.note ?? null;
    // Recorded before the call, so a run that never returns still says which session it was for.
    // The id is the one BrainGate pinned, not a value read back from the provider, so it exists
    // whether or not the run ever reported anything.
    if (session !== null && session.kind !== "disabled") {
      this.#event("session.invocation", {
        ...safeMeta,
        kind: session.kind,
        sessionId: session.sessionId,
        resumeMode: session.resumeMode,
        persistent: session.persistent,
        ...(this.#lastSessionNote === null ? {} : { note: this.#lastSessionNote }),
      });
    }
    this.#event("shadow.provider.started", safeMeta);
    this.#activity({ ...safeMeta, stage: "started", grant: Object.freeze([...plan.grant.granted]) });
    // What the run said, kept for the failure path. A message like "the provider did not return
    // parseable JSON" is a diagnosis with no evidence in it, and the evidence is the answer that
    // failed to parse — which the process-level failure branch already keeps and this one did not.
    let observedStdout: string | null = null;
    try {
      const result = await this.#executor.run({
        project: this.#project,
        plan,
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
        ...(this.#onText === undefined ? {} : { onText: this.#onText }),
        ...(this.#onThinking === undefined ? {} : { onThinking: this.#onThinking }),
      });
      // What the runtime said about its own session, recorded while the run is still in hand. The
      // resolver owns the goal this belongs to; this layer only knows what came back, and only a run
      // that succeeded is worth recording a session for.
      if (result.exitCode === 0 && session !== null && session.sessionId === null) {
        const reported = reportedSessionIdOf(request.model.providerId, result.stdout);
        if (reported !== null) this.#nativeSession?.reportReported?.({ providerId: request.model.providerId, modelId: request.model.modelId, sessionId: reported });
      }
      // The copy the provider was given must still match its manifest, byte for byte, before anything
      // it said is believed. A run that wrote into it is a boundary violation whether or not it also
      // produced an answer — and an answer from a workspace that changed underneath it is not one
      // BrainGate may present as a reading of the project.
      if (snapshotEvidence !== null) {
        if (this.#snapshotStore === undefined || this.#taskId === null || !this.#snapshotStore.verify(this.#taskId)) {
          this.#event("shadow.snapshot.mutated", { ...safeMeta, snapshotId: snapshotEvidence.snapshotId, manifestHash: snapshotEvidence.manifestHash });
          throw new BrainGateInvariantError("SHADOW_SNAPSHOT_MUTATED", "The provider's read-only project snapshot changed during the run, so its output is discarded.");
        }
      }
      observedStdout = result.stdoutTail ?? result.stdout;
      if (!result.spawned || result.timedOut || result.exitCode !== 0) {
        const failureKind = result.timedOut ? "timeout" : "provider-failed";
        // Recognised before the event is written, so the refusal is in the failure record itself and
        // every reader — `tasks show`, the dashboard, a reconciler — sees the same fact.
        const failureRefusal = providerQuotaRefusal(request.model.providerId, request.model.quotaPool, `${result.stdout}\n${result.stdoutTail ?? ""}`);
        this.#event("shadow.provider.failed", {
          ...(failureRefusal === null ? {} : { quotaRefusal: failureRefusal }),
          ...safeMeta,
          failureKind,
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          error: redactSecrets(result.stderr).slice(0, 500),
          // Bounded, redacted evidence of what the CLI actually said. A refusal BrainGate does not
          // yet understand is still diagnosable later, from the words the provider used — and none
          // of it is interpreted here.
          stderrTail: redactSecrets(result.stderr).slice(-2_000),
          stdoutTail: redactSecrets(result.stdoutTail ?? result.stdout).slice(-2_000),
          retainedChars: result.stdout.length,
        });
        // A refusal must be able to record itself. Readings used to be collected only after the
        // exit-code check below had already thrown, so a call that was refused — the one case where
        // the provider is telling us something about its own limit — recorded nothing at all, and
        // the next task was dispatched to the same pool. The tail is included because a streamed
        // run's retained output is thinned on the way in.
        for (const reading of quotaReadings(snapshot.providerId, `${result.stdout}\n${result.stdoutTail ?? ""}`)) {
          try { this.#onQuotaReading?.({ ...reading, quotaPool: request.model.quotaPool }); }
          catch { /* a reading nobody could record is not a reason to lose the failure */ }
        }
        const reason = providerFailureReason(request.model.providerId, result.stdout, result.stderr);
        // A structured quota refusal is the one failure that says a *different* pool would do
        // better, so it is recognised here — from the provider's own machine-readable statement —
        // and carried on the error. Everything else stays an ordinary failure.
        const refusal = failureRefusal;
        if (refusal !== null) {
          this.#event("shadow.provider.quota_refused", { ...safeMeta, reason: refusal.reason, resetAt: refusal.resetAt, detail: refusal.detail.slice(0, 500) });
        }
        const message = `Shadow provider ${request.model.providerId}/${request.model.modelId} failed with exit ${result.exitCode ?? "none"}${result.timedOut ? " (timeout/output cap)" : ""}.${reason === null ? "" : ` The provider reported: ${reason}.`}${failureAdvice(reason)}`;
        if (refusal === null) throw new BrainGateInvariantError("SHADOW_PROVIDER_FAILED", message);
        throw new ProviderQuotaRefusalError(
          "SHADOW_PROVIDER_FAILED",
          `${message} The provider refused this call on quota (${refusal.reason}, pool ${refusal.quotaPool}); the pool is excluded for the rest of this task.`,
          refusal,
        );
      }
      // A Grok build that cannot apply the profile now warns and carries on (measured against
      // 1.0.24), so a successful exit is not by itself evidence the sandbox was in force. The
      // run is discarded rather than its answer accepted: an unsandboxed run is the one case the
      // attestation exists to make impossible.
      if (snapshot.providerId === "xai" && grokSandboxNotApplied(`${result.stdout}\n${result.stderr}`)) {
        this.#event("shadow.provider.failed", { ...safeMeta, reason: "sandbox-not-applied" });
        throw new BrainGateInvariantError("SHADOW_GROK_SANDBOX_NOT_APPLIED", "Grok reported that the BrainGate sandbox profile was not applied, so this run was not confined. Its output is discarded.");
      }
      // A streamed run's answer is what was assembled from its pieces; the retained output no
      // longer holds it, by design.
      for (const reading of quotaReadings(snapshot.providerId, result.stdout)) {
        try { this.#onQuotaReading?.({ ...reading, quotaPool: request.model.quotaPool }); }
        catch { /* a reading nobody could record is not a reason to lose the answer */ }
      }
      // The retained output first, because a provider that fills the schema through a tool puts
      // the contract in its final envelope and streams only prose. When there is no envelope —
      // a stream whose answer exists solely in its pieces — the assembled text is the answer.
      // Counted before the answer is returned, so the next role in this task sees what this one
      // spent. A provider that reports nothing is charged the ceiling for having been allowed to
      // fan out at all: an uncounted helper must not be a free one.
      const spawned = subagentUsage(snapshot.providerId, result.stdout);
      if (grants(plan.grant, "subagents")) {
        this.#subagentsSpent += spawned === null ? this.#maxSubagents : spawned.spawned;
        if (spawned !== null && spawned.spawned > this.#maxSubagents) {
          this.#event("shadow.provider.fanout_exceeded", { ...safeMeta, spawned: spawned.spawned, ceiling: this.#maxSubagents });
        }
      }
      const response = parseRoleResponseWithFallback(request.role, snapshot.providerId, result.stdout, result.assembled ?? null);
      this.#event("shadow.provider.completed", { ...safeMeta, durationMs: result.durationMs });
      this.#activity({ ...safeMeta, stage: "completed", grant: Object.freeze([...plan.grant.granted]), durationMs: result.durationMs });
      this.#usage(
        request,
        result.durationMs,
        providerTokenUsage(snapshot.providerId, result.stdout),
        spawned,
        grants(plan.grant, "subagents"),
      );
      return response;
    } catch (error) {
      if (!(error instanceof BrainGateInvariantError && error.code === "SHADOW_PROVIDER_FAILED")) {
        this.#event("shadow.provider.failed", {
          ...safeMeta,
          failureKind: error instanceof BrainGateInvariantError ? failureKindFromCode(error.code) : "unknown",
          code: error instanceof BrainGateInvariantError ? error.code : "UNKNOWN",
          error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500),
          ...(observedStdout === null ? {} : { stdoutTail: redactSecrets(observedStdout).slice(-2_000) }),
        });
      }
      throw error;
    }
  }

  #activity(activity: RoleActivity): void {
    // Never allowed to end a task: a terminal that fails to draw is not a reason to discard a
    // provider's answer.
    try { this.#onRoleActivity?.(activity); } catch { /* the display is not the work */ }
  }

  #event(kind: string, payload: unknown): void {
    if (this.#ledger !== null && this.#taskId !== null) this.#ledger.appendEvent(this.#taskId, kind, payload);
  }

  /**
   * Asks the caller how this invocation relates to a native session.
   *
   * A resolver that throws, or that answers with an id this provider's policy does not support, is
   * refused rather than allowed to describe a continuation that did not happen. Nothing else in the
   * invoker interprets the answer: it is put on the plan, and the recorder reads it from there.
   */
  async #resolveNativeSession(request: AgentRequest): Promise<NativeSessionResolution | null> {
    if (this.#nativeSession === undefined) return null;
    const resolved = await this.#nativeSession({
      role: request.role,
      phase: request.phase,
      model: request.model,
      task: request.task,
      context: this.#context,
    });
    if (resolved === null) return null;
    const { decision } = resolved;
    if (decision.sessionId !== null && (decision.kind === "resumed" || decision.kind === "fresh") && decision.sessionId.trim().length === 0) {
      throw new BrainGateInvariantError("SHADOW_SESSION_INVALID", "A native session decision named a session with an empty id.");
    }
    return resolved;
  }

  /**
   * What the last invocation actually did about sessions, for the run's record.
   *
   * `null` when nothing has run yet. Read from the plan rather than re-derived, so the receipt and
   * the arguments cannot disagree about whether a session was continued.
   */
  lastInvocation(): { readonly plan: ShadowInvocationPlan; readonly note: string | null } | null {
    return this.#lastPlan === null ? null : Object.freeze({ plan: this.#lastPlan, note: this.#lastSessionNote });
  }

  #usage(
    request: AgentRequest,
    durationMs: number,
    tokens: { readonly input: number; readonly output: number; readonly cacheRead: number } | null,
    subagents: SubagentUsage | null,
    fanOutGranted: boolean,
  ): void {
    if (this.#ledger === null || this.#taskId === null) return;
    const row = { taskId: this.#taskId, provider: request.model.providerId, model: request.model.modelId } as const;
    this.#ledger.recordUsage({ ...row, evidence: "measured", metric: "provider_call", value: 1, unit: "call" });
    this.#ledger.recordUsage({ ...row, evidence: "measured", metric: "duration_ms", value: durationMs, unit: "ms" });
    // Agent executions that happened inside the provider, which `provider_call` never counted.
    // The budget decided whether fan-out was allowed; this is what it cost. A provider that
    // reports nothing is `unknown`, not zero — and a run that was never granted helpers records
    // a hard zero, because there the absence is BrainGate's own doing and is worth asserting.
    if (subagents !== null) {
      this.#ledger.recordUsage({ ...row, evidence: "native", metric: "provider_subagents", value: subagents.spawned, unit: "agents" });
      this.#ledger.recordUsage({ ...row, evidence: "native", metric: "provider_subagents_completed", value: subagents.completed, unit: "agents" });
    } else if (!fanOutGranted) {
      this.#ledger.recordUsage({ ...row, evidence: "measured", metric: "provider_subagents", value: 0, unit: "agents" });
    } else {
      this.#ledger.recordUsage({ ...row, evidence: "unknown", metric: "provider_subagents", value: null, unit: "agents" });
    }
    // `native` only when the provider counted them itself. A total assembled from anything
    // else stays `unknown` rather than becoming a number the operator would read as authority.
    if (tokens === null) {
      this.#ledger.recordUsage({ ...row, evidence: "unknown", metric: "provider_tokens", value: null, unit: "tokens" });
      return;
    }
    this.#ledger.recordUsage({ ...row, evidence: "native", metric: "provider_input_tokens", value: tokens.input, unit: "tokens" });
    this.#ledger.recordUsage({ ...row, evidence: "native", metric: "provider_output_tokens", value: tokens.output, unit: "tokens" });
    this.#ledger.recordUsage({ ...row, evidence: "native", metric: "provider_cache_read_tokens", value: tokens.cacheRead, unit: "tokens" });
    this.#ledger.recordUsage({ ...row, evidence: "native", metric: "provider_tokens", value: tokens.input + tokens.output + tokens.cacheRead, unit: "tokens" });
  }
}
