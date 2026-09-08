import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";

/**
 * Collects artifacts a provider generated into the task worktree (ADR 0007).
 *
 * Codex writes generated images into its own home, outside the worktree, outside the
 * repository, and outside every boundary BrainGate enforces. Left there they would be files
 * nobody registered, in a directory no receipt mentions, outliving the task that made them.
 *
 * So they are collected rather than trusted: the provider declares paths, and only those are
 * copied in, each one verified by content before it lands. Anything else it produced stays
 * where it is and never enters the repository.
 */

/** Magic bytes, because an extension is a claim by the producer and a signature is evidence. */
const MEDIA_SIGNATURES: readonly { readonly mediaType: string; readonly extension: string; readonly magic: readonly number[] }[] = Object.freeze([
  { mediaType: "image/png", extension: ".png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: "image/jpeg", extension: ".jpg", magic: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", extension: ".gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: "image/webp", extension: ".webp", magic: [0x52, 0x49, 0x46, 0x46] },
]);

export const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_TASK = 8;

export interface CollectedArtifact {
  /** Worktree-relative path, which is where a reviewer will see it in the diff. */
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArtifactDeclaration {
  /** Absolute path the provider reported writing to. */
  readonly sourcePath: string;
  /** Worktree-relative destination the task asked for. */
  readonly destination: string;
}

function detectMediaType(data: Buffer): string | null {
  for (const candidate of MEDIA_SIGNATURES) {
    if (data.length < candidate.magic.length) continue;
    if (candidate.magic.every((byte, index) => data[index] === byte)) return candidate.mediaType;
  }
  return null;
}

function insideWorktree(worktreePath: string, candidate: string): boolean {
  const rel = relative(worktreePath, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Copies declared artifacts into the worktree, or fails the task.
 *
 * Every rejection is an error rather than a skip. An artifact that was asked for and silently
 * did not arrive is the failure this collector exists to prevent: the task would report success
 * while the thing it was for is missing.
 */
export function collectArtifacts(input: {
  readonly worktreePath: string;
  readonly declarations: readonly ArtifactDeclaration[];
}): readonly CollectedArtifact[] {
  if (input.declarations.length === 0) return Object.freeze([]);
  if (input.declarations.length > MAX_ARTIFACTS_PER_TASK) {
    throw new BrainGateInvariantError("ARTIFACT_COUNT_EXCEEDED", `A task may collect at most ${String(MAX_ARTIFACTS_PER_TASK)} artifacts; ${String(input.declarations.length)} were declared.`);
  }
  const worktree = resolve(input.worktreePath);
  const collected: CollectedArtifact[] = [];
  const seen = new Set<string>();

  for (const declaration of input.declarations) {
    // The destination is chosen by the task, so it is the one an attacker-influenced response
    // could aim outside the worktree. Resolve first, then prove containment.
    const destination = resolve(worktree, declaration.destination);
    if (!insideWorktree(worktree, destination)) {
      throw new BrainGateInvariantError("ARTIFACT_DESTINATION_DENIED", `Artifact destination escapes the task worktree: ${declaration.destination}`);
    }
    if (seen.has(destination)) {
      throw new BrainGateInvariantError("ARTIFACT_DESTINATION_DUPLICATE", `Two artifacts claim the same destination: ${declaration.destination}`);
    }
    seen.add(destination);

    const source = resolve(declaration.sourcePath);
    if (!existsSync(source)) {
      throw new BrainGateInvariantError("ARTIFACT_MISSING", `The provider declared an artifact it did not produce: ${declaration.destination}`);
    }
    // A symlink would let the declared path stand in for a file elsewhere on the machine.
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new BrainGateInvariantError("ARTIFACT_NOT_A_FILE", `An artifact source must be a regular file: ${declaration.destination}`);
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new BrainGateInvariantError("ARTIFACT_TOO_LARGE", `Artifact exceeds the ${String(MAX_ARTIFACT_BYTES)} byte cap: ${declaration.destination}`);
    }

    const data = readFileSync(source);
    const mediaType = detectMediaType(data);
    if (mediaType === null) {
      throw new BrainGateInvariantError("ARTIFACT_MEDIA_TYPE_DENIED", `Artifact is not an allowed media type by content: ${declaration.destination}`);
    }

    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    collected.push(Object.freeze({
      path: relative(worktree, destination).split(sep).join("/"),
      mediaType,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    }));
  }

  return Object.freeze(collected);
}

const DECLARATION_MARKER = "BRAINGATE_ARTIFACTS";

/**
 * Extracts the JSON value that follows the marker, by matching brackets.
 *
 * A regular expression cannot do this: a lazy one stops at the first closing brace and truncates
 * every nested declaration, and a greedy one swallows whatever prose follows. Strings are
 * tracked so a bracket inside a filename does not end the scan early.
 */
function declarationBlock(reply: string): string | null {
  const marker = reply.indexOf(DECLARATION_MARKER);
  if (marker < 0) return null;
  let index = marker + DECLARATION_MARKER.length;
  while (index < reply.length && /\s/.test(reply[index]!)) index += 1;

  const open = reply[index];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = index; cursor < reply.length; cursor += 1) {
    const char = reply[cursor]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return reply.slice(index, cursor + 1);
    }
  }
  // Opened and never closed: unreadable, which is not the same as absent.
  throw new BrainGateInvariantError("ARTIFACT_DECLARATION_INVALID", "The provider's artifact declaration is not closed.");
}

/**
 * Reads artifact declarations out of a provider's reply.
 *
 * The provider is asked to end with a `BRAINGATE_ARTIFACTS` block naming what it produced and
 * where each file should land. Nothing is inferred from prose: a response with no block
 * declares no artifacts, and a malformed block is an error rather than an empty result, because
 * "produced nothing" and "said something unreadable" call for different responses.
 */
export function parseArtifactDeclarations(reply: string): readonly ArtifactDeclaration[] {
  const block = declarationBlock(reply);
  if (block === null) return Object.freeze([]);

  let parsed: unknown;
  try { parsed = JSON.parse(block); }
  catch { throw new BrainGateInvariantError("ARTIFACT_DECLARATION_INVALID", "The provider's artifact declaration is not valid JSON."); }

  const entries = Array.isArray(parsed) ? parsed : (parsed as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(entries)) {
    throw new BrainGateInvariantError("ARTIFACT_DECLARATION_INVALID", "The provider's artifact declaration is not a list.");
  }

  return Object.freeze(entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    const sourcePath = record.sourcePath;
    const destination = record.destination;
    if (typeof sourcePath !== "string" || sourcePath.trim().length === 0 || typeof destination !== "string" || destination.trim().length === 0) {
      throw new BrainGateInvariantError("ARTIFACT_DECLARATION_INVALID", "Each artifact must declare a sourcePath and a destination.");
    }
    return Object.freeze({ sourcePath: sourcePath.trim(), destination: destination.trim() });
  }));
}

/** Where a collected artifact sits relative to the repository, for the receipt. */
export function artifactWorktreePath(worktreePath: string, artifact: CollectedArtifact): string {
  return join(worktreePath, artifact.path);
}
