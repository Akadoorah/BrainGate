import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import { redactSecrets } from "@braingate/security";

const MAX_UNTRACKED_HASH_BYTES = 8 * 1024 * 1024;

function git(cwd: string, args: readonly string[], allowFailure = false): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new BrainGateInvariantError("SHADOW_GIT_ERROR", result.error.message);
  if (result.status !== 0 && !allowFailure) {
    throw new BrainGateInvariantError("SHADOW_GIT_FAILED", redactSecrets(String(result.stderr || result.stdout)).slice(0, 1_000) || `git ${String(args[0])} failed`);
  }
  return String(result.stdout ?? "");
}

/**
 * Untracked paths from `git status -z`. Entries are NUL-separated; a rename entry carries a
 * second NUL-separated path, but renames are never untracked, so only `?? ` lines matter here.
 */
function untrackedPaths(status: string): readonly string[] {
  return Object.freeze(
    status
      .split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3)),
  );
}

/**
 * Opaque fingerprint of everything a read-only run must leave untouched.
 *
 * Porcelain status alone is not enough: an already-modified or untracked file reports the same
 * ` M path` / `?? path` line no matter how its bytes change, so a provider editing a file that
 * was already dirty would slip through. Tracked content therefore comes from `git diff HEAD`,
 * and untracked content is hashed directly.
 *
 * Read-only tasks are deliberately allowed to run against a dirty checkout, so callers compare
 * before against after rather than asserting cleanliness.
 */
export function sourceCheckoutFingerprint(repositoryPath: string): string {
  const root = git(repositoryPath, ["rev-parse", "--show-toplevel"]).trim() || repositoryPath;
  const head = git(root, ["rev-parse", "--verify", "HEAD"], true).trim();
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const trackedDiff = git(root, ["diff", "HEAD", "--binary"], true);

  const digest = createHash("sha256");
  digest.update(head).update("\0").update(status).update("\0").update(trackedDiff);
  for (const path of untrackedPaths(status)) {
    digest.update("\0").update(path).update("\0");
    try {
      const absolute = join(root, path);
      const stat = lstatSync(absolute);
      // A symlink's target is its content; following it would hash whatever it points at.
      if (stat.isSymbolicLink()) digest.update("symlink");
      else if (!stat.isFile()) digest.update("nonfile");
      else if (stat.size > MAX_UNTRACKED_HASH_BYTES) digest.update(`oversize:${String(stat.size)}:${String(stat.mtimeMs)}`);
      else digest.update(readFileSync(absolute));
    } catch {
      // Vanished between listing and reading: record that rather than silently ignoring it.
      digest.update("unreadable");
    }
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
    throw new BrainGateInvariantError(
      "SHADOW_SOURCE_MUTATED",
      "A read-only shadow run changed the source checkout. The provider did not honour its read-only profile.",
    );
  }
}
