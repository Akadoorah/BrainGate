import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { BrainGateInvariantError, assertRegisteredProject, type RegisteredProject } from "@braingate/core";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function git(cwd: string, args: readonly string[], allowFailure = false): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error) throw new BrainGateInvariantError("WORKTREE_GIT_ERROR", result.error.message);
  if (result.status !== 0 && !allowFailure) throw new BrainGateInvariantError("WORKTREE_GIT_FAILED", String(result.stderr || result.stdout).trim() || `git ${args[0]} failed`);
  return String(result.stdout ?? "").trim();
}

export interface WorktreeHandle {
  readonly taskId: string;
  readonly projectId: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
}

export class WorktreeGuard {
  readonly #project: RegisteredProject;
  readonly #db: Database.Database;
  readonly #root: string;

  constructor(project: RegisteredProject) {
    assertRegisteredProject(project);
    this.#project = project;
    this.#root = join(project.storageDir, "worktrees");
    mkdirSync(this.#root, { recursive: true });
    this.#db = new Database(join(project.storageDir, "execution.sqlite"));
    this.#db.pragma("foreign_keys = ON");
    this.#migrate();
  }

  close(): void { this.#db.close(); }

  prepare(input: { taskId: string; repositoryPath: string; baseRef: string }): WorktreeHandle {
    if (!TASK_ID.test(input.taskId)) throw new BrainGateInvariantError("WORKTREE_TASK_ID_INVALID", "Worktree task ID must be a UUID.");
    if (!BASE_REF.test(input.baseRef) || input.baseRef.includes("..") || input.baseRef.includes("@{")) {
      throw new BrainGateInvariantError("WORKTREE_BASE_REF_INVALID", "Unsafe base ref.");
    }
    const repo = realpathSync.native(input.repositoryPath);
    if (!this.#project.repositories.includes(repo)) throw new BrainGateInvariantError("WORKTREE_PROJECT_MISMATCH", "Repository is not registered to this project.");
    const top = realpathSync.native(git(repo, ["rev-parse", "--show-toplevel"]));
    if (top !== repo) throw new BrainGateInvariantError("WORKTREE_REPOSITORY_INVALID", "Registered repository path must be the Git top level.");
    if (git(repo, ["status", "--porcelain"]).length !== 0) throw new BrainGateInvariantError("WORKTREE_REPOSITORY_DIRTY", "Source repository must be clean before worktree creation.");
    git(repo, ["rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`]);

    const repoKey = createHash("sha256").update(repo).digest("hex").slice(0, 12);
    const parent = join(this.#root, repoKey);
    mkdirSync(parent, { recursive: true });
    const worktree = join(parent, input.taskId);
    if (existsSync(worktree)) throw new BrainGateInvariantError("WORKTREE_PATH_EXISTS", "Task worktree path already exists.");
    const branch = `braingate/task-${input.taskId}`;

    git(repo, ["worktree", "add", "-b", branch, worktree, input.baseRef]);
    const realWorktree = realpathSync.native(worktree);
    const realRoot = realpathSync.native(this.#root);
    if (!inside(realRoot, realWorktree)) {
      git(repo, ["worktree", "remove", "--force", realWorktree], true);
      throw new BrainGateInvariantError("WORKTREE_PATH_ESCAPE", "Created worktree escaped BrainGate root.");
    }
    const createdAt = new Date().toISOString();
    const transaction = this.#db.transaction(() => {
      this.#db.prepare(`INSERT INTO worktrees (task_id, project_id, repository_path, worktree_path, branch, base_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.taskId, this.#project.projectId, repo, realWorktree, branch, input.baseRef, createdAt);
      this.#db.prepare(`INSERT INTO worktree_events (task_id, project_id, kind, occurred_at) VALUES (?, ?, 'created', ?)`)
        .run(input.taskId, this.#project.projectId, createdAt);
    });
    try { transaction(); } catch (error) {
      git(repo, ["worktree", "remove", "--force", realWorktree], true);
      throw error;
    }
    return Object.freeze({ taskId: input.taskId, projectId: this.#project.projectId, repositoryPath: repo, worktreePath: realWorktree, branch, baseRef: input.baseRef });
  }

  get(taskId: string): WorktreeHandle | undefined {
    const row = this.#db.prepare(`SELECT task_id, project_id, repository_path, worktree_path, branch, base_ref FROM worktrees WHERE task_id = ? AND project_id = ?`).get(taskId, this.#project.projectId) as { task_id: string; project_id: string; repository_path: string; worktree_path: string; branch: string; base_ref: string } | undefined;
    return row === undefined ? undefined : Object.freeze({ taskId: row.task_id, projectId: row.project_id, repositoryPath: row.repository_path, worktreePath: row.worktree_path, branch: row.branch, baseRef: row.base_ref });
  }

  assertActive(handle: WorktreeHandle): void {
    if (handle.projectId !== this.#project.projectId) throw new BrainGateInvariantError("WORKTREE_PROJECT_MISMATCH", "Worktree belongs to another project.");
    const known = this.get(handle.taskId);
    if (known === undefined || known.worktreePath !== handle.worktreePath || known.repositoryPath !== handle.repositoryPath) throw new BrainGateInvariantError("WORKTREE_UNKNOWN", "Worktree is not registered by BrainGate.");
    const removed = this.#db.prepare(`SELECT 1 AS found FROM worktree_events WHERE task_id = ? AND kind = 'removed' LIMIT 1`).get(handle.taskId) as { found: number } | undefined;
    if (removed !== undefined) throw new BrainGateInvariantError("WORKTREE_INACTIVE", "Worktree was already removed.");
    if (!existsSync(handle.worktreePath)) throw new BrainGateInvariantError("WORKTREE_MISSING", "Registered worktree no longer exists.");
    const realRoot = realpathSync.native(this.#root);
    const realPath = realpathSync.native(handle.worktreePath);
    if (!inside(realRoot, realPath) || realPath !== handle.worktreePath) throw new BrainGateInvariantError("WORKTREE_PATH_ESCAPE", "Worktree canonical path is outside its guarded root.");
  }

  cleanup(handle: WorktreeHandle): void {
    this.assertActive(handle);
    git(handle.repositoryPath, ["worktree", "remove", "--force", handle.worktreePath]);
    this.#db.prepare(`INSERT INTO worktree_events (task_id, project_id, kind, occurred_at) VALUES (?, ?, 'removed', ?)`)
      .run(handle.taskId, this.#project.projectId, new Date().toISOString());
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS worktrees (
        task_id TEXT NOT NULL, project_id TEXT NOT NULL, repository_path TEXT NOT NULL, worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL, base_ref TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, project_id), UNIQUE (worktree_path)
      );
      CREATE TABLE IF NOT EXISTS worktree_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('created','removed')), occurred_at TEXT NOT NULL,
        FOREIGN KEY (task_id, project_id) REFERENCES worktrees(task_id, project_id)
      );
      CREATE TRIGGER IF NOT EXISTS worktrees_no_update BEFORE UPDATE ON worktrees BEGIN SELECT RAISE(ABORT, 'worktrees are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worktrees_no_delete BEFORE DELETE ON worktrees BEGIN SELECT RAISE(ABORT, 'worktrees are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worktree_events_no_update BEFORE UPDATE ON worktree_events BEGIN SELECT RAISE(ABORT, 'worktree_events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS worktree_events_no_delete BEFORE DELETE ON worktree_events BEGIN SELECT RAISE(ABORT, 'worktree_events are append-only'); END;
    `);
  }
}
