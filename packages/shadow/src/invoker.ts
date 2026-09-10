import { BrainGateInvariantError, type RegisteredProject, type TaskLedger } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import { redactSecrets } from "@braingate/security";
import type { AgentInvoker, AgentRequest, AgentResponse } from "@braingate/workflows";
import type { CodexIsolationAttestation } from "./codex-isolation.js";
import { grokSandboxNotApplied, type GrokIsolationAttestation } from "./grok-isolation.js";
import { planShadowInvocation } from "./profiles.js";
import { NodeShadowProcessExecutor } from "./process-executor.js";
import type { OperatorProviderAcceptance, ShadowProcessExecutor, ShadowRolePayload, SubscriptionAttestation } from "./types.js";

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

function parseRoleResponse(role: AgentRequest["role"], providerId: ProviderId, stdout: string): AgentResponse {
  const candidate = unwrapProviderOutput(providerId, stdout);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Provider did not return parseable JSON for the role contract.");
    try { parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>; }
    catch { throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Provider returned malformed JSON for the role contract."); }
  }

  // `kind` only restates the role BrainGate already routed, so a provider that omits it has not
  // widened anything. A present-but-wrong `kind` still fails closed, because that means the
  // provider answered as a different role than the one that was requested.
  const expectedKind = role === "planner" || role === "primary" ? "work" : role === "reviewer" ? "review" : "judge";
  if (parsed.kind === undefined || parsed.kind === null) parsed = { ...parsed, kind: expectedKind };

  if (role === "planner" || role === "primary") {
    if (parsed.kind !== "work") throw new BrainGateInvariantError("SHADOW_RESPONSE_INVALID", "Primary shadow response must have kind=work.");
    return Object.freeze({ kind: "work", output: boundedText(parsed.output) });
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

export class SubscriptionShadowAgentInvoker implements AgentInvoker {
  readonly #project: RegisteredProject;
  readonly #cwd: string;
  readonly #snapshots: ReadonlyMap<string, ProviderSnapshot>;
  readonly #attestations: ReadonlyMap<string, SubscriptionAttestation>;
  readonly #acceptances: ReadonlyMap<string, OperatorProviderAcceptance>;
  readonly #codexIsolation: CodexIsolationAttestation | undefined;
  readonly #grokIsolation: GrokIsolationAttestation | undefined;
  readonly #context: unknown;
  readonly #executor: ShadowProcessExecutor;
  readonly #ledger: TaskLedger | null;
  readonly #taskId: string | null;
  readonly #maxTurns: number | undefined;
  readonly #fanOut: boolean;
  readonly #onRoleActivity: ((activity: RoleActivity) => void) | undefined;
  readonly #onText: ((text: string) => void) | undefined;
  readonly #onThinking: (() => void) | undefined;
  readonly #timeoutMs: number | undefined;

  constructor(input: {
    readonly project: RegisteredProject;
    readonly cwd: string;
    readonly snapshots: readonly ProviderSnapshot[];
    readonly attestations?: readonly SubscriptionAttestation[];
    readonly acceptances?: readonly OperatorProviderAcceptance[];
    readonly codexIsolation?: CodexIsolationAttestation;
    readonly grokIsolation?: GrokIsolationAttestation;
    readonly context: unknown;
    readonly executor?: ShadowProcessExecutor;
    readonly ledger?: TaskLedger;
    readonly taskId?: string;
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
  }) {
    this.#project = input.project;
    this.#cwd = input.cwd;
    this.#snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.providerId, snapshot]));
    this.#attestations = new Map((input.attestations ?? []).map((attestation) => [attestation.providerId, attestation]));
    this.#acceptances = new Map((input.acceptances ?? []).map((acceptance) => [acceptance.providerId, acceptance]));
    this.#codexIsolation = input.codexIsolation;
    this.#grokIsolation = input.grokIsolation;
    this.#context = input.context;
    this.#executor = input.executor ?? new NodeShadowProcessExecutor();
    this.#ledger = input.ledger ?? null;
    this.#taskId = input.taskId ?? null;
    this.#maxTurns = input.maxTurns;
    this.#fanOut = input.fanOut ?? false;
    this.#onRoleActivity = input.onRoleActivity;
    this.#onText = input.onText;
    this.#onThinking = input.onThinking;
    this.#timeoutMs = input.timeoutMs;
    if ((this.#ledger === null) !== (this.#taskId === null)) throw new BrainGateInvariantError("SHADOW_LEDGER_INVALID", "ledger and taskId must be supplied together.");
  }

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const snapshot = this.#snapshots.get(request.model.providerId);
    if (snapshot === undefined) throw new BrainGateInvariantError("SHADOW_SNAPSHOT_MISSING", `No provider discovery snapshot for ${request.model.providerId}.`);
    const payload: ShadowRolePayload = Object.freeze({
      schemaVersion: 1,
      role: request.role,
      phase: request.phase,
      task: request.task,
      findings: Object.freeze([...request.findings]),
      candidateOutput: request.candidateOutput == null ? null : boundedText(request.candidateOutput),
      // Without this the executor receives a plan in the same field a reviewer receives a draft,
      // and treats the approach it was given as something to critique rather than to follow.
      candidateOutputRole: request.candidateOutput == null ? null : (request.role === "primary" ? "approach-to-follow" : "prior-result-under-review"),
      context: this.#context,
      responseContract: responseContract(request.role),
    });
    const attestation = this.#attestations.get(request.model.providerId);
    const acceptance = this.#acceptances.get(request.model.providerId);
    const plan = planShadowInvocation({
      snapshot,
      model: request.model,
      cwd: this.#cwd,
      payload,
      ...(this.#maxTurns === undefined ? {} : { maxTurns: this.#maxTurns }),
      fanOut: this.#fanOut,
      ...(attestation === undefined ? {} : { attestation }),
      ...(acceptance === undefined ? {} : { acceptance }),
      ...(request.model.providerId === "openai" && this.#codexIsolation !== undefined ? { codexIsolation: this.#codexIsolation } : {}),
      ...(request.model.providerId === "xai" && this.#grokIsolation !== undefined ? { grokIsolation: this.#grokIsolation } : {}),
    });
    const safeMeta = Object.freeze({ role: request.role, phase: request.phase, provider: request.model.providerId, model: request.model.modelId, quotaPool: request.model.quotaPool });
    this.#event("shadow.provider.started", safeMeta);
    this.#activity({ ...safeMeta, stage: "started", grant: Object.freeze([...plan.grant.granted]) });
    try {
      const result = await this.#executor.run({
        project: this.#project,
        plan,
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
        ...(this.#onText === undefined ? {} : { onText: this.#onText }),
        ...(this.#onThinking === undefined ? {} : { onThinking: this.#onThinking }),
      });
      if (!result.spawned || result.timedOut || result.exitCode !== 0) {
        this.#event("shadow.provider.failed", { ...safeMeta, timedOut: result.timedOut, exitCode: result.exitCode, error: redactSecrets(result.stderr).slice(0, 500) });
        const reason = providerFailureReason(request.model.providerId, result.stdout, result.stderr);
        throw new BrainGateInvariantError(
          "SHADOW_PROVIDER_FAILED",
          `Shadow provider ${request.model.providerId}/${request.model.modelId} failed with exit ${result.exitCode ?? "none"}${result.timedOut ? " (timeout/output cap)" : ""}.${reason === null ? "" : ` The provider reported: ${reason}.`}${failureAdvice(reason)}`,
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
      const response = parseRoleResponse(request.role, snapshot.providerId, result.assembled ?? result.stdout);
      this.#event("shadow.provider.completed", { ...safeMeta, durationMs: result.durationMs });
      this.#activity({ ...safeMeta, stage: "completed", grant: Object.freeze([...plan.grant.granted]), durationMs: result.durationMs });
      this.#usage(request, result.durationMs, providerTokenUsage(snapshot.providerId, result.stdout));
      return response;
    } catch (error) {
      if (!(error instanceof BrainGateInvariantError && error.code === "SHADOW_PROVIDER_FAILED")) {
        this.#event("shadow.provider.failed", { ...safeMeta, error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500) });
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

  #usage(request: AgentRequest, durationMs: number, tokens: { readonly input: number; readonly output: number; readonly cacheRead: number } | null): void {
    if (this.#ledger === null || this.#taskId === null) return;
    const row = { taskId: this.#taskId, provider: request.model.providerId, model: request.model.modelId } as const;
    this.#ledger.recordUsage({ ...row, evidence: "measured", metric: "provider_call", value: 1, unit: "call" });
    this.#ledger.recordUsage({ ...row, evidence: "measured", metric: "duration_ms", value: durationMs, unit: "ms" });
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
