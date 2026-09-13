/**
 * A read-only snapshot of a registered project, materialised for a provider that must not see the
 * checkout itself.
 *
 * The problem this solves: BrainGate's read-primary path needs the project, and the only provider it
 * may currently point at the real checkout is Anthropic — whose quota can be exhausted. Codex and
 * Grok can execute inside a workspace BrainGate controls but must never be handed the operator's
 * working directory. So BrainGate copies the project into a workspace of its own and points the
 * provider at that copy.
 *
 * Two properties make it safe rather than merely convenient:
 *
 * 1. **The provider's working directory is the copy.** It is never the source, so no argument, no
 *    relative path and no escape from the sandbox reaches the original tree.
 * 2. **The copy is a stated policy, not "the project".** What is included, what is deliberately left
 *    out, and why, is recorded in a manifest. A snapshot that cannot be complete is not created at
 *    all — the caller fails truthfully instead of handing a provider a project with a hole in it.
 *
 * The snapshot is one per task, reused across provider attempts (a failover must not produce a second
 * snapshot the first attempt never saw), verified before and after the provider runs, and discarded
 * when the task reaches a terminal path.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import { isSensitivePath } from "@braingate/security";
import type { RegisteredProject } from "@braingate/core";

/** The policy document version. Any change to the rules below belongs in this string. */
export const SNAPSHOT_POLICY_VERSION = "2026-09-12.1";

/**
 * Conservative caps, chosen so a real application fits and a runaway tree cannot fill the disk.
 *
 * These are hard limits rather than truncation points: a snapshot that would exceed one is not
 * created, because a provider reading a project that is silently missing half its files would answer
 * about a project that does not exist. The numbers are a source tree's order of magnitude, not a
 * build output's.
 */
export const SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  /**
   * A ceiling on the *paths* the enumeration will hold, not the content.
   *
   * An adversarial or merely unlucky repository can present thousands of very long filenames, and a
   * manifest that holds them all is memory an operator never agreed to spend. Refused rather than
   * truncated, like every other limit here.
   */
  maxPathBytes: 512 * 1024,
  maxPathLength: 1_024,
});

/** Why an entry the source contains is not in the snapshot. Each reason is a policy decision. */
export const SNAPSHOT_EXCLUSION_REASONS = Object.freeze([
  /** Version-control metadata: the snapshot is not a repository and must not look like one. */
  "vcs-metadata",
  /** BrainGate's own private project state (ledger, corpus, manifests) is not project content. */
  "brain-gate-private",
  /**
   * A file git's own ignore rules cover.
   *
   * Kept in the vocabulary because the *policy* is recorded; the tree itself is never enumerated, so
   * no entry carries this reason in practice.
   */
  "git-ignored",
  /** A fifo, socket or device node: it carries no readable project content. */
  "special-file",
  /**
   * A path BrainGate's existing sensitive-path policy names — `.env`, private keys, credential stores.
   *
   * Not copied, so a provider reading a snapshot can see strictly *less* of the project than the
   * trusted primary that reads the checkout, never more.
   */
  "sensitive-path",
] as const);
export type SnapshotExclusionReason = (typeof SNAPSHOT_EXCLUSION_REASONS)[number];

export interface SnapshotEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Set when the source entry was a symlink whose target resolved inside the project. */
  readonly viaSymlink?: true;
}

export interface SnapshotExclusion {
  readonly path: string;
  readonly reason: SnapshotExclusionReason;
}

