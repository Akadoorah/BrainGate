import { ProviderDiscovery, type ProviderSnapshot } from "@braingate/providers";

/**
 * One session's view of which provider CLIs exist and how they are signed in.
 *
 * Discovery spawns a process per provider and waits on the network for some of them, which made
 * it the largest fixed cost in a request — and the interactive session paid it twice for every
 * question, once to show the plan and again to run it. Nothing about the machine changes in the
 * seconds between those two, so probing again learned nothing and cost seconds.
 *
 * Two guarantees, and they are different things:
 *
 * - **A lease is stable.** Everything inside one request sees the same snapshot, so the plan the
 *   operator approved describes the run that follows. Re-probing between them could have routed
 *   to a provider the plan never mentioned, which is a correctness problem before it is a speed
 *   one.
 * - **The cache is short-lived.** Between requests a snapshot older than the window is discarded
 *   rather than reused, because a provider can be signed out or updated while the session is
 *   open, and a stale "authenticated" is worse than a slow "authenticated".
 */

const DEFAULT_TTL_MS = 60_000;

export class ProviderSnapshotCache {
  readonly #discover: () => Promise<readonly ProviderSnapshot[]>;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #pending: Promise<readonly ProviderSnapshot[]> | null = null;
  #startedAt = 0;

  constructor(options: {
    readonly discover?: () => Promise<readonly ProviderSnapshot[]>;
    readonly ttlMs?: number;
    readonly now?: () => number;
  } = {}) {
    this.#discover = options.discover ?? (async () => await new ProviderDiscovery().discoverAll());
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * A resolver for one request. It probes at most once, however many times it is called, and
   * every caller holding it sees the same answer.
   *
   * `onDiscovered` is told the snapshots once, for a caller that needs a fact discovery read — the
   * installed build's version, which decides whether a native session recorded earlier is still
   * resumable. Told rather than returned so this stays a plain resolver at every call site, and
   * called once because the probe itself happens once.
   */
  lease(options: { readonly onDiscovered?: (snapshots: readonly ProviderSnapshot[]) => void } = {}): () => Promise<readonly ProviderSnapshot[]> {
    let held: Promise<readonly ProviderSnapshot[]> | null = null;
    const onDiscovered = options.onDiscovered;
    return async () => {
      held ??= this.#current();
      const snapshots = await held;
      // Guarded so a caller's bookkeeping cannot turn a successful probe into a failed request.
      if (onDiscovered !== undefined) { try { onDiscovered(snapshots); } catch { /* not this layer's problem */ } }
      return snapshots;
    };
  }

  /** Drops the cached probe, so the next lease measures the machine again. */
  invalidate(): void {
    this.#pending = null;
  }

  #current(): Promise<readonly ProviderSnapshot[]> {
    if (this.#pending !== null && this.#now() - this.#startedAt <= this.#ttlMs) return this.#pending;
    this.#startedAt = this.#now();
    // A failed probe must not become the cached answer for the rest of the window: the next
    // request should try again rather than inherit a transient failure.
    const pending = this.#discover();
    this.#pending = pending;
    pending.catch(() => { if (this.#pending === pending) this.#pending = null; });
    return pending;
  }
}
