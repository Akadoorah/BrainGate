import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BrainGateInvariantError } from "./errors.js";
import { assertRegisteredProject, type RegisteredProject } from "./project-registry.js";

/**
 * A task's result, kept as a file rather than as a row.
 *
 * The ledger is read whole: `TaskLedger.receipt()` selects every event for a task, and the
 * dashboard builds a card for every task, so an answer inlined into an event would make a
 * status read load every answer ever produced. A bounded file plus a small metadata record
 * keeps the ledger cheap and the evidence intact.
 *
 * Filenames are content-addressed — `<kind>.<sha256-of-stored-bytes>.<ext>` — which is what makes
 * a retry after a crash safe: the name states what the file must contain, so an existing file is
 * either the content we were about to write or a different content that legitimately gets a
 * different name. Nothing is ever overwritten.
 */

export const MAX_RESULT_BYTES = 512 * 1024;
const TRUNCATION_MARKER = "\n…[truncated by BrainGate result cap]";

export type ResultKind = "answer" | "diff";

export interface StoredResult {
  /** Relative to the project's storage directory, so it survives a moved home. */
  readonly relativePath: string;
  readonly kind: ResultKind;
  /** Hash of the stored bytes — the same value the filename carries. */
  readonly sha256: string;
  readonly bytes: number;
  /** Hash and size of the whole redacted text before any cap, so truncation is detectable. */
  readonly originalSha256: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
  readonly mediaType: string;
}

const NAME = /^(answer|diff)\.([0-9a-f]{64})\.(txt|diff)$/;

function extensionFor(kind: ResultKind): string {
  return kind === "diff" ? "diff" : "txt";
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Cuts on a code-point boundary so a truncated file is still valid UTF-8 text. */
function capBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  let used = 0;
  let kept = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > budget) break;
    kept += character;
    used += size;
  }
  return { text: `${kept}${TRUNCATION_MARKER}`, truncated: true };
}

export interface ResultStoreOptions {
  /**
   * Redaction is injected rather than imported: the security package owns the patterns, and a
   * result is the one place a secret in an answer would settle. Called before anything is hashed
   * or written.
   */
  readonly redact: (value: string) => string;
}

export class ResultStore {
  readonly #storageDir: string;
  readonly #redact: (value: string) => string;

  constructor(storageDir: string, options: ResultStoreOptions) {
    this.#storageDir = resolve(storageDir);
    this.#redact = options.redact;
  }

  static fromProject(project: RegisteredProject, options: ResultStoreOptions): ResultStore {
    assertRegisteredProject(project);
    return new ResultStore(project.storageDir, options);
  }

  absolutePath(relativePath: string): string {
    const resolved = resolve(this.#storageDir, relativePath);
    const rel = relative(this.#storageDir, resolved);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
      throw new BrainGateInvariantError("RESULT_PATH_ESCAPE", "A result path must stay inside the project's storage directory.");
    }
    return resolved;
  }


  #directory(taskId: string): string {
    return join(this.#storageDir, "results", taskId);
  }

  /** Writes the result, or verifies and reuses an identical one already on disk. */
  persist(taskId: string, input: { readonly kind: ResultKind; readonly text: string; readonly mediaType?: string }): StoredResult {
    const redacted = this.#redact(input.text);
    const originalSha256 = sha256(redacted);
    const originalBytes = Buffer.byteLength(redacted, "utf8");
    const capped = capBytes(redacted, MAX_RESULT_BYTES);
    const digest = sha256(capped.text);
    const relativePath = `results/${taskId}/${input.kind}.${digest}.${extensionFor(input.kind)}`;
    const absolute = this.absolutePath(relativePath);
    mkdirSync(this.#directory(taskId), { recursive: true, mode: 0o700 });

    if (existsSync(absolute)) {
      // The name is the expected content, so a retry after a crash lands here. Verify rather
      // than trust, then reuse: writing again would be an overwrite of evidence.
      const existing = sha256(readFileSync(absolute));
      if (existing !== digest) {
        throw new BrainGateInvariantError(
          "RESULT_CONTENT_CONFLICT",
          `The result file ${relativePath} does not match the content its name claims.`,
        );
      }
    } else {
      writeFileSync(absolute, capped.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }

    return Object.freeze({
      relativePath,
      kind: input.kind,
      sha256: digest,
      bytes: Buffer.byteLength(capped.text, "utf8"),
      originalSha256,
      originalBytes,
      truncated: capped.truncated,
      mediaType: input.mediaType ?? (input.kind === "diff" ? "text/x-diff" : "text/plain"),
    });
  }

  /**
   * Every artifact already present for one task, split into those whose content matches the hash
   * in their filename and those that do not.
   *
   * This is how a crash between writing the file and recording it is repaired without a marker:
   * the artifact is discoverable from the task's own directory, and it validates itself.
   */
  locate(taskId: string): { readonly valid: readonly StoredResult[]; readonly torn: readonly string[] } {
    const directory = this.#directory(taskId);
    if (!existsSync(directory)) return Object.freeze({ valid: Object.freeze([]), torn: Object.freeze([]) });
    const valid: StoredResult[] = [];
    const torn: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = NAME.exec(entry.name);
      if (match === null) continue;
      const relativePath = `results/${taskId}/${entry.name}`;
      const absolute = join(directory, entry.name);
      let bytes: Buffer;
      try { bytes = readFileSync(absolute); }
      catch { torn.push(relativePath); continue; }
      if (sha256(bytes) !== match[2]) { torn.push(relativePath); continue; }
      const kind = match[1] as ResultKind;
      valid.push(Object.freeze({
        relativePath,
        kind,
        sha256: match[2]!,
        bytes: bytes.byteLength,
        // A discovered artifact cannot know whether it was capped; its own content is all we have.
        originalSha256: match[2]!,
        originalBytes: bytes.byteLength,
        truncated: false,
        mediaType: kind === "diff" ? "text/x-diff" : "text/plain",
      }));
    }
    valid.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    torn.sort();
    return Object.freeze({ valid: Object.freeze(valid), torn: Object.freeze(torn) });
  }

  read(relativePath: string): string {
    const absolute = this.absolutePath(relativePath);
    if (!existsSync(absolute)) {
      throw new BrainGateInvariantError("RESULT_MISSING", `The recorded result file is not present: ${relativePath}`);
    }
    return readFileSync(absolute, "utf8");
  }

  exists(relativePath: string): boolean {
    return existsSync(this.absolutePath(relativePath));
  }

  /** Removes a torn artifact: it is a partial write, not a record. Callers must report it. */
  discard(relativePath: string): void {
    rmSync(this.absolutePath(relativePath), { force: true });
  }
}