export interface SnapshotManifest {
  readonly schemaVersion: 1;
  /** Bumped when the layout of this file changes, so a janitor can tell an old snapshot from a lie. */
  readonly lifecycleVersion: 1;
  readonly policyVersion: string;
  readonly snapshotId: string;
  readonly sourceProjectId: string;
  /** The task this copy was made for, when it was made for one. */
  readonly taskId: string | null;
  /**
   * The source's content fingerprint, measured **before any provider was called**.
   *
   * A snapshot is only ever taken of this state: if the project changed between the task starting and
   * the copy being made, the copy is refused rather than taken from a newer tree. Otherwise the
   * planner would have read one project and the provider that answered would have read another.
   */
  readonly taskStartFingerprint: string;
  /** The fingerprint of the state actually copied. Equal to `taskStartFingerprint` by construction. */
  readonly sourceFingerprint: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /**
   * True by construction: the snapshotter throws instead of producing an incomplete workspace, so a
   * manifest that says `true` is describing something that was checked, not something hoped for.
   */
  readonly complete: true;
  /** What the provider is told the root is: a label, not a host path. */
  readonly providerVisibleRoot: "workspace";
  /** Files BrainGate itself writes into the workspace for the invocation (schema, request, profile). */
  readonly controlFiles: readonly string[];
  /**
   * How ignored files are treated, as one policy statement rather than a list.
   *
   * BrainGate does not enumerate the ignored tree: it is not in the copy, the provider never sees it,
   * and a build cache changing under `node_modules/` must not invalidate what the provider was given.
   * The policy is named so the record still says what was left out and on whose authority.
   */
  readonly ignoredPolicy: "git-exclude-standard";
  readonly entries: readonly SnapshotEntry[];
  readonly excludedEntries: readonly SnapshotExclusion[];
  /** Hash over the policy version and every entry, so two identical sources give one identity. */
  readonly manifestHash: string;
  /**
   * What a janitor needs to decide whether this copy is still in use, and whether it is BrainGate's.
   *
   * Written by the process that owns the snapshot; a directory whose metadata does not parse is
   * treated as not-BrainGate's and is never deleted by the sweep.
   */
  readonly lease: SnapshotLease;
}

export interface SnapshotLease {
  readonly lifecycleVersion: 1;
  /** The process holding the copy. A live pid is the strongest "do not delete this" signal. */
  readonly pid: number;
  readonly taskId: string | null;
  readonly startedAt: string;
}

export interface ProjectSnapshot {
  readonly id: string;
  /** The directory the provider is pointed at. Contains only copied project content plus control files. */
  readonly root: string;
  readonly manifest: SnapshotManifest;
  readonly manifestHash: string;
}

export interface SnapshotLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathBytes: number;
  readonly maxPathLength: number;
}

export interface SnapshotterOptions {
  readonly project: RegisteredProject;
  readonly limits?: SnapshotLimits;
  readonly now?: () => Date;
  /** One retry by default: a source that changed mid-copy is retried once, then refused. */
  readonly attempts?: number;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new BrainGateInvariantError("SNAPSHOT_GIT_FAILED", `git ${args[0] ?? ""} failed while building the snapshot: ${String(result.stderr ?? "").trim().slice(0, 300)}`);
  }
  return String(result.stdout ?? "");
}

function nulList(output: string): readonly string[] {
  return output.split("\u0000").filter((entry) => entry.length > 0);
}

/**
 * A path from git is untrusted input: it is joined onto the snapshot root, so it is validated before
 * it is used rather than after something has been written through it.
 *
 * A trailing separator is tolerated here and removed by `normalizeSnapshotEntryPath`, because git
 * emits one in a real and ordinary case: `git ls-files --others` reports an untracked *nested
 * repository* as a single directory entry — `dir/nested/` — rather than enumerating the files inside
 * it, and `.git/` is not something `--exclude-standard` hides. Measured 2026-09-13 against git 2.51.0
 * on a project whose tracked root contained exactly that shape.
 *
 * Tolerating it does not weaken this check. A trailing separator adds no segment, resolves to the
 * same location, and every segment that could actually aim a write elsewhere is still rejected
 * exactly as before. The directory that remains after normalization is refused by the caller, which
 * is the honest answer: a nested repository is a directory, and a snapshot holds files.
 */
