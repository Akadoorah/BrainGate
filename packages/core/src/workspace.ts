import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError } from "./errors.js";

/**
 * A workspace: the local directory native workers actually run in.
 *
 * The correction this module exists for. BrainGate used to treat a project as a *git checkout*, and
 * the execution path as `git rev-parse --show-toplevel`. That is wrong in a way that shows up
 * immediately in ordinary use: an operator who launches BrainGate inside `repo/flutter_migration`
 * wants the native CLI's `cwd` to be `repo/flutter_migration`, and the old model silently widened it
 * to `repo` — or refused the session outright, because the path they selected was not the top level.
 *
 * The model is now:
 *
 * ```text
 * Project   — logical identity and durable knowledge. Owns memory and preferences.
 *   └── Workspace — a concrete local directory. Owns execution state.
 *         └── Goal ──► Tasks ──► native workers, whose cwd is this directory
 * ```
 *
 * A workspace's **identity is its canonical path**, and nothing else. Git is a capability a
 * workspace may have, not a requirement for existing and not a source of identity: `gitRoot`,
 * `branch` and `HEAD` are recorded as metadata because they are useful evidence, and a directory
 * that is not a repository is a perfectly good workspace.
 *
 * Two workspaces of one project may share a git root, a remote, a basename and a project id. They
 * are still two workspaces, because execution truth — changed files, tests run, native sessions,
 * snapshots — belongs to the directory it happened in.
 */

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

/** Git's view of a workspace, when the workspace has one. Informational, never identity. */
export interface WorkspaceGitMetadata {
  readonly gitRoot: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly remote: string | null;
  readonly dirty: boolean;
}

export interface WorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  readonly projectId: string;
  /** The canonical directory native workers run in. The identity, and the execution boundary. */
  readonly path: string;
  /** What the operator saw when they selected it; kept so a message can name it as they know it. */
  readonly label: string;
  readonly git: WorkspaceGitMetadata | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

/**
 * Workspace identity, derived from the path.
 *
 * A hash rather than a counter because it must be computable from the path alone: the same directory
 * yields the same id on every machine and in every process, so storage can be found without reading
 * a registry first, and two processes cannot disagree about where a workspace's state lives.
 */
export function workspaceIdFor(canonicalPath: string): WorkspaceId {
  return createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16) as WorkspaceId;
}

/**
 * Git's view of a directory, or `null` when it is not inside a repository.
 *
 * Every field is optional in the world, so every field here tolerates absence: an unborn branch has
 * no HEAD, a repository with no remote has no URL. None of it is used to decide whether the
 * workspace exists.
 */
export function gitMetadataFor(directory: string): WorkspaceGitMetadata | null {
  const git = (args: readonly string[]): string | null => {
    const result = spawnSync("git", [...args], { cwd: directory, encoding: "utf8", shell: false });
    if (result.status !== 0) return null;
    const value = String(result.stdout ?? "").trim();
    return value.length === 0 ? null : value;
  };
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top === null) return null;
  let gitRoot: string;
  try { gitRoot = realpathSync.native(top); }
  catch { return null; }
  const status = git(["status", "--porcelain"]);
  return Object.freeze({
    gitRoot,
    // `symbolic-ref` rather than the more usual `rev-parse --abbrev-ref HEAD`, because the latter
    // fails on an unborn branch — the ordinary state of a freshly initialised repository, and one
    // where the branch name is exactly what the operator knows. A detached HEAD has no branch, and
    // null says that rather than inventing the word "HEAD".
    branch: git(["symbolic-ref", "--short", "HEAD"]),
    // An unborn branch is the ordinary state of a fresh repository, and it is not an error.
    head: git(["rev-parse", "HEAD"]),
    remote: git(["remote", "get-url", "origin"]),
    dirty: status !== null && status.length > 0,
  });
}

