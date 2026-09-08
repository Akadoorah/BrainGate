import { conservativeTokenEstimate } from "@braingate/context";
import type { RegisteredProject } from "@braingate/core";
import { ProjectMemory } from "@braingate/memory";

/**
 * Supplies canonical project memory to a task.
 *
 * The memory store was complete — proposals, evidence-gated promotion, expiry, full-text
 * search — but nothing consumed it: every task shipped a fixed context object and reported
 * `memoryRecords: 0` as a literal rather than a count. This is the missing consumer.
 *
 * Only canonical records are read. Proposals are not memory yet: they become canonical solely
 * through `memory promote`, which demands explicit evidence, and injecting them here would
 * route around that gate.
 */

/** What a task is told, and what the receipt records about it. */
export interface TaskMemory {
  readonly records: readonly { readonly kind: string; readonly body: string; readonly sourceRefs: readonly string[] }[];
  readonly recordCount: number;
  readonly estimatedTokens: number;
  readonly truncated: number;
}

export const EMPTY_TASK_MEMORY: TaskMemory = Object.freeze({ records: Object.freeze([]), recordCount: 0, estimatedTokens: 0, truncated: 0 });

/**
 * Retrieves the memory relevant to one task, within a token ceiling.
 *
 * The ceiling is a share of the task's own context budget rather than a constant, so a T0
 * lookup does not carry a T4 task's worth of history. Records are added in relevance order
 * until the next one would not fit, and what was left out is counted rather than hidden — an
 * omitted record must be visible in the receipt, not silently absent.
 *
 * Failure is never fatal. A task that could run without memory before must still run now, so a
 * store that cannot be opened yields no memory instead of an error.
 */
export function collectTaskMemory(project: RegisteredProject, task: string, contextTokenBudget: number): TaskMemory {
  const ceiling = Math.max(256, Math.floor(contextTokenBudget * 0.25));
  let memory: ProjectMemory;
  try { memory = new ProjectMemory(project); }
  catch { return EMPTY_TASK_MEMORY; }

  try {
    const hits = memory.search(task, { limit: 8 });
    const records: { kind: string; body: string; sourceRefs: readonly string[] }[] = [];
    let spent = 0;
    let truncated = 0;

    for (const hit of hits) {
      const entry = { kind: hit.record.kind, body: hit.record.body, sourceRefs: hit.record.sourceRefs };
      const cost = conservativeTokenEstimate(`${entry.kind}${entry.body}${entry.sourceRefs.join("")}`);
      if (spent + cost > ceiling) { truncated += 1; continue; }
      spent += cost;
      records.push(entry);
    }

    return Object.freeze({
      records: Object.freeze(records),
      recordCount: records.length,
      estimatedTokens: spent,
      truncated,
    });
  } catch {
    return EMPTY_TASK_MEMORY;
  } finally {
    try { memory.close(); } catch { /* closing a failed store is not a task failure */ }
  }
}