function assertSafeRelativePath(path: string, maxLength = 1_024): void {
  if (path.length === 0 || path.length > maxLength) throw new BrainGateInvariantError("SNAPSHOT_PATH_INVALID", "Snapshot entry path is empty or implausibly long.");
  if (path.includes("\u0000") || path.includes("\\")) throw new BrainGateInvariantError("SNAPSHOT_PATH_INVALID", "Snapshot entry path contains a NUL byte or a backslash.");
  if (isAbsolute(path)) throw new BrainGateInvariantError("SNAPSHOT_PATH_INVALID", "Snapshot entry path is absolute.");
  // The separator git uses to say "this is a directory" is not a segment. Anything else empty is.
  const segments = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new BrainGateInvariantError("SNAPSHOT_PATH_INVALID", `Snapshot entry path escapes the snapshot root: ${path}`);
  }
}

/**
 * The path an entry is actually copied to and recorded under.
 *
 * Separate from the guard so the guard can keep rejecting anything that is not a plain path, and this
 * can do the one normalization that is not a policy decision: git's trailing separator is a notation,
 * not a location, and every later use — `join`, `lstat`, the manifest — wants the location.
 */
function normalizeSnapshotEntryPath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sha256File(path: string): { readonly hash: string; readonly bytes: number } {
  const content = readFileSync(path);
  return Object.freeze({ hash: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength });
}

function manifestHashOf(input: { readonly policyVersion: string; readonly entries: readonly SnapshotEntry[]; readonly excluded: readonly SnapshotExclusion[] }): string {
  const identity = {
    policyVersion: input.policyVersion,
    entries: input.entries.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes })),
    excluded: input.excluded.map((entry) => ({ path: entry.path, reason: entry.reason })),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/**
 * Every file the source presents, split into what the snapshot takes and what the policy leaves out.
 *
 * Git is the enumerator because it already knows the difference the operator cares about: the tracked
 * tree, the untracked files they have not ignored, and the ignored ones (build output, dependencies,
 * editor droppings, `.env` files). Re-deriving those rules by hand would be a second, worse copy of
 * `.gitignore` semantics — and the one that disagreed with git would be the one deciding what a
 * provider reads.
 */
interface SourceListing {
  readonly included: readonly { readonly path: string; readonly viaSymlink: boolean }[];
  readonly excluded: readonly SnapshotExclusion[];
}

export class ProjectSnapshotter {
  readonly #project: RegisteredProject;
  readonly #limits: SnapshotLimits;
  readonly #now: () => Date;
  readonly #attempts: number;

  constructor(options: SnapshotterOptions) {
    this.#project = options.project;
    this.#limits = options.limits ?? SNAPSHOT_LIMITS;
    this.#now = options.now ?? (() => new Date());
    this.#attempts = Math.max(1, Math.min(2, options.attempts ?? 2));
  }

  /** Where snapshots live: inside the project's private storage, never in a system temp tree. */
  static storageRoot(project: RegisteredProject): string {
    return join(project.storageDir, "snapshots");
  }

  /**
   * Creates one snapshot, retrying once if the source changed while it was being read.
   *
   * The retry exists because a concurrent edit is not the operator's mistake and not a security
   * event: it is a race, and the honest responses are to take a fresh consistent copy or to refuse.
   * A second failure is refused, because a snapshot that cannot be shown to be coherent must not be
   * handed to a provider as if it were the project.
   */
  /**
   * The source's content fingerprint, as a snapshot would be taken of it.
   *
   * Public because a task must be able to record the state it *started* from before it calls any
   * provider: `create` then refuses to copy a different state.
   */
  fingerprint(): string {
    return this.#fingerprint();
  }

