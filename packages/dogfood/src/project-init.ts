import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError, parseProjectConfig, parseProjectId } from "@braingate/core";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const output = String(result.stderr || result.stdout).trim();
    throw new BrainGateInvariantError("DOGFOOD_GIT_FAILED", result.error?.message ?? (output || `git ${args[0]} failed`));
  }
  return String(result.stdout ?? "").trim();
}

/** The repository containing `cwd`, or null when there is none above it. */
function findRepository(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  const top = String(result.stdout ?? "").trim();
  return top.length === 0 ? null : realpathSync.native(top);
}

function gitTopLevel(cwd: string): string {
  const repo = findRepository(cwd);
  if (repo === null) {
    throw new BrainGateInvariantError(
      "PROJECT_NOT_A_REPOSITORY",
      "BrainGate works inside a Git repository: every change it proposes is made in a task worktree, and your checkout is fingerprinted before and after each run so a read-only task that writes is caught. Run `git init` here, or `braingate init --git-init` to do it in one step.",
    );
  }
  return repo;
}

function ensureLocalIgnore(repo: string): void {
  const raw = git(repo, ["rev-parse", "--git-path", "info/exclude"]);
  const exclude = isAbsolute(raw) ? raw : resolve(repo, raw);
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(".brain/") || lines.includes("/.brain/") || lines.includes(".brain")) return;
  appendFileSync(exclude, `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}.brain/\n`, "utf8");
}

export interface ProjectInitResult {
  readonly created: boolean;
  readonly projectId: string;
  readonly projectName: string;
  readonly repositoryPath: string;
  readonly manifestPath: string;
}

/**
 * Whether this directory can be registered, and what it would take if not.
 *
 * Asked before the identity questions rather than after them: a new directory is an ordinary
 * place to start, and finding out it cannot be used only after answering two prompts is the
 * kind of ordering that makes a tool feel hostile.
 */
export function repositoryReadiness(cwd: string): Readonly<{ repositoryPath: string | null }> {
  return Object.freeze({ repositoryPath: findRepository(realpathSync.native(resolve(cwd))) });
}

export function initializeDogfoodProject(input: {
  readonly cwd: string;
  readonly projectId: unknown;
  readonly name: unknown;
  /** Create the repository here when there is none. Never implied — it writes to their disk. */
  readonly createRepository?: boolean;
}): ProjectInitResult {
  const here = realpathSync.native(resolve(input.cwd));
  if (input.createRepository === true && findRepository(here) === null) {
    // A default branch name is chosen explicitly, because git's own default is a warning on
    // some installations and whatever `init.defaultBranch` happens to be on others.
    git(here, ["init", "-b", "main"]);
  }
  const repo = gitTopLevel(here);
  const projectId = parseProjectId(input.projectId);
  if (typeof input.name !== "string" || input.name.trim().length === 0) throw new BrainGateInvariantError("PROJECT_NAME_INVALID", "Project name must be a non-empty string.");
  const name = input.name.trim();
  const brainDir = join(repo, ".brain");
  const manifestPath = join(brainDir, "project.json");

  if (existsSync(manifestPath)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown; }
    catch { throw new BrainGateInvariantError("PROJECT_INIT_CONFLICT", "Existing .brain/project.json is invalid and will not be overwritten."); }
    const existing = parseProjectConfig(parsed, brainDir);
    if (existing.projectId !== projectId || existing.name !== name || existing.repositories.length !== 1 || existing.repositories[0] !== repo) {
      throw new BrainGateInvariantError("PROJECT_INIT_CONFLICT", "Existing .brain/project.json has a different project identity or repository mapping and will not be overwritten.");
    }
    return Object.freeze({ created: false, projectId, projectName: name, repositoryPath: repo, manifestPath });
  }

  ensureLocalIgnore(repo);
  mkdirSync(brainDir, { recursive: true, mode: 0o700 });
  const document = { project_id: projectId, name, repositories: [".."] };
  try {
    writeFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const status = git(repo, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.split(/\r?\n/).some((line) => line.includes(".brain/"))) {
      throw new BrainGateInvariantError("PROJECT_INIT_NOT_IGNORED", "Local .brain manifest is visible to Git; refusing unsafe onboarding state.");
    }
  } catch (error) {
    if (existsSync(manifestPath)) rmSync(manifestPath, { force: true });
    throw error;
  }
  return Object.freeze({ created: true, projectId, projectName: name, repositoryPath: repo, manifestPath });
}

export interface GitRepositoryState {
  readonly repositoryPath: string;
  readonly clean: boolean;
  readonly branch: string | null;
  /** Null on an unborn branch: a repository exists, and nothing has been committed to it. */
  readonly head: string | null;
}

export function inspectGitRepository(repositoryPath: string): GitRepositoryState {
  const repo = gitTopLevel(realpathSync.native(resolve(repositoryPath)));
  if (repo !== realpathSync.native(resolve(repositoryPath))) throw new BrainGateInvariantError("DOGFOOD_REPOSITORY_INVALID", "Registered repository must be the Git top level.");
  const status = git(repo, ["status", "--porcelain"]);
  const branch = git(repo, ["branch", "--show-current"]);
  // A freshly created repository has a branch and no commit, and `rev-parse HEAD` fails there.
  // That is a state to report, not a crash: it is exactly where someone who just ran `git init`
  // is standing.
  const resolved = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo, encoding: "utf8", shell: false, timeout: 15_000 });
  const head = resolved.error || resolved.status !== 0 ? null : String(resolved.stdout ?? "").trim();
  return Object.freeze({ repositoryPath: repo, clean: status.length === 0, branch: branch.length === 0 ? null : branch, head: head === null || head.length === 0 ? null : head });
}
