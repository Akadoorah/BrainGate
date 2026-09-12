/**
 * Who actually did the work, distinguished from who was merely routed.
 *
 * The real run that prompted this proved the gap: a Google planner executed, its native usage was
 * recorded, and it appeared in none of the attribution surfaces — because the brief is written before
 * the run (so it can only hold the plan) and the workflow's own receipt never existed, since the task
 * failed before the workflow returned one. The permanent record therefore said a task with two
 * provider calls had one role.
 *
 * The ledger is the source that cannot be wrong about this: every dispatch writes a
 * `shadow.provider.started` event before it runs, and a completion or failure after it. Reading those
 * back gives the executed attribution directly, and the plan supplies the difference — roles that were
 * routed and never dispatched. Three states, never conflated:
 *
 * - `planned` — routed, no provider call started.
 * - `attempted` — a call started and did not complete.
 * - `completed` — the provider answered.
 */
import { isObservationRoleName, observationWorkspaceMode, type ObservationRole, type ObservationRoleName, type ObservationWorkspaceMode } from "./finalization.js";
import type { TaskEvent } from "./task-ledger.js";

export interface RoleAttributionInput {
  /** The task's own events, in order. */
  readonly events: readonly TaskEvent[];
  /** Roles that were routed, whether or not they were dispatched. */
  readonly planned?: readonly ObservationRole[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function payloadOf(event: TaskEvent): Record<string, unknown> | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  return payload as Record<string, unknown>;
}

/**
 * The attribution a task's own provider events describe, with planned-only roles added.
 *
 * A role that produced several attempts — because a quota refusal was failed over — appears once per
 * provider/model that was actually dispatched, in the order the attempts happened. That is the point:
 * "the primary ran on Anthropic and was refused, then ran on nobody" is a different record from "the
 * primary ran on Anthropic".
 */
export function executionAttribution(input: RoleAttributionInput): readonly ObservationRole[] {
  const entries: { role: ObservationRoleName; providerId: string; modelId: string; status: "attempted" | "completed"; phases: string[]; workspaceMode: ObservationWorkspaceMode | null; key: string }[] = [];
  const byKey = new Map<string, (typeof entries)[number]>();

  for (const event of input.events) {
    if (event.kind !== "shadow.provider.started" && event.kind !== "shadow.provider.completed" && event.kind !== "shadow.provider.failed") continue;
    const payload = payloadOf(event);
    if (payload === null) continue;
    const role = payload.role;
    const providerId = text(payload.provider);
    const modelId = text(payload.model);
    if (!isObservationRoleName(role) || providerId === null || modelId === null) continue;
    const phase = text(payload.phase);
    // One entry per (role, model): a second attempt on a *different* model is a separate line, while
    // phases of the same model (initial, repair-1) stay together.
    const key = `${role}\u0000${providerId}\u0000${modelId}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { role, providerId, modelId, status: "attempted", phases: [], workspaceMode: null, key };
      byKey.set(key, entry);
      entries.push(entry);
    }
    if (phase !== null && !entry.phases.includes(phase)) entry.phases.push(phase);
    // The mode travels on the event itself, so the record says where the provider was pointed rather
    // than re-deriving it later from what was planned — a failover changes it mid-task.
    const workspaceMode = observationWorkspaceMode(payload.workspaceMode);
    if (workspaceMode !== null) entry.workspaceMode = workspaceMode;
    if (event.kind === "shadow.provider.completed") entry.status = "completed";
  }

  const attribution: ObservationRole[] = entries.map((entry) => Object.freeze({
    role: entry.role,
    providerId: entry.providerId,
    modelId: entry.modelId,
    status: entry.status,
    ...(entry.workspaceMode === null ? {} : { workspaceMode: entry.workspaceMode }),
  }));
  const seen = new Set(entries.map((entry) => entry.role));
  for (const planned of input.planned ?? []) {
    if (seen.has(planned.role)) continue;
    seen.add(planned.role);
    attribution.push(Object.freeze({ role: planned.role, providerId: planned.providerId, modelId: planned.modelId, status: "planned" as const }));
  }
  return Object.freeze(attribution);
}

/** The append-only record of that attribution, written once the run is over. */
export interface TaskExecutionRecord {
  readonly schemaVersion: 1;
  readonly roles: readonly ObservationRole[];
}

export function executionRecord(roles: readonly ObservationRole[]): TaskExecutionRecord {
  return Object.freeze({ schemaVersion: 1 as const, roles: Object.freeze([...roles]) });
}

/** The recorded attribution for a task, if one was written; otherwise derived from its provider events. */
export function recordedExecutionAttribution(events: readonly TaskEvent[]): readonly ObservationRole[] | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== "task.execution") continue;
    const payload = payloadOf(event);
    const roles = payload?.roles;
    if (!Array.isArray(roles)) continue;
    const parsed: ObservationRole[] = [];
    for (const role of roles) {
      if (typeof role !== "object" || role === null) continue;
      const record = role as Record<string, unknown>;
      const name = record.role;
      const providerId = text(record.providerId);
      const modelId = text(record.modelId);
      if (!isObservationRoleName(name) || providerId === null || modelId === null) continue;
      const status = record.status === "completed" || record.status === "attempted" || record.status === "planned" ? record.status : "planned";
      parsed.push(Object.freeze({ role: name, providerId, modelId, status }));
    }
    return Object.freeze(parsed);
  }
  return null;
}
