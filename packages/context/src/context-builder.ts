import { createHash } from "node:crypto";
import {
  BrainGateInvariantError,
  assertRegisteredProject,
  type RegisteredProject,
} from "@braingate/core";
import { ProjectMemory } from "@braingate/memory";

export type ContextCandidateKind = "code" | "task_history" | "instruction";
export type ContextItemKind = "task" | "memory" | ContextCandidateKind;

export interface ContextCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly kind: ContextCandidateKind;
  readonly content: string;
  readonly source: string;
  readonly reason: string;
  readonly priority: number;
  readonly relevance: number;
}

export interface ContextItem {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly content: string;
  readonly source: string;
  readonly reason: string;
  readonly estimatedTokens: number;
  readonly characters: number;
  readonly truncated: boolean;
}

export interface SkippedContextItem {
  readonly id: string;
  readonly source: string;
  readonly reason: "duplicate" | "budget" | "item-limit";
}

export interface ContextPack {
  readonly projectId: string;
  readonly task: string;
  readonly memoryQuery: string;
  readonly items: readonly ContextItem[];
  readonly skipped: readonly SkippedContextItem[];
  readonly budget: {
    readonly maxTokens: number;
    readonly hardCharacterLimit: number;
    readonly usedCharacters: number;
    readonly estimatedTokens: number;
  };
}

function codePoints(value: string): readonly string[] {
  return Array.from(value);
}

export function conservativeTokenEstimate(value: string): number {
  return Math.ceil(codePoints(value).length / 2);
}

function charLength(value: string): number {
  return codePoints(value).length;
}

function truncateForBudget(value: string, maxChars: number): { content: string; truncated: boolean } {
  const points = codePoints(value);
  if (points.length <= maxChars) return { content: value, truncated: false };
  const marker = "\n…[truncated by BrainGate context budget]";
  const markerLength = charLength(marker);
  if (maxChars <= markerLength) return { content: points.slice(0, Math.max(0, maxChars)).join(""), truncated: true };
  return { content: `${points.slice(0, maxChars - markerLength).join("")}${marker}`, truncated: true };
}

function candidateKey(kind: ContextItemKind, source: string, content: string): string {
  return createHash("sha256").update(kind).update("\0").update(source).update("\0").update(content).digest("hex");
}

function validateCandidate(candidate: ContextCandidate, projectId: string): void {
  if (candidate.projectId !== projectId) {
    throw new BrainGateInvariantError(
      "CONTEXT_PROJECT_MISMATCH",
      `Context candidate ${candidate.id} belongs to ${candidate.projectId}, not ${projectId}.`,
    );
  }
  if (candidate.id.trim().length === 0 || candidate.content.trim().length === 0 || candidate.source.trim().length === 0) {
    throw new BrainGateInvariantError("CONTEXT_CANDIDATE_INVALID", "Context candidates require id, content, and source.");
  }
  if (!Number.isFinite(candidate.priority) || candidate.priority < 0 || candidate.priority > 100) {
    throw new BrainGateInvariantError("CONTEXT_PRIORITY_INVALID", "Context candidate priority must be between 0 and 100.");
  }
  if (!Number.isFinite(candidate.relevance) || candidate.relevance < 0 || candidate.relevance > 1) {
    throw new BrainGateInvariantError("CONTEXT_RELEVANCE_INVALID", "Context candidate relevance must be between 0 and 1.");
  }
}

export class ContextBuilder {
  readonly #project: RegisteredProject;
  readonly #memory: ProjectMemory;

  constructor(project: RegisteredProject, memory: ProjectMemory) {
    assertRegisteredProject(project);
    if (memory.projectId !== project.projectId) {
      throw new BrainGateInvariantError("CONTEXT_MEMORY_PROJECT_MISMATCH", "ContextBuilder memory must belong to the same registered project.");
    }
    this.#project = project;
    this.#memory = memory;
  }

