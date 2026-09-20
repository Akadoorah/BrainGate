import { spawnSync } from "node:child_process";

/**
 * Read-only git facts about a workspace, computed by BrainGate and handed to a worker as data.
 *
 * Measured 2026-09-20: this operator's installed `claude` build exposes no local shell tool at all
 * to a headless `-p` run — not denied by a permission mode, simply absent from the tool list, even
 * with every Claude-Code session-identity environment variable stripped (`CLAUDECODE`,
 * `CLAUDE_CODE_MESSAGING_SOCKET`, and the rest). A DIRECT read on that build asked "what changed"
 * and answered "I don't have a Bash/shell tool in this environment" — true, and not something a
 * `--permission-mode` flag can fix, because there is no tool for the flag to gate.
 *
 * Codex and Grok are not in that position: Codex's `--sandbox read-only` is a kernel sandbox around
 * a real shell, and Grok's `run_terminal_command` already runs under `--permission-mode default`
 * with no approval needed (both re-measured the same day, in a throwaway repository). Widening
 * Claude's tool grant would do nothing on this build; and even where a worker's shell does work,
 * BrainGate answering a `git status`/`git diff` question by pre-computing the answer itself is the
 * safer design regardless — the model never has to be trusted to run git correctly, and every
 * worker sees the same figures, not each one's own retelling.
 *
 * So this is not shell access delegated to a worker; it is the workspace's git state, read once by
 * BrainGate and placed in the task's `context.git`, which every DIRECT prompt tells the worker to
 * treat as already answered.
 */
export interface GitReadContext {
  readonly branch: string | null;
  /** Null on a freshly initialised repository with no commit yet. */
  readonly head: string | null;
  readonly clean: boolean;
  /** `git status --porcelain`, verbatim, bounded. */
  readonly status: string;
  /** `git diff HEAD`, verbatim, bounded; empty on a clean tree or a repository with no commit. */
  readonly diff: string;
  /** True when `status` or `diff` were cut short for size. */
  readonly truncated: boolean;
}

const STATUS_LIMIT = 8_000;
const DIFF_LIMIT = 60_000;

function run(cwd: string, args: readonly string[]): { readonly ok: boolean; readonly stdout: string } {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return { ok: !result.error && result.status === 0, stdout: String(result.stdout ?? "") };
}

/**
 * The workspace's git facts, or `null` when it is not a git repository (or git is unavailable).
 *
 * Never throws: a read task's context is best-effort informational data, and a workspace that is
 * not a repository — or a `git` binary that is missing — is a fact worth omitting, not a reason to
 * fail the task that asked an unrelated question.
 */
export function readGitContext(repositoryPath: string): GitReadContext | null {
  const top = run(repositoryPath, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const branchResult = run(repositoryPath, ["branch", "--show-current"]);
  const branch = branchResult.ok && branchResult.stdout.trim().length > 0 ? branchResult.stdout.trim() : null;
  const headResult = run(repositoryPath, ["rev-parse", "--verify", "HEAD"]);
  const head = headResult.ok && headResult.stdout.trim().length > 0 ? headResult.stdout.trim() : null;
  const statusResult = run(repositoryPath, ["status", "--porcelain"]);
  const status = statusResult.ok ? statusResult.stdout : "";
  const clean = status.trim().length === 0;
  // No base to diff against on a repository with no commit yet; `git diff HEAD` would fail.
  const diffResult = head === null || clean ? { ok: true, stdout: "" } : run(repositoryPath, ["diff", "HEAD"]);
  const diff = diffResult.ok ? diffResult.stdout : "";
  const statusTruncated = status.length > STATUS_LIMIT;
  const diffTruncated = diff.length > DIFF_LIMIT;
  return Object.freeze({
    branch,
    head,
    clean,
    status: statusTruncated ? status.slice(0, STATUS_LIMIT) : status,
    diff: diffTruncated ? diff.slice(0, DIFF_LIMIT) : diff,
    truncated: statusTruncated || diffTruncated,
  });
}
