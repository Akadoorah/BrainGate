import type { MemoryKind } from "./types.js";

export const DEFAULT_MEMORY_TTL_DAYS: Readonly<Record<MemoryKind, number | null>> = Object.freeze({
  architecture_decision: null,
  business_rule: null,
  verified_fact: 180,
  task_summary: 90,
  known_bug: 90,
  incident: 365,
  code_reference: 90,
  temporary_observation: 30,
});

export function defaultMemoryTtlDays(kind: MemoryKind): number | null {
  return DEFAULT_MEMORY_TTL_DAYS[kind];
}
