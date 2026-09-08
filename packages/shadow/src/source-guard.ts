import { spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import { redactSecrets } from "@braingate/security";

const MAX_HASHED_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Files under `.git` that grant code execution or rewrite BrainGate's own view of the
 * checkout. `git status` never reports these, so they are read directly.
 *
 * `config` matters most: `core.fsmonitor`, `core.pager` and aliases are command values git
 * runs itself, so a provider that writes one turns the next git invocation into execution.
 */
const GIT_INTERNAL_FILES = Object.freeze(["config", "info/exclude", "HEAD", "packed-refs"]);
const GIT_HOOKS_DIR = "hooks";

/**
 * Every git call is hardened, because this guard runs *after* an untrusted provider had the
 * checkout as its working directory. `core.fsmonitor` is a command git executes during
 * `status`, so a planted value would make the check itself the payload. System and global
 * config are dropped for the same reason, and `--no-optional-locks` keeps a read from
 * writing the index.
 */
function git(cwd: string, args: readonly string[], allowFailure = false): string {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "--no-optional-locks", ...args],
    {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "", GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (result.error) throw new BrainGateInvariantError("SHADOW_GIT_ERROR", result.error.message);
  if (result.status !== 0 && !allowFailure) {
    throw new BrainGateInvariantError("SHADOW_GIT_FAILED", redactSecrets(String(result.stderr || result.stdout)).slice(0, 1_000) || `git ${String(args[0])} failed`);
  }
  return String(result.stdout ?? "");
}

/** Status entries of one porcelain kind. `-z` keeps unusual filenames intact. */
function entries(status: string, prefix: string): readonly string[] {
  return Object.freeze(status.split("\0").filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length)));
}

/**
 * Hash one path by what it is. A symlink is hashed as its target string rather than followed,
 * so repointing a link is a change and a link out of the tree is never read.
 */
function hashPath(digest: Hash, absolute: string): void {
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) { digest.update("symlink"); return; }
    if (stat.isDirectory()) {
      // A collapsed ignored directory. Its own mtime changes when an entry is added or
      // removed directly inside it, which is the cheap signal available without walking a
      // tree that can hold hundreds of thousands of files. See the limits note below.
      digest.update(`dir:${String(stat.mtimeMs)}:${String(stat.mode)}`);
      return;
    }
    if (!stat.isFile()) { digest.update("nonfile"); return; }
    if (stat.size > MAX_HASHED_FILE_BYTES) { digest.update(`oversize:${String(stat.size)}:${String(stat.mtimeMs)}`); return; }
    digest.update(readFileSync(absolute));
    digest.update(`mode:${String(stat.mode)}`);
  } catch {
    // Absent, or vanished between listing and reading. Recorded rather than ignored, so an
    // appearing or disappearing path is itself a change.
    digest.update("unreadable");
  }
}

/**
 * Opaque fingerprint of everything a read-only run must leave untouched.
 *
 * Porcelain status alone is not enough on three counts, each of which was reproduced against
 * this implementation before it was written:
 *
 *   1. An already-modified or untracked file reports the same ` M path` / `?? path` line
 *      however its bytes change, so tracked content comes from `git diff HEAD --binary` and
 *      untracked content is hashed directly.
 *   2. Ignored paths are omitted entirely by default, so `.env`, `.brain/` and other
 *      gitignored control and credential surfaces were invisible. `--ignored=matching` brings
 *      them into the listing.
 *   3. `.git` is never reported at all, so a planted hook or a `core.fsmonitor` config value
 *      was invisible while granting execution on the next git command. Those files are read
 *      directly.
 *
 * Known limit: git collapses a wholly ignored directory such as `node_modules/` into a single
 * entry, and walking one is not affordable per task. Such a directory contributes its own
 * mtime, which changes when an entry is added or removed directly inside it, but a
 * modification to an existing file deep within it is not detected. That residual gap is why
 * this guard is defence in depth behind the read-only provider profiles, not a replacement
 * for them.
 *
 * Read-only tasks are deliberately allowed to run against a dirty checkout, so callers compare
 * before against after rather than asserting cleanliness.
 */
export function sourceCheckoutFingerprint(repositoryPath: string): string {
  const root = git(repositoryPath, ["rev-parse", "--show-toplevel"]).trim() || repositoryPath;
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"], true).trim() || join(root, ".git");
  const head = git(root, ["rev-parse", "--verify", "HEAD"], true).trim();
  const status = git(root, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"]);
  const trackedDiff = git(root, ["diff", "HEAD", "--binary"], true);

  const digest = createHash("sha256");
  digest.update(head).update("\0").update(status).update("\0").update(trackedDiff);

  for (const path of [...entries(status, "?? "), ...entries(status, "!! ")]) {
    digest.update("\0").update(path).update("\0");
    hashPath(digest, join(root, path));
  }

  for (const name of GIT_INTERNAL_FILES) {
    digest.update("\0").update(`git:${name}`).update("\0");
    hashPath(digest, join(gitDir, name));
  }

  let hooks: readonly string[] = [];
  try { hooks = Object.freeze([...readdirSync(join(gitDir, GIT_HOOKS_DIR))].sort()); } catch { hooks = []; }
  for (const name of hooks) {
    // `.sample` files are shipped by git and never executed.
    if (name.endsWith(".sample")) continue;
    digest.update("\0").update(`hook:${name}`).update("\0");
    hashPath(digest, join(gitDir, GIT_HOOKS_DIR, name));
  }

  return digest.digest("hex");
}

/**
 * Fails closed when a read-only shadow run changed the source checkout.
 *
 * The shadow profiles run the primary and any same-workspace reviewer with `cwd` set to the
 * real checkout, and their read-only-ness rests on provider-supplied tool restrictions. That
 * is a declaration by the provider, not something BrainGate enforces, so the result is
 * verified afterwards instead of assumed.
 */
export function assertSourceCheckoutUnchanged(repositoryPath: string, before: string): void {
  if (sourceCheckoutFingerprint(repositoryPath) !== before) {
    // The guard sees that the checkout changed; it cannot see who changed it. Editing your own
    // files while a task runs trips it exactly as a misbehaving provider would, and blaming the
    // provider for your own edit sends the reader after the wrong thing. Both possibilities are
    // named, strongest first, because the dangerous one must not be buried.
    throw new BrainGateInvariantError(
      "SHADOW_SOURCE_MUTATED",
      "The source checkout changed while a read-only task was running. Either the provider did not honour its read-only profile, or the checkout was edited during the run — check `git status` and re-run if the change was yours.",
    );
  }
}
