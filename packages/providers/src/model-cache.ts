import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

/**
 * Remembers which models a provider offers, so the slowest probe is not repeated every command.
 *
 * Listing models is the one part of discovery that leaves the machine: for one provider here it
 * is a two-and-a-half second network round trip, and it dominated what a `braingate` command
 * spent before asking anything. It is also the part that changes least — a provider's catalogue
 * moves on the scale of weeks, not seconds.
 *
 * Two things are deliberately not cached.
 *
 * **Authentication.** A cached "signed in" that outlives a sign-out is a lie that routes work to
 * a provider that will refuse it. Where a provider reports models and authentication through one
 * command, that command is measured every time and this cache stands aside — correctness is not
 * traded for a second.
 *
 * **Anything from a different build.** The entry is keyed by the CLI's own version string, so
 * updating a provider invalidates its cache without anyone remembering to clear it.
 */

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  readonly key: string;
  readonly models: readonly string[];
  readonly observedAt: string;
}

interface CacheDocument {
  readonly schemaVersion: 1;
  readonly entries: readonly CacheEntry[];
}

export function modelCacheKey(input: { readonly providerId: string; readonly version: string | null; readonly command: string }): string {
  return createHash("sha256").update(JSON.stringify([input.providerId, input.version ?? "unknown", input.command])).digest("hex").slice(0, 32);
}

function parse(raw: string): CacheDocument {
  const value = JSON.parse(raw) as CacheDocument;
  if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.entries)) throw new Error("unrecognised cache document");
  const entries = value.entries.filter((entry) =>
    typeof entry?.key === "string"
    && typeof entry.observedAt === "string"
    && Array.isArray(entry.models)
    && entry.models.every((model: unknown) => typeof model === "string"));
  return { schemaVersion: 1, entries };
}

export class ModelListCache {
  readonly path: string;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { readonly path: string; readonly ttlMs?: number; readonly now?: () => number }) {
    this.path = resolve(options.path);
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** The remembered list for this key, or null when there is none or it has aged out. */
  read(key: string): readonly string[] | null {
    let document: CacheDocument;
    // A cache that cannot be read is a cache miss. It must never be able to fail a command:
    // the worst it can do is cost the second it was there to save.
    try { document = parse(readFileSync(this.path, "utf8")); }
    catch { return null; }
    const entry = document.entries.find((candidate) => candidate.key === key);
    if (entry === undefined) return null;
    const observed = new Date(entry.observedAt).getTime();
    if (Number.isNaN(observed) || this.#now() - observed > this.#ttlMs || observed > this.#now() + 60_000) return null;
    return Object.freeze([...entry.models]);
  }

  write(key: string, models: readonly string[]): void {
    try {
      let existing: readonly CacheEntry[] = [];
      try { existing = parse(readFileSync(this.path, "utf8")).entries; } catch { /* start a fresh document */ }
      const entries = [
        ...existing.filter((entry) => entry.key !== key),
        { key, models: [...models], observedAt: new Date(this.#now()).toISOString() },
      ];
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, this.path);
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { force: true });
      }
    } catch { /* a cache that cannot be written is still only a cache */ }
  }
}
