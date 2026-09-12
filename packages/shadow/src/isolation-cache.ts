import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProviderId } from "@braingate/providers";
import { CODEX_GENERATED_IMAGES, resolveCodexHome } from "./codex-isolation.js";
import { resolveGrokHome } from "./grok-isolation.js";

/**
 * Remembers an isolation self-test, without letting it become something it is not.
 *
 * The self-tests are cheap in tokens and not in time: proving Grok's sandbox spawns the CLI, and
 * proving Codex's spawns it several times. Running both on every command spent seconds on a
 * question they had already answered a moment earlier — and an attestation is, by its own
 * design, a statement with a lifetime. Re-deriving it every few seconds does not make it truer.
 *
 * What makes this safe is what it does *not* do.
 *
 * **It does not extend validity.** The attestation is re-validated on read against the live
 * provider snapshot by the same function that validated it when it was earned, so a CLI that has
 * been updated, a policy whose hash has moved, or an entry past its own expiry is a miss.
 *
 * **It does not skip the cheap checks.** The expensive part of a self-test is spawning the
 * provider; the part that goes stale fastest is the operator's own configuration — a sandbox
 * profile that now shadows BrainGate's, an MCP server added since. Those are a few file reads,
 * so they are re-read every time and folded into the key. A cached proof is only returned for a
 * machine that still looks the way it did when the proof was earned.
 *
 * **It does not last as long as the attestation would allow.** An attestation is good for a day;
 * this reuses one for far less. The gap is deliberate: the file sits in the operator's own home,
 * and anyone able to forge an entry there could also edit the provider configuration the entry
 * describes, so the honest limit on this is time rather than cryptography.
 */

const SCHEMA_VERSION = 1;
const DEFAULT_REUSE_MS = 30 * 60 * 1000;

export interface CachedAttestation<T> {
  readonly providerId: ProviderId;
  readonly fingerprint: string;
  readonly storedAt: string;
  readonly attestation: T;
}

interface CacheDocument {
  readonly schemaVersion: 1;
  readonly entries: readonly CachedAttestation<unknown>[];
}

function fileDigest(paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    try {
      const stats = statSync(path);
      // Content for the small declarative files that decide policy; size and mtime for anything
      // else, because reading a binary on every command would cost more than it protects.
      hash.update(String(stats.size));
      hash.update(String(Math.floor(stats.mtimeMs)));
      if (stats.isFile() && stats.size <= 256 * 1024) hash.update(readFileSync(path));
    } catch { hash.update("absent"); }
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * What would have to be re-measured if it changed.
 *
 * Grok resolves a same-named sandbox profile from the operator's own file in preference to
 * BrainGate's, and loads MCP servers, hooks and plugins from the home that also holds its
 * credentials. None of that is visible in a version string, so all of it is in the key.
 */
export function grokIsolationFingerprint(env: NodeJS.ProcessEnv, binary: string): string {
  const home = resolveGrokHome(env);
  return fileDigest([binary, join(home, "config.toml"), join(home, "sandbox.toml"), join(home, "hooks-paths"), join(home, "hooks")]);
}

/** The same idea for Codex: the home that supplies its configuration and its credentials. */
export function codexIsolationFingerprint(env: NodeJS.ProcessEnv, binary: string): string {
  const home = resolveCodexHome(env);
  return fileDigest([binary, join(home, "config.toml"), join(home, CODEX_GENERATED_IMAGES)]);
}

export class IsolationAttestationCache {
  readonly path: string;
  readonly #reuseMs: number;
  readonly #now: () => number;

  constructor(options: { readonly path: string; readonly reuseMs?: number; readonly now?: () => number }) {
    this.path = resolve(options.path);
    this.#reuseMs = Math.max(0, Math.min(options.reuseMs ?? DEFAULT_REUSE_MS, DEFAULT_REUSE_MS));
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * A stored attestation for this provider and this machine state, or null.
   *
   * The caller re-validates what comes back: this returns a candidate, never a verdict.
   */
  read<T>(providerId: ProviderId, fingerprint: string): T | null {
    let document: CacheDocument;
    try { document = this.#parse(readFileSync(this.path, "utf8")); }
    catch { return null; }
    // Selected by provider *and* fingerprint, because one provider can now hold more than one proof:
    // a staged role and a snapshot-primary run execute different policies from different homes, and
    // the fingerprint is what distinguishes them. Matching on the provider alone would hand back
    // whichever posture happened to be written last.
    const entry = document.entries.find((candidate) => candidate.providerId === providerId && candidate.fingerprint === fingerprint);
    if (entry === undefined) return null;
    const storedAt = new Date(entry.storedAt).getTime();
    if (Number.isNaN(storedAt)) return null;
    // A clock that moved backwards, or an entry stamped ahead of now, is not reusable.
    const age = this.#now() - storedAt;
    if (age < 0 || age > this.#reuseMs) return null;
    return entry.attestation as T;
  }

  write<T>(providerId: ProviderId, fingerprint: string, attestation: T): void {
    try {
      let existing: readonly CachedAttestation<unknown>[] = [];
      try { existing = this.#parse(readFileSync(this.path, "utf8")).entries; } catch { /* start fresh */ }
      const entries = [
        // Replaced by (provider, fingerprint): a new proof for one posture leaves the other intact.
        ...existing.filter((entry) => !(entry.providerId === providerId && entry.fingerprint === fingerprint)),
        { providerId, fingerprint, storedAt: new Date(this.#now()).toISOString(), attestation },
      ];
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, this.path);
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { force: true });
      }
    } catch { /* a proof that cannot be remembered is simply re-earned */ }
  }

  /** Forgets every stored proof, so the next command measures again. */
  clear(): void {
    try { rmSync(this.path, { force: true }); } catch { /* nothing to forget */ }
  }

  #parse(raw: string): CacheDocument {
    const value = JSON.parse(raw) as CacheDocument;
    if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.entries)) throw new Error("unrecognised cache document");
    return {
      schemaVersion: 1,
      entries: value.entries.filter((entry) =>
        typeof entry?.providerId === "string"
        && typeof entry.fingerprint === "string"
        && typeof entry.storedAt === "string"
        && typeof entry.attestation === "object" && entry.attestation !== null),
    };
  }
}
