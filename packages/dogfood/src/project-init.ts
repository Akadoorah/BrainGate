import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError, parseProjectConfig, parseProjectId, type ProjectId } from "@braingate/core";

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
  /** Whether the registered workspace is inside a Git repository. Metadata, not a precondition. */
  readonly hasRepository: boolean;
  readonly manifestPath: string;
}

/**
 * Whether this directory has a repository behind it, and what it would take if not.
 *
 * Asked before the identity questions rather than after them: a new directory is an ordinary
 * place to start. It used to decide whether registration was possible at all; it now decides only
 * whether the worktree-isolated write modes will have anything to isolate from, because a workspace
 * is a directory and Git is one capability such a directory may have.
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
  /**
   * Move this checkout's existing registration to here, replacing what the manifest names.
   *
   * The one way a registration changes which checkout it points at, and it is never implied: the
   * operator asks for it, having been shown both directories. Without an explicit path the honest
   * answer to "these two checkouts disagree" is a refusal, because rebinding silently would move a
   * project's memory, ledger and goals onto a different body of work.
   */
  readonly rebind?: boolean;
}): ProjectInitResult {
  const here = realpathSync.native(resolve(input.cwd));
  if (input.createRepository === true && findRepository(here) === null) {
    // A default branch name is chosen explicitly, because git's own default is a warning on
    // some installations and whatever `init.defaultBranch` happens to be on others.
    git(here, ["init", "-b", "main"]);
  }
  /**
   * The workspace is the directory the operator is in.
   *
   * It used to be `git rev-parse --show-toplevel`, which quietly widened `repo/flutter_migration` to
   * `repo` — the directory they chose was not merely mis-registered, it was unrepresentable. A
   * workspace is a local directory, and Git is a capability it may have rather than a requirement
   * for existing, so a subdirectory and a non-repository directory are both ordinary registrations.
   */
  const repo = here;
  const projectId = parseProjectId(input.projectId);
  if (typeof input.name !== "string" || input.name.trim().length === 0) throw new BrainGateInvariantError("PROJECT_NAME_INVALID", "Project name must be a non-empty string.");
  const name = input.name.trim();
  // Read once, after any `--git-init`, so a create and the manifest it writes cannot disagree.
  const hasRepository = findRepository(repo) !== null;
  const brainDir = join(repo, ".brain");
  const manifestPath = join(brainDir, "project.json");

  if (existsSync(manifestPath)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown; }
    catch { throw new BrainGateInvariantError("PROJECT_INIT_CONFLICT", "Existing .brain/project.json is invalid and will not be overwritten."); }
    const existing = parseProjectConfig(parsed, brainDir);
    const same = existing.projectId === projectId && existing.name === name && existing.repositories.length === 1 && existing.repositories[0] === repo;
    if (!same && input.rebind !== true) {
      throw new BrainGateInvariantError("PROJECT_INIT_CONFLICT", "Existing .brain/project.json has a different project identity or repository mapping and will not be overwritten. Re-run with --rebind to move this project's registration to this workspace.");
    }
    if (same) return Object.freeze({ created: false, projectId, projectName: name, repositoryPath: repo, hasRepository, manifestPath });
    // A rebind keeps the *project* — its id, its name, everything filed under it — and changes only
    // which workspace that project runs against. That is the operator's decision to make explicitly,
    // and it is the one case where the manifest is replaced rather than created.
    if (hasRepository) ensureLocalIgnore(repo);
    writeManifest(manifestPath, repo, { projectId: existing.projectId, name: existing.name }, { replace: true, hasRepository });
    return Object.freeze({ created: false, projectId: existing.projectId, projectName: existing.name, repositoryPath: repo, hasRepository, manifestPath });
  }

  // Only where there is a repository to keep the manifest out of. A plain directory has nothing to
  // ignore it from, and refusing to register one was the other half of making Git the model.
  if (hasRepository) ensureLocalIgnore(repo);
  mkdirSync(brainDir, { recursive: true, mode: 0o700 });
  try {
    writeManifest(manifestPath, repo, { projectId, name }, { hasRepository });
  } catch (error) {
    if (existsSync(manifestPath)) rmSync(manifestPath, { force: true });
    throw error;
  }
  return Object.freeze({ created: true, projectId, projectName: name, repositoryPath: repo, hasRepository, manifestPath });
}

/**
 * Writes the manifest, and refuses to leave state Git can see.
 *
 * The document names the workspace by absolute path. It used to be `repositories: [".."]` — relative
 * to the manifest's own directory, which read as one level up because the file lives in `.brain/`.
 * That form could only mean "the repository", which was true only while a workspace was always the
 * repository root. A workspace can now be a subdirectory, so what it is has to be said rather than
 * inferred from where the file happens to sit.
 */
function writeManifest(
  manifestPath: string,
  repo: string,
  identity: { readonly projectId: ProjectId; readonly name: string },
  options: { readonly replace?: boolean; readonly hasRepository: boolean },
): void {
  const document = { project_id: identity.projectId, name: identity.name, repositories: [repo] };
  // `wx` for a create, so two processes cannot race one registration into existence; `w` only for a
  // rebind, which is the single deliberate case of replacing a manifest that already exists.
  const flag = options.replace === true ? "w" : "wx";
  writeFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag });
  // Only a repository can see the manifest, and only a repository can be asked. Asking git in a
  // plain directory fails rather than passing, which is how registration became impossible there.
  if (!options.hasRepository) return;
  const status = git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.split(/\r?\n/).some((line) => line.includes(".brain/"))) {
    throw new BrainGateInvariantError("PROJECT_INIT_NOT_IGNORED", "Local .brain manifest is visible to Git; refusing unsafe onboarding state.");
  }
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
