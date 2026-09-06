import { BrainGateInvariantError, type RegisteredProject, type TaskLedger } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import { redactSecrets } from "@braingate/security";
import type { AgentInvoker, AgentRequest, AgentResponse } from "@braingate/workflows";
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

function unwrapProviderOutput(providerId: ProviderId, stdout: string): string {
  const trimmed = stdout.trim();
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

export class SubscriptionShadowAgentInvoker implements AgentInvoker {
  readonly #project: RegisteredProject;
  readonly #cwd: string;
  readonly #snapshots: ReadonlyMap<string, ProviderSnapshot>;
  readonly #attestations: ReadonlyMap<string, SubscriptionAttestation>;
  readonly #context: unknown;
  readonly #executor: ShadowProcessExecutor;
  readonly #ledger: TaskLedger | null;
  readonly #taskId: string | null;

  constructor(input: {
    readonly project: RegisteredProject;
    readonly cwd: string;
    readonly snapshots: readonly ProviderSnapshot[];
    readonly attestations?: readonly SubscriptionAttestation[];
    readonly context: unknown;
    readonly executor?: ShadowProcessExecutor;
    readonly ledger?: TaskLedger;
    readonly taskId?: string;
  }) {
    this.#project = input.project;
    this.#cwd = input.cwd;
    this.#snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.providerId, snapshot]));
    this.#attestations = new Map((input.attestations ?? []).map((attestation) => [attestation.providerId, attestation]));
    this.#context = input.context;
    this.#executor = input.executor ?? new NodeShadowProcessExecutor();
    this.#ledger = input.ledger ?? null;
    this.#taskId = input.taskId ?? null;
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
      context: this.#context,
      responseContract: responseContract(request.role),
    });
    const plan = planShadowInvocation({
      snapshot,
      model: request.model,
      cwd: this.#cwd,
      payload,
      attestation: this.#attestations.get(request.model.providerId),
    });
    const safeMeta = Object.freeze({ role: request.role, phase: request.phase, provider: request.model.providerId, model: request.model.modelId, quotaPool: request.model.quotaPool });
    this.#event("shadow.provider.started", safeMeta);
    try {
      const result = await this.#executor.run({ project: this.#project, plan });
      if (!result.spawned || result.timedOut || result.exitCode !== 0) {
        this.#event("shadow.provider.failed", { ...safeMeta, timedOut: result.timedOut, exitCode: result.exitCode, error: redactSecrets(result.stderr).slice(0, 500) });
        throw new BrainGateInvariantError("SHADOW_PROVIDER_FAILED", `Shadow provider ${request.model.providerId}/${request.model.modelId} failed with exit ${result.exitCode ?? "none"}${result.timedOut ? " (timeout/output cap)" : ""}.`);
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
