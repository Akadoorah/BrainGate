import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError, parseProjectConfig, parseProjectId } from "@braingate/core";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new BrainGateInvariantError("DOGFOOD_GIT_FAILED", result.error?.message ?? String(result.stderr || result.stdout).trim() || `git ${args[0]} failed`);
  }
  return String(result.stdout ?? "").trim();
}

function gitTopLevel(cwd: string): string {
  return realpathSync.native(git(cwd, ["rev-parse", "--show-toplevel"]));
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

export function initializeDogfoodProject(input: { readonly cwd: string; readonly projectId: unknown; readonly name: unknown }): ProjectInitResult {
  const repo = gitTopLevel(realpathSync.native(resolve(input.cwd)));
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
  readonly head: string;
}

export function inspectGitRepository(repositoryPath: string): GitRepositoryState {
  const repo = gitTopLevel(realpathSync.native(resolve(repositoryPath)));
  if (repo !== realpathSync.native(resolve(repositoryPath))) throw new BrainGateInvariantError("DOGFOOD_REPOSITORY_INVALID", "Registered repository must be the Git top level.");
  const status = git(repo, ["status", "--porcelain"]);
  const branch = git(repo, ["branch", "--show-current"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  return Object.freeze({ repositoryPath: repo, clean: status.length === 0, branch: branch.length === 0 ? null : branch, head });
}
