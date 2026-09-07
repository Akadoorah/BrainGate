import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError } from "@braingate/core";
import { isSensitivePath, redactSecrets } from "@braingate/security";

const CONTROL_FILES = new Set(["claude.md", "agents.md", "ai_engineering_guide.md"]);
const CONTROL_PREFIXES = [".git/", ".claude/", ".brain/", ".github/workflows/"] as const;
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 128 * 1024;

function git(cwd: string, args: readonly string[], allowFailure = false): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw new BrainGateInvariantError("WRITE_GIT_ERROR", result.error.message);
  if (result.status !== 0 && !allowFailure) throw new BrainGateInvariantError("WRITE_GIT_FAILED", redactSecrets(String(result.stderr || result.stdout)).slice(0, 1000) || `git ${args[0]} failed`);
  return String(result.stdout ?? "");
}

function nul(value: string): readonly string[] { return Object.freeze(value.split("\0").filter((item) => item.length > 0)); }

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalized(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, ""); }

function assertAllowedPath(worktreePath: string, raw: string): string {
  const path = normalized(raw);
  if (path.length === 0 || path.includes("\0") || isAbsolute(path) || path === ".." || path.startsWith("../") || path.includes("/../")) throw new BrainGateInvariantError("WRITE_PATH_INVALID", "Changed path is not a safe relative worktree path.");
  const lower = path.toLowerCase();
  if (isSensitivePath(path)) throw new BrainGateInvariantError("WRITE_SENSITIVE_PATH", `Write task touched a sensitive path: ${path}`);
  if (CONTROL_FILES.has(lower) || CONTROL_PREFIXES.some((prefix) => lower.startsWith(prefix))) throw new BrainGateInvariantError("WRITE_CONTROL_PATH", `M11 forbids agent/control-plane configuration changes: ${path}`);
  const absolute = resolve(worktreePath, path);
  if (!inside(worktreePath, absolute)) throw new BrainGateInvariantError("WRITE_PATH_ESCAPE", `Changed path escapes the task worktree: ${path}`);
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const real = realpathSync.native(absolute);
      if (!inside(worktreePath, real)) throw new BrainGateInvariantError("WRITE_SYMLINK_ESCAPE", `Changed symlink resolves outside the task worktree: ${path}`);
    }
  }
  return path;
}

function ignoredPaths(worktreePath: string): readonly string[] {
  const entries = nul(git(worktreePath, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"]));
  return Object.freeze(entries.filter((entry) => entry.startsWith("!! ")).map((entry) => entry.slice(3)));
}

export interface GuardedDiff {
  readonly changedFiles: readonly string[];
  readonly diff: string;
}

export function collectGuardedDiff(worktreePathInput: string): GuardedDiff {
  const worktreePath = realpathSync.native(worktreePathInput);
  const tracked = nul(git(worktreePath, ["diff", "--name-only", "-z", "HEAD", "--"]));
  const untracked = nul(git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z", "--"]));
  for (const ignored of ignoredPaths(worktreePath)) {
    if (isSensitivePath(ignored)) throw new BrainGateInvariantError("WRITE_SENSITIVE_PATH", `Write task created or touched an ignored sensitive path: ${normalized(ignored)}`);
  }
  const changedFiles = [...new Set([...tracked, ...untracked].map((path) => assertAllowedPath(worktreePath, path)))].sort();
  if (changedFiles.length === 0) throw new BrainGateInvariantError("WRITE_NO_CHANGES", "Write provider completed without producing a reviewable worktree change.");
  if (changedFiles.length > 40) throw new BrainGateInvariantError("WRITE_CHANGESET_TOO_LARGE", "M11 write task changed more than 40 files.");

  let diff = git(worktreePath, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"]);
  for (const path of untracked) {
    const safe = assertAllowedPath(worktreePath, path);
    const absolute = resolve(worktreePath, safe);
    if (!existsSync(absolute) || lstatSync(absolute).isDirectory()) continue;
    const stat = lstatSync(absolute);
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) throw new BrainGateInvariantError("WRITE_UNTRACKED_TOO_LARGE", `Untracked file exceeds M11 review cap: ${safe}`);
    const data = readFileSync(absolute);
    if (data.includes(0)) throw new BrainGateInvariantError("WRITE_BINARY_UNTRACKED", `Untracked binary file is not allowed in M11: ${safe}`);
    diff += `\n--- /dev/null\n+++ b/${safe}\n@@ new file @@\n${data.toString("utf8").split(/\r?\n/).map((line) => `+${line}`).join("\n")}\n`;
  }
  diff = redactSecrets(diff);
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) throw new BrainGateInvariantError("WRITE_DIFF_TOO_LARGE", "M11 review diff exceeds 1 MiB.");
  return Object.freeze({ changedFiles: Object.freeze(changedFiles), diff });
}

export function assertSourceCheckoutClean(repositoryPath: string): void {
  if (git(repositoryPath, ["status", "--porcelain"]).trim().length !== 0) throw new BrainGateInvariantError("WRITE_SOURCE_MUTATED", "Source checkout changed during a worktree-only write task.");
}
