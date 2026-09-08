import { BrainGateInvariantError, type RegisteredProject, type TaskLedger } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import { redactSecrets } from "@braingate/security";
import type { AgentInvoker, AgentRequest, AgentResponse } from "@braingate/workflows";
import type { CodexIsolationAttestation } from "./codex-isolation.js";
import { planShadowInvocation } from "./profiles.js";
import { NodeShadowProcessExecutor } from "./process-executor.js";
import type { ShadowProcessExecutor, ShadowRolePayload, SubscriptionAttestation } from "./types.js";

function responseContract(role: AgentRequest["role"]): Readonly<Record<string, unknown>> {
  if (role === "primary") return Object.freeze({ kind: "work", output: "string" });
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

function unwrapProviderOutput(providerId: ProviderId, stdout: string): string {
  const trimmed = stdout.trim();
  if (providerId === "openai") return extractCodexAgentMessage(trimmed);
  if (providerId === "anthropic") {
    try {
      const outer = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof outer.result === "string") return outer.result;
      const structured = outer.structured_output;
      if (structured !== undefined) return JSON.stringify(structured);
    } catch { /* parse role JSON below */ }
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
  const expectedKind = role === "primary" ? "work" : role === "reviewer" ? "review" : "judge";
  if (parsed.kind === undefined || parsed.kind === null) parsed = { ...parsed, kind: expectedKind };

  if (role === "primary") {
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
  readonly #codexIsolation: CodexIsolationAttestation | undefined;
  readonly #context: unknown;
  readonly #executor: ShadowProcessExecutor;
  readonly #ledger: TaskLedger | null;
  readonly #taskId: string | null;
  readonly #maxTurns: number | undefined;
  readonly #timeoutMs: number | undefined;

  constructor(input: {
    readonly project: RegisteredProject;
    readonly cwd: string;
    readonly snapshots: readonly ProviderSnapshot[];
    readonly attestations?: readonly SubscriptionAttestation[];
    readonly codexIsolation?: CodexIsolationAttestation;
    readonly context: unknown;
    readonly executor?: ShadowProcessExecutor;
    readonly ledger?: TaskLedger;
    readonly taskId?: string;
    /** Tool-use turns a read-only inspection may spend; from the task's execution budget. */
    readonly maxTurns?: number;
    /** Wall-clock allowance for one invocation; from the task's execution budget. */
    readonly timeoutMs?: number;
  }) {
    this.#project = input.project;
    this.#cwd = input.cwd;
    this.#snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.providerId, snapshot]));
    this.#attestations = new Map((input.attestations ?? []).map((attestation) => [attestation.providerId, attestation]));
    this.#codexIsolation = input.codexIsolation;
    this.#context = input.context;
    this.#executor = input.executor ?? new NodeShadowProcessExecutor();
    this.#ledger = input.ledger ?? null;
    this.#taskId = input.taskId ?? null;
    this.#maxTurns = input.maxTurns;
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
      context: this.#context,
      responseContract: responseContract(request.role),
    });
    const attestation = this.#attestations.get(request.model.providerId);
    const plan = planShadowInvocation({
      snapshot,
      model: request.model,
      cwd: this.#cwd,
      payload,
      ...(this.#maxTurns === undefined ? {} : { maxTurns: this.#maxTurns }),
      ...(attestation === undefined ? {} : { attestation }),
      ...(request.model.providerId === "openai" && this.#codexIsolation !== undefined ? { codexIsolation: this.#codexIsolation } : {}),
    });
    const safeMeta = Object.freeze({ role: request.role, phase: request.phase, provider: request.model.providerId, model: request.model.modelId, quotaPool: request.model.quotaPool });
    this.#event("shadow.provider.started", safeMeta);
    try {
      const result = await this.#executor.run({ project: this.#project, plan, ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }) });
      if (!result.spawned || result.timedOut || result.exitCode !== 0) {
        this.#event("shadow.provider.failed", { ...safeMeta, timedOut: result.timedOut, exitCode: result.exitCode, error: redactSecrets(result.stderr).slice(0, 500) });
        const reason = providerFailureReason(request.model.providerId, result.stdout, result.stderr);
        throw new BrainGateInvariantError(
          "SHADOW_PROVIDER_FAILED",
          `Shadow provider ${request.model.providerId}/${request.model.modelId} failed with exit ${result.exitCode ?? "none"}${result.timedOut ? " (timeout/output cap)" : ""}.${reason === null ? "" : ` The provider reported: ${reason}.`}${failureAdvice(reason)}`,
        );
      }
      const response = parseRoleResponse(request.role, snapshot.providerId, result.stdout);
      this.#event("shadow.provider.completed", { ...safeMeta, durationMs: result.durationMs });
      this.#usage(request, result.durationMs);
      return response;
    } catch (error) {
      if (!(error instanceof BrainGateInvariantError && error.code === "SHADOW_PROVIDER_FAILED")) {
        this.#event("shadow.provider.failed", { ...safeMeta, error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500) });
      }
      throw error;
    }
  }

  #event(kind: string, payload: unknown): void {
    if (this.#ledger !== null && this.#taskId !== null) this.#ledger.appendEvent(this.#taskId, kind, payload);
  }

  #usage(request: AgentRequest, durationMs: number): void {
    if (this.#ledger === null || this.#taskId === null) return;
    this.#ledger.recordUsage({ taskId: this.#taskId, provider: request.model.providerId, model: request.model.modelId, evidence: "measured", metric: "provider_call", value: 1, unit: "call" });
    this.#ledger.recordUsage({ taskId: this.#taskId, provider: request.model.providerId, model: request.model.modelId, evidence: "measured", metric: "duration_ms", value: durationMs, unit: "ms" });
    this.#ledger.recordUsage({ taskId: this.#taskId, provider: request.model.providerId, model: request.model.modelId, evidence: "unknown", metric: "provider_tokens", value: null, unit: "tokens" });
  }
}