  create(input: { readonly taskId?: string; readonly expectedSourceFingerprint?: string } = {}): ProjectSnapshot {
    // Checked before anything reads the source: a project with no repository, or with two, is a
    // configuration error and must be reported as one rather than surfacing as a Node type error
    // from a path that was never there.
    this.#source();
    const taskStart = input.expectedSourceFingerprint ?? this.#fingerprint();
    // The task-state invariant: the copy must be of the project as the task found it. A provider
    // answering about a tree the planner never saw is not a slower answer, it is a wrong one.
    if (this.#fingerprint() !== taskStart) {
      throw new BrainGateInvariantError(
        "SNAPSHOT_SOURCE_CHANGED_SINCE_TASK_START",
        "The project changed after this task started, so a snapshot of it now would mix two project states. Nothing was copied.",
      );
    }
    let lastMutation: BrainGateInvariantError | null = null;
    for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
      try {
        const snapshot = this.#createOnce(taskStart, input.taskId ?? null);
        // Coherent with task start *after* the copy too: a file that changed mid-copy is a race, and
        // the answer to a race is another read of the same task-start state, never a newer one.
        if (this.#fingerprint() !== taskStart) {
          this.discard(snapshot);
          lastMutation = new BrainGateInvariantError("SNAPSHOT_SOURCE_MUTATED", "The source project changed while its snapshot was being created, so the copy is not coherent with task start.");
          continue;
        }
        return snapshot;
      } catch (error) {
        if (error instanceof BrainGateInvariantError && error.code === "SNAPSHOT_SOURCE_MUTATED") { lastMutation = error; continue; }
        throw error;
      }
    }
    throw lastMutation ?? new BrainGateInvariantError("SNAPSHOT_SOURCE_MUTATED", "The source project did not stop changing while its snapshot was created.");
  }

  /** The one registered repository a snapshot is taken from. */
  #source(): string {
    if (this.#project.repositories.length !== 1) {
      throw new BrainGateInvariantError("SNAPSHOT_REPOSITORY_AMBIGUOUS", "A snapshot is taken from exactly one registered repository.");
    }
    return this.#project.repositories[0]!;
  }

  #createOnce(taskStartFingerprint: string, taskId: string | null): ProjectSnapshot {
    const source = this.#source();
    const sourceStat = statSync(source);
    if (!sourceStat.isDirectory()) throw new BrainGateInvariantError("SNAPSHOT_SOURCE_INVALID", "The registered repository path is not a directory.");

    const id = createHash("sha256").update(`${this.#project.projectId}:${taskStartFingerprint}:${this.#now().toISOString()}:${String(process.pid)}`).digest("hex").slice(0, 32);
    const base = join(ProjectSnapshotter.storageRoot(this.#project), id);
    const root = join(base, "workspace");
    mkdirSync(root, { recursive: true, mode: 0o700 });

    try {
      const listing = this.#listSource(source);
      const entries: SnapshotEntry[] = [];
      let totalBytes = 0;

      for (const item of listing.included) {
        assertSafeRelativePath(item.path);
        const destination = join(root, item.path);
        if (!inside(root, resolve(destination))) {
          throw new BrainGateInvariantError("SNAPSHOT_PATH_ESCAPE", `Snapshot entry resolved outside the snapshot root: ${item.path}`);
        }
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        // A symlink inside the project is materialised as the content it points at, so the snapshot
        // holds no links at all: a link is a path a later reader could follow somewhere else. The
        // resolution is `realpath` rather than a path join, because joining a path never follows a
        // link and would happily read `/project/link/../../etc/passwd` as if it were in the project.
        const sourcePath = join(source, item.path);
        const resolvedSource = item.viaSymlink ? realpathSync.native(sourcePath) : sourcePath;
        if (item.viaSymlink && !inside(realpathSync.native(source), resolvedSource)) {
          throw new BrainGateInvariantError("SNAPSHOT_SYMLINK_ESCAPE", `Symlink escapes the registered project: ${item.path}`);
        }
        const { bytes } = sha256File(resolvedSource);
        if (bytes > this.#limits.maxFileBytes) {
          throw new BrainGateInvariantError("SNAPSHOT_LIMIT_EXCEEDED", `${item.path} is ${String(bytes)} bytes, over the per-file snapshot limit of ${String(this.#limits.maxFileBytes)}.`);
        }
        totalBytes += bytes;
        if (totalBytes > this.#limits.maxTotalBytes) {
          throw new BrainGateInvariantError("SNAPSHOT_LIMIT_EXCEEDED", `The project exceeds the snapshot byte limit of ${String(this.#limits.maxTotalBytes)}.`);
        }
        copyFileSync(resolvedSource, destination);
        const mode = statSync(resolvedSource).mode & 0o777;
        chmodSync(destination, mode | 0o400);
        const { hash } = sha256File(destination);
        entries.push(Object.freeze({ path: item.path, sha256: hash, bytes, ...(item.viaSymlink ? { viaSymlink: true as const } : {}) }));
      }

      if (entries.length > this.#limits.maxFiles) {
        throw new BrainGateInvariantError("SNAPSHOT_LIMIT_EXCEEDED", `The project has ${String(entries.length)} files, over the snapshot limit of ${String(this.#limits.maxFiles)}.`);
      }

      entries.sort((a, b) => a.path.localeCompare(b.path));
      const excluded = Object.freeze([...listing.excluded].sort((a, b) => a.path.localeCompare(b.path)));
      const manifestHash = manifestHashOf({ policyVersion: SNAPSHOT_POLICY_VERSION, entries, excluded });
      const lease: SnapshotLease = Object.freeze({
        lifecycleVersion: 1 as const,
        pid: process.pid,
        taskId,
        startedAt: this.#now().toISOString(),
      });
      const manifest: SnapshotManifest = Object.freeze({
        schemaVersion: 1 as const,
        lifecycleVersion: 1 as const,
        policyVersion: SNAPSHOT_POLICY_VERSION,
        snapshotId: id,
        sourceProjectId: this.#project.projectId,
        taskId,
        taskStartFingerprint,
        sourceFingerprint: taskStartFingerprint,
        createdAt: this.#now().toISOString(),
        fileCount: entries.length,
        totalBytes,
        complete: true as const,
        providerVisibleRoot: "workspace" as const,
        controlFiles: Object.freeze(CONTROL_FILE_NAMES),
        ignoredPolicy: "git-exclude-standard" as const,
        entries: Object.freeze(entries),
        excludedEntries: excluded,
        manifestHash,
        lease,
      });
      // The manifest lives beside the workspace, not inside it: the provider reads project content,
      // and BrainGate's own record of what it was given is not part of that content.
      writeFileSync(join(base, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return Object.freeze({ id, root, manifest, manifestHash });
    } catch (error) {
      // A refused snapshot leaves nothing behind: half a copy is exactly the incoherent project the
      // policy exists to prevent.
      rmSync(base, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Re-reads the snapshot and reports whether it still matches its manifest.
   *
   * BrainGate's own control files are ignored — the invocation writes a schema and a request into the
   * workspace on purpose. Everything else must match byte for byte, so a provider that wrote to the
   * workspace is caught even when it also answered.
   */
  verify(snapshot: ProjectSnapshot): boolean {
    for (const entry of snapshot.manifest.entries) {
      const path = join(snapshot.root, entry.path);
      if (!existsSync(path)) return false;
      try {
        const { hash, bytes } = sha256File(path);
        if (hash !== entry.sha256 || bytes !== entry.bytes) return false;
      } catch { return false; }
    }
    // And nothing appeared that the manifest does not describe.
    const present = new Set<string>();
    for (const path of walk(snapshot.root)) present.add(path);
    for (const entry of snapshot.manifest.entries) present.delete(entry.path);
    for (const control of snapshot.manifest.controlFiles) present.delete(control);
    return present.size === 0;
  }

  /** Removes a snapshot and its manifest. Safe to call twice, and safe to call for an unknown id. */
  discard(snapshot: { readonly id: string }): void {
    rmSync(join(ProjectSnapshotter.storageRoot(this.#project), snapshot.id), { recursive: true, force: true });
  }

  /** Every snapshot directory currently on disk for this project, oldest first. */
  list(): readonly string[] {
    const root = ProjectSnapshotter.storageRoot(this.#project);
    if (!existsSync(root)) return Object.freeze([]);
    return Object.freeze(readdirSync(root).sort());
  }

  /**
   * A content fingerprint of the source, taken from the same enumeration the snapshot uses.
   *
   * Two runs over an unchanged tree give one value; an edited tracked file, a new untracked file, a
   * deleted file or a change to which files git ignores all change it. It deliberately says nothing
   * about ignored files' *contents* (they are not in the snapshot), which is the same boundary the
   * snapshot policy draws.
   */
  #fingerprint(): string {
    const source = this.#source();
    const listing = this.#listSource(source);
    const hashes = listing.included.map((item) => {
      const target = join(source, item.path);
      try { return `${item.path}:${sha256File(target).hash}`; }
      catch { return `${item.path}:unreadable`; }
    });
    // What a task's project state means, exactly: the commit it is on, the content of the files a
    // snapshot would contain, the policy exclusions among those candidates, and the policy itself.
    // Deliberately absent: the ignored tree. It is not copied, so a cache rewriting under it cannot
    // change what the provider sees and must not invalidate the task's coherence.
    const identity = {
      head: this.#head(source),
      policyVersion: SNAPSHOT_POLICY_VERSION,
      includedPolicy: "git-tracked+untracked-non-ignored",
      ignoredPolicy: "git-exclude-standard",
      excluded: listing.excluded.map((entry) => `${entry.path}:${entry.reason}`),
      files: hashes,
    };
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  }

  /** Refuses an enumeration whose *paths* alone would cost more than the policy allows. */
  #assertEnumerationSize(paths: readonly string[]): void {
    if (paths.length > this.#limits.maxFiles * 4) {
      throw new BrainGateInvariantError("SNAPSHOT_LIMIT_EXCEEDED", `The project enumerates ${String(paths.length)} candidate paths, over the snapshot's enumeration limit.`);
    }
    let bytes = 0;
    for (const path of paths) bytes += path.length;
    if (bytes > this.#limits.maxPathBytes) {
      throw new BrainGateInvariantError("SNAPSHOT_LIMIT_EXCEEDED", `The project's paths total ${String(bytes)} bytes, over the snapshot's path-metadata limit of ${String(this.#limits.maxPathBytes)}.`);
    }
  }

  #head(source: string): string {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8", shell: false });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "no-head";
  }

  #listSource(source: string): SourceListing {
    // `git ls-files` reports paths relative to the top level, and the registered path is that top
    // level (asserted at registration), so the source is already canonical here — resolved once so
    // every containment check compares like with like.
    const canonicalSource = realpathSync.native(source);
    const tracked = nulList(git(source, ["ls-files", "-z"]));
    // `--exclude-standard` is the whole ignored policy: git hands over what is not ignored, and the
    // ignored tree is never enumerated. A cache directory churning under `node_modules/` is then
    // simply not part of what a task's project state means.
    const untracked = nulList(git(source, ["ls-files", "-z", "--others", "--exclude-standard"]));
    const included: { path: string; viaSymlink: boolean }[] = [];
    const excluded: SnapshotExclusion[] = [];
    this.#assertEnumerationSize([...tracked, ...untracked]);

    for (const listed of [...tracked, ...untracked]) {
      assertSafeRelativePath(listed, this.#limits.maxPathLength);
      const path = normalizeSnapshotEntryPath(listed);
      const parts = path.split("/");
      if (parts[0] === ".git") { excluded.push(Object.freeze({ path, reason: "vcs-metadata" as const })); continue; }
      if (parts[0] === ".brain") { excluded.push(Object.freeze({ path, reason: "brain-gate-private" as const })); continue; }
      // The same policy the write diff guard enforces, reused rather than re-invented: a credential
      // file that git does not ignore is still a credential file, and a provider reading a copy of the
      // project does not need it.
      if (isSensitivePath(path)) { excluded.push(Object.freeze({ path, reason: "sensitive-path" as const })); continue; }
      const absolute = join(source, path);
      const stats = lstatSync(absolute);
      /**
       * A directory where a file was expected, which in practice means one thing: a nested repository.
       *
       * `git ls-files --others` reports a directory holding its own `.git` as a single entry instead of
       * descending into it, so this is not a malformed path — it is git declining to enumerate a
       * repository that is not this one. Saying so is the point. The alternative, which is what
       * happened before this branch existed, was a malformed-path error that sent the operator looking
       * for a path bug that was not there.
       *
       * Refused rather than copied: following it would put a second repository's files into a copy the
       * provider reads, under a policy the operator never agreed to for that content. If a nested
       * repository should be part of the project's state, the answer is to register it — not to have
       * BrainGate guess.
       */
      if (stats.isDirectory()) {
        throw new BrainGateInvariantError(
          "SNAPSHOT_NESTED_REPOSITORY",
          `${path} is a nested repository, so git reports the directory instead of the files inside it. A snapshot copies files, so the project's state does not include it. Register that repository as its own project, or add it to .gitignore so it is not part of this one's state.`,
        );
      }
      if (stats.isSymbolicLink()) {
        // In-root: taken as the content it points at. Out-of-root: refused outright, because the
        // alternative is a provider reading a file the operator never placed in the project.
        let target: string;
        try { target = realpathSync.native(absolute); }
        catch { throw new BrainGateInvariantError("SNAPSHOT_SYMLINK_UNRESOLVED", `Symlink does not resolve inside the project: ${path}`); }
        if (!inside(canonicalSource, target)) {
          throw new BrainGateInvariantError("SNAPSHOT_SYMLINK_ESCAPE", `Symlink escapes the registered project: ${path}`);
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          throw new BrainGateInvariantError("SNAPSHOT_SYMLINK_UNRESOLVED", `Symlink inside the project does not resolve to a file: ${path}`);
        }
        included.push({ path, viaSymlink: true });
        continue;
      }
      if (!stats.isFile()) { excluded.push(Object.freeze({ path, reason: "special-file" as const })); continue; }
      included.push({ path, viaSymlink: false });
    }

    return Object.freeze({ included: Object.freeze(included), excluded: Object.freeze(excluded) });
  }
}

/**
 * Files BrainGate writes into a snapshot workspace for the invocation itself.
 *
 * Named here so verification can tell BrainGate's own control files from project content: the
 * schema, Grok's sandbox profile, and the request file Grok reads.
 */
export const CONTROL_FILE_NAMES = Object.freeze([".grok/sandbox.toml", "braingate-schema.json", "braingate-request.json"]);

/** Every relative file path under `root`, used to detect content the manifest does not describe. */
function walk(root: string, prefix = ""): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(join(root, entry.name), path));
    else found.push(path);
  }
  return found;
}

/**
 * How long a snapshot with no live owner is left alone before a sweep may remove it.
 *
 * Longer than the provider call ceiling (20 minutes) plus finalization, so a task that is merely slow
 * is never mistaken for a task that is gone. The grace period is the *weak* signal; a live pid is the
 * strong one, and a copy whose owning process is still running is never removed however old it is.
 */
export const SNAPSHOT_ORPHAN_GRACE_MS = 60 * 60_000;

/** A snapshot directory name BrainGate itself produced: 32 hex characters. */
const SNAPSHOT_ID = /^[0-9a-f]{32}$/;

export interface SnapshotSweepResult {
  readonly removed: readonly string[];
  readonly kept: readonly { readonly id: string; readonly reason: "active" | "grace" | "task-unfinished" }[];
  /** Present but not recognisably BrainGate's. Reported, never deleted. */
  readonly unrecognised: readonly string[];
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Removes snapshots nobody owns any more, and nothing else.
 *
 * What this is for: a snapshot is a copy of the operator's source, so a process killed between
 * creating one and releasing it leaves source code on disk that no task will ever clean up. The
 * guarantee this sweep offers is deliberately narrow and worth stating exactly:
 *
 * - It only ever looks inside this project's own snapshots root, one level deep.
 * - It only ever removes a directory whose name is a snapshot id **and** whose `manifest.json` parses,
 *   names this project, and matches its own directory name. Anything else is reported as unrecognised
 *   and left alone: a sweep that deletes what it does not understand is a worse bug than the litter.
 * - It never follows a symlink, and it re-checks that the target is an immediate child of the root
 *   before removing it, so no path from a ledger, a manifest or an operator can aim it elsewhere.
 * - It removes a copy only when its owning process is gone, it is older than the grace period, and —
 *   when the caller can answer the question — its task is not still runnable.
 *
 * It is idempotent: a second sweep finds nothing to remove.
 */
export function sweepSnapshots(input: {
  readonly project: RegisteredProject;
  readonly now?: number;
  readonly graceMs?: number;
  /** Whether the task a snapshot belongs to is finished. `undefined` when the caller cannot say. */
  readonly isTaskFinished?: (taskId: string) => boolean | undefined;
  readonly pidAlive?: (pid: number) => boolean;
}): SnapshotSweepResult {
  const now = input.now ?? Date.now();
  const graceMs = input.graceMs ?? SNAPSHOT_ORPHAN_GRACE_MS;
  const alive = input.pidAlive ?? pidIsAlive;
  const root = ProjectSnapshotter.storageRoot(input.project);
  const removed: string[] = [];
  const kept: { id: string; reason: "active" | "grace" | "task-unfinished" }[] = [];
  const unrecognised: string[] = [];
  if (!existsSync(root)) return Object.freeze({ removed: Object.freeze([]), kept: Object.freeze([]), unrecognised: Object.freeze([]) });

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const id = entry.name;
    // A symlink is reported, never entered: following one is how a sweep reaches outside its root.
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SNAPSHOT_ID.test(id)) { unrecognised.push(id); continue; }
    const directory = join(root, id);
    let manifest: SnapshotManifest;
    try {
      manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as SnapshotManifest;
    } catch { unrecognised.push(id); continue; }
    const owned = manifest !== null && typeof manifest === "object"
      && manifest.lifecycleVersion === 1
      && manifest.snapshotId === id
      && manifest.sourceProjectId === input.project.projectId
      && manifest.lease !== undefined
      && Number.isInteger(manifest.lease.pid);
    if (!owned) { unrecognised.push(id); continue; }
    if (alive(manifest.lease.pid)) { kept.push({ id, reason: "active" }); continue; }
    let age = now - Date.parse(manifest.createdAt);
    if (!Number.isFinite(age)) {
      try { age = now - statSync(directory).mtimeMs; } catch { unrecognised.push(id); continue; }
    }
    if (age < graceMs) { kept.push({ id, reason: "grace" }); continue; }
    const taskId = manifest.taskId;
    if (taskId !== null && input.isTaskFinished !== undefined && input.isTaskFinished(taskId) === false) {
      kept.push({ id, reason: "task-unfinished" });
      continue;
    }
    // Re-derived immediately before the removal, from the loop's own value: the target is a known
    // child of the canonical root, is not a link, and is not the root itself.
    const target = join(root, id);
    if (dirname(target) !== root || target === root || lstatSync(target).isSymbolicLink()) { unrecognised.push(id); continue; }
    rmSync(target, { recursive: true, force: true });
    removed.push(id);
  }
  return Object.freeze({ removed: Object.freeze(removed), kept: Object.freeze(kept), unrecognised: Object.freeze(unrecognised) });
}

/** A reason a caller can rely on being one of the policy's vocabulary rather than a loose string. */
export function isSnapshotExclusionReason(value: unknown): value is SnapshotExclusionReason {
  return typeof value === "string" && (SNAPSHOT_EXCLUSION_REASONS as readonly string[]).includes(value);
}

export { inside as insideRoot, assertSafeRelativePath as assertSnapshotPath };
