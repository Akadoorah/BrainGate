import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import { ProjectMemory } from "./memory-store.js";
import type { MemoryKind, MemoryProposal } from "./types.js";

export type MemoryImportFormat = "auto" | "text" | "jsonl" | "chatgpt";

export interface MemoryImportCandidate {
  readonly candidateId: string;
  readonly index: number;
  readonly kind: MemoryKind;
  readonly body: string;
  readonly reason: string;
  readonly sourceRefs: readonly string[];
  readonly confidenceHint: number;
  readonly duplicateRecordId: string | null;
}

export interface MemoryImportPreview {
  readonly projectId: string;
  readonly sourceName: string;
  readonly sourceDigest: string;
  readonly format: Exclude<MemoryImportFormat, "auto">;
  readonly candidates: readonly MemoryImportCandidate[];
  readonly duplicates: number;
  readonly rawTranscriptPersisted: false;
}

const MEMORY_KINDS = new Set<MemoryKind>([
  "architecture_decision",
  "business_rule",
  "verified_fact",
  "task_summary",
  "known_bug",
  "incident",
  "code_reference",
  "temporary_observation",
]);

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_CANDIDATES = 100;
const MAX_CANDIDATE_CHARS = 4_000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeBody(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function clip(value: string, max = MAX_CANDIDATE_CHARS): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function inferKind(value: string): MemoryKind {
  const head = value.slice(0, 240).toLocaleLowerCase();
  if (/\b(?:adr|architecture decision|قرار معماري)\b/.test(head)) return "architecture_decision";
  if (/\b(?:business rule|قاعدة عمل|قاعدة تجارية)\b/.test(head)) return "business_rule";
  if (/\b(?:known bug|bug|خلل معروف|مشكلة معروفة)\b/.test(head)) return "known_bug";
  if (/\b(?:incident|outage|حادث|انقطاع)\b/.test(head)) return "incident";
  if (/\b(?:code reference|file|symbol|مرجع كود)\b/.test(head)) return "code_reference";
  if (/\b(?:task summary|summary|ملخص مهمة|ملخص)\b/.test(head)) return "task_summary";
  if (/\b(?:verified fact|fact|حقيقة مؤكدة)\b/.test(head)) return "verified_fact";
  return "temporary_observation";
}

function textSections(raw: string): readonly { body: string; kind: MemoryKind; reason: string }[] {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];
  const blocks = normalized
    .split(/\n(?=#{1,6}\s)|\n{2,}/g)
    .map((part) => clip(part))
    .filter((part) => part.length >= 12);
  return blocks.map((body) => ({
    body,
    kind: inferKind(body),
    reason: "Imported from a local historical note/export; requires project-level verification before becoming canonical.",
  }));
}

function jsonlSections(raw: string): readonly { body: string; kind: MemoryKind; reason: string }[] {
  const results: { body: string; kind: MemoryKind; reason: string }[] = [];
  for (const [lineIndex, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; }
    catch { throw new BrainGateInvariantError("MEMORY_IMPORT_JSONL_INVALID", `Invalid JSONL at line ${lineIndex + 1}.`); }
    if (typeof parsed !== "object" || parsed === null) continue;
    const row = parsed as Record<string, unknown>;
    const content = typeof row.body === "string" ? row.body : typeof row.content === "string" ? row.content : null;
    if (content === null || normalizeBody(content).length < 12) continue;
    const requestedKind = typeof row.kind === "string" && MEMORY_KINDS.has(row.kind as MemoryKind)
      ? row.kind as MemoryKind
      : inferKind(content);
    results.push({
      body: clip(content),
      kind: requestedKind,
      reason: typeof row.reason === "string" && row.reason.trim().length > 0
        ? clip(row.reason, 1_000)
        : "Imported from normalized JSONL; requires project-level verification before becoming canonical.",
    });
  }
  return results;
}

function messageText(message: unknown): { role: string; text: string } | null {
  if (typeof message !== "object" || message === null) return null;
  const value = message as Record<string, unknown>;
  const author = value.author;
  const role = typeof author === "object" && author !== null && typeof (author as Record<string, unknown>).role === "string"
    ? String((author as Record<string, unknown>).role)
    : "unknown";
  const content = value.content;
  if (typeof content !== "object" || content === null) return null;
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((part): part is string => typeof part === "string").join("\n").trim();
  return text.length === 0 ? null : { role, text };
}

function chatGptSections(raw: string): readonly { body: string; kind: MemoryKind; reason: string }[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { throw new BrainGateInvariantError("MEMORY_IMPORT_CHATGPT_INVALID", "ChatGPT export is not valid JSON."); }
  if (!Array.isArray(parsed)) throw new BrainGateInvariantError("MEMORY_IMPORT_CHATGPT_INVALID", "Expected a ChatGPT-style conversations array.");
  const results: { body: string; kind: MemoryKind; reason: string }[] = [];
  for (const conversation of parsed) {
    if (typeof conversation !== "object" || conversation === null) continue;
    const row = conversation as Record<string, unknown>;
    const title = typeof row.title === "string" && row.title.trim().length > 0 ? row.title.trim() : "Untitled conversation";
    const mapping = row.mapping;
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) continue;
    const messages: { role: string; text: string }[] = [];
    for (const node of Object.values(mapping as Record<string, unknown>)) {
      if (typeof node !== "object" || node === null) continue;
      const extracted = messageText((node as Record<string, unknown>).message);
      if (extracted !== null) messages.push(extracted);
    }
    const users = messages.filter((item) => item.role === "user").slice(-3).map((item) => clip(item.text, 650));
    const assistant = [...messages].reverse().find((item) => item.role === "assistant");
    if (users.length === 0 && assistant === undefined) continue;
    const body = clip([
      `Historical conversation: ${title}`,
      users.length > 0 ? `Recent user context:\n${users.map((item) => `- ${item}`).join("\n")}` : "",
      assistant === undefined ? "" : `Last assistant conclusion:\n${clip(assistant.text, 1_000)}`,
    ].filter(Boolean).join("\n\n"));
    results.push({
      body,
      kind: "temporary_observation",
      reason: "Compact historical conversation extract. It is not canonical until explicitly verified and promoted.",
    });
  }
  return results;
}

function detectFormat(sourcePath: string, raw: string, requested: MemoryImportFormat): Exclude<MemoryImportFormat, "auto"> {
  if (requested !== "auto") return requested;
  const name = basename(sourcePath).toLocaleLowerCase();
  if (name === "conversations.json") return "chatgpt";
  if (name.endsWith(".jsonl")) return "jsonl";
  if (name.endsWith(".json")) {
    try { if (Array.isArray(JSON.parse(raw))) return "chatgpt"; } catch { /* text fallback */ }
  }
  return "text";
}

function duplicateId(memory: ProjectMemory, body: string): string | null {
  const normalized = normalizeBody(body).toLocaleLowerCase();
  for (const hit of memory.search(body, { limit: 20 })) {
    if (normalizeBody(hit.record.body).toLocaleLowerCase() === normalized) return hit.record.recordId;
  }
  return null;
}

export function previewMemoryImport(
  memory: ProjectMemory,
  input: { readonly sourcePath: string; readonly format?: MemoryImportFormat; readonly maxCandidates?: number },
): MemoryImportPreview {
  const sourcePath = resolve(input.sourcePath);
  const raw = readFileSync(sourcePath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_SOURCE_BYTES) {
    throw new BrainGateInvariantError("MEMORY_IMPORT_TOO_LARGE", `Memory import source exceeds ${MAX_SOURCE_BYTES} bytes.`);
  }
  const sourceDigest = digest(raw);
  const format = detectFormat(sourcePath, raw, input.format ?? "auto");
  const sections = format === "chatgpt" ? chatGptSections(raw) : format === "jsonl" ? jsonlSections(raw) : textSections(raw);
  const limit = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(input.maxCandidates ?? MAX_CANDIDATES)));
  const candidates = sections.slice(0, limit).map((section, index) => {
    const body = clip(section.body);
    const duplicateRecordId = duplicateId(memory, body);
    return Object.freeze({
      candidateId: digest(`${memory.projectId}\u0000${sourceDigest}\u0000${index}\u0000${normalizeBody(body)}`).slice(0, 24),
      index,
      kind: section.kind,
      body,
      reason: section.reason,
      sourceRefs: Object.freeze([`import:${sourceDigest.slice(0, 16)}:segment:${index + 1}`]),
      confidenceHint: format === "jsonl" ? 0.7 : format === "text" ? 0.55 : 0.4,
      duplicateRecordId,
    } satisfies MemoryImportCandidate);
  });
  return Object.freeze({
    projectId: memory.projectId,
    sourceName: basename(sourcePath),
    sourceDigest,
    format,
    candidates: Object.freeze(candidates),
    duplicates: candidates.filter((candidate) => candidate.duplicateRecordId !== null).length,
    rawTranscriptPersisted: false,
  });
}

export function importMemoryPreview(
  memory: ProjectMemory,
  preview: MemoryImportPreview,
  input: { readonly selectedIndexes?: readonly number[]; readonly proposedBy?: string } = {},
): readonly MemoryProposal[] {
  if (preview.projectId !== memory.projectId) {
    throw new BrainGateInvariantError("MEMORY_IMPORT_PROJECT_MISMATCH", "Memory import preview belongs to a different project.");
  }
  const selected = input.selectedIndexes === undefined ? null : new Set(input.selectedIndexes);
  const proposals: MemoryProposal[] = [];
  for (const candidate of preview.candidates) {
    if (selected !== null && !selected.has(candidate.index)) continue;
    if (candidate.duplicateRecordId !== null) continue;
    proposals.push(memory.propose({
      kind: candidate.kind,
      body: candidate.body,
      reason: candidate.reason,
      sourceRefs: candidate.sourceRefs,
      proposedBy: input.proposedBy ?? "memory-bootstrap",
    }));
  }
  return Object.freeze(proposals);
}