/** A directory, canonicalized, or `null` when it is not a usable directory. */
export function canonicalDirectory(path: string): string | null {
  try {
    const resolved = realpathSync.native(resolve(path));
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * The registry of workspaces belonging to one project.
 *
 * A JSON file beside the project's own storage rather than a database: it is a small map from an id
 * to a path, it is read on every attach, and it must survive being read by a process that has not
 * opened anything else yet. Written atomically, because a half-written registry is a project whose
 * workspaces have gone missing.
 */
export class WorkspaceRegistry {
  readonly #path: string;
  readonly #now: () => string;
  #records: WorkspaceRecord[] | null = null;

  constructor(projectStorageDir: string, options: { readonly now?: () => string } = {}) {
    this.#path = join(projectStorageDir, "workspaces.json");
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get path(): string { return this.#path; }

  list(): readonly WorkspaceRecord[] {
    return Object.freeze([...this.#load()]);
  }

  find(workspaceId: string): WorkspaceRecord | null {
    return this.#load().find((record) => record.workspaceId === workspaceId) ?? null;
  }

  findByPath(canonicalPath: string): WorkspaceRecord | null {
    return this.#load().find((record) => record.path === canonicalPath) ?? null;
  }

  /**
   * Records a workspace, or refreshes the one already recorded at this path.
   *
   * Registration is idempotent on the path, which is what makes it safe to call on every attach: the
   * id is derived from the path, so a directory can never acquire two identities, and re-registering
   * only updates what was observed — metadata and `lastSeenAt`.
   */
  register(input: { readonly projectId: string; readonly path: string; readonly label?: string }): WorkspaceRecord {
    const canonical = canonicalDirectory(input.path);
    if (canonical === null) {
      throw new BrainGateInvariantError("WORKSPACE_PATH_INVALID", `A workspace must be an existing directory: ${input.path}`);
    }
    const workspaceId = workspaceIdFor(canonical);
    const records = [...this.#load()];
    const index = records.findIndex((record) => record.workspaceId === workspaceId);
    const existing = index < 0 ? null : records[index]!;
    const record: WorkspaceRecord = Object.freeze({
      workspaceId,
      projectId: input.projectId,
      path: canonical,
      label: input.label ?? existing?.label ?? basename(canonical),
      git: gitMetadataFor(canonical),
      createdAt: existing?.createdAt ?? this.#now(),
      lastSeenAt: this.#now(),
    });
    if (index < 0) records.push(record); else records[index] = record;
    this.#records = records;
    this.#save();
    return record;
  }

  #load(): WorkspaceRecord[] {
    if (this.#records !== null) return this.#records;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.#path, "utf8")) as unknown; }
    catch {
      // No registry, or an unreadable one, is a project with no workspaces yet. It is never an
      // error to open a project: the state that matters is created on first use.
      return (this.#records = []);
    }
    const entries = Array.isArray((parsed as { readonly workspaces?: unknown }).workspaces)
      ? ((parsed as { readonly workspaces: unknown[] }).workspaces)
      : [];
    const records: WorkspaceRecord[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Partial<WorkspaceRecord>;
      if (typeof record.workspaceId !== "string" || typeof record.path !== "string") continue;
      // The path is re-canonicalized on read: a workspace on a removable volume is the same
      // workspace when the volume comes back, and a path that no longer resolves is still listed so
      // a message can say which workspace is missing rather than pretending it never existed.
      const canonical = canonicalDirectory(record.path) ?? record.path;
      records.push(Object.freeze({
        workspaceId: record.workspaceId as WorkspaceId,
        projectId: typeof record.projectId === "string" ? record.projectId : "",
        path: canonical,
        label: typeof record.label === "string" ? record.label : basename(canonical),
        git: (record.git ?? null) as WorkspaceGitMetadata | null,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : this.#now(),
        lastSeenAt: typeof record.lastSeenAt === "string" ? record.lastSeenAt : this.#now(),
      }));
    }
    return (this.#records = records);
  }

  #save(): void {
    const body = { schemaVersion: 1, workspaces: this.#records ?? [] };
    const temporary = `${this.#path}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.#path);
    } catch {
      try { if (existsSync(temporary)) rmSync(temporary, { force: true }); } catch { /* nothing to undo */ }
    }
  }
}

/**
 * Where one workspace's execution state lives.
 *
 * Deliberately *not* `<projectStorageDir>` itself. That directory is what the old model used for
 * every checkout carrying a project id, so two clones wrote one ledger — the failure this layout
 * removes. Per-workspace state is created on demand and never shares a file with another workspace.
 */
export function workspaceStorageDir(projectStorageDir: string, workspaceId: WorkspaceId): string {
  return join(projectStorageDir, "workspaces", workspaceId);
}

/** The project-level half of the same directory: durable knowledge, valid across workspaces. */
export function projectStateDir(projectStorageDir: string): string {
  return projectStorageDir;
}