  build(input: {
    task: string;
    query?: string;
    candidates?: readonly ContextCandidate[];
    maxTokens: number;
    memoryLimit?: number;
    maxItems?: number;
  }): ContextPack {
    const task = input.task.trim();
    if (task.length === 0) throw new BrainGateInvariantError("CONTEXT_TASK_INVALID", "Context task must be non-empty.");
    if (!Number.isInteger(input.maxTokens) || input.maxTokens < 64 || input.maxTokens > 500_000) {
      throw new BrainGateInvariantError("CONTEXT_BUDGET_INVALID", "maxTokens must be an integer between 64 and 500000.");
    }
    const memoryLimit = Math.max(0, Math.min(8, Math.floor(input.memoryLimit ?? 6)));
    const maxItems = Math.max(1, Math.min(20, Math.floor(input.maxItems ?? 12)));
    const memoryQuery = (input.query ?? task).trim();
    const provided = input.candidates ?? [];
    for (const candidate of provided) validateCandidate(candidate, this.#project.projectId);

    const memoryHits = memoryLimit === 0 ? [] : this.#memory.search(memoryQuery, { limit: memoryLimit });
    const candidates: Array<ContextCandidate & { sourceKind: ContextItemKind }> = [];
    memoryHits.forEach((hit, index) => {
      candidates.push({
        id: `memory:${hit.record.recordId}`,
        projectId: this.#project.projectId,
        kind: "instruction",
        sourceKind: "memory",
        content: hit.record.body,
        source: hit.record.sourceRefs[0] ?? `memory:${hit.record.recordId}`,
        reason: `canonical ${hit.record.kind}`,
        priority: 80,
        relevance: Math.max(0, 1 - index / Math.max(1, memoryHits.length + 1)),
      });
    });
    for (const candidate of provided) candidates.push({ ...candidate, sourceKind: candidate.kind });

    candidates.sort((a, b) =>
      b.priority - a.priority || b.relevance - a.relevance || a.id.localeCompare(b.id),
    );

    const items: ContextItem[] = [];
    const skipped: SkippedContextItem[] = [];
    const seen = new Set<string>();
    let usedTokens = 0;
    let usedCharacters = 0;

    const addItem = (item: { id: string; kind: ContextItemKind; content: string; source: string; reason: string }): boolean => {
      if (items.length >= maxItems) {
        skipped.push({ id: item.id, source: item.source, reason: "item-limit" });
        return false;
      }
      const key = candidateKey(item.kind, item.source, item.content);
      if (seen.has(key)) {
        skipped.push({ id: item.id, source: item.source, reason: "duplicate" });
        return false;
      }
      seen.add(key);
      const remainingTokens = input.maxTokens - usedTokens;
      if (remainingTokens <= 0) {
        skipped.push({ id: item.id, source: item.source, reason: "budget" });
        return false;
      }

      // The task may use the full remaining budget. Every other item is capped at
      // half the total pack budget so one giant file cannot crowd out all other evidence.
      const perItemTokenCap = item.kind === "task"
        ? remainingTokens
        : Math.min(remainingTokens, Math.max(32, Math.floor(input.maxTokens / 2)));
      const maxChars = perItemTokenCap * 2;
      const bounded = truncateForBudget(item.content, maxChars);
      const estimatedTokens = conservativeTokenEstimate(bounded.content);
      if (estimatedTokens > remainingTokens || bounded.content.length === 0) {
        skipped.push({ id: item.id, source: item.source, reason: "budget" });
        return false;
      }
      const characters = charLength(bounded.content);
      items.push({ ...item, content: bounded.content, estimatedTokens, characters, truncated: bounded.truncated });
      usedTokens += estimatedTokens;
      usedCharacters += characters;
      return true;
    };

    addItem({ id: "task", kind: "task", content: task, source: "user-task", reason: "primary task statement" });
    for (const candidate of candidates) {
      addItem({
        id: candidate.id,
        kind: candidate.sourceKind,
        content: candidate.content,
        source: candidate.source,
        reason: candidate.reason,
      });
    }

    return Object.freeze({
      projectId: this.#project.projectId,
      task,
      memoryQuery,
      items: Object.freeze(items),
      skipped: Object.freeze(skipped),
      budget: Object.freeze({
        maxTokens: input.maxTokens,
        hardCharacterLimit: input.maxTokens * 2,
        usedCharacters,
        estimatedTokens: usedTokens,
      }),
    });
  }
}
