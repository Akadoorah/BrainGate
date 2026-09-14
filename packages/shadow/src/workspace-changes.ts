import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import { sourceCheckoutFingerprint } from "./source-guard.js";

/**
 * What a run did to the workspace it was pointed at.
 *
 * A read-only run has to be *verified* to have changed nothing, and a DIRECT run has to *report*
 * what it changed. Both questions are asked here, and both are asked without requiring Git: a
 * workspace is a directory (ADR 0015), and a mode that only works in a repository is the defect
 * this module exists to remove.
 *
 * Where Git is present its fingerprint is used for the verification, because it also covers what a
 * plain walk cannot afford to — a wholly ignored dependency tree contributes its own mtime, and the
 * `.git` internals that grant execution are read directly. The per-file map below is taken either
 * way, because it is what answers "which files changed", and a hash of the whole tree cannot.
 */

/**
 * Directories never walked for the change report.
 *
 * They are dependency and build output, they are what makes a walk of a real project expensive, and
 * every one of them is regenerable. Skipping them is reported rather than assumed away: a run whose
 * changes landed inside one says so instead of reporting a clean workspace.
 */
const SKIPPED_DIRECTORIES: readonly string[] = Object.freeze([
  ".git", "node_modules", "vendor", "target", "dist", "build", "out",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", ".dart_tool", "Pods", ".gradle", ".terraform",
]);

const MAX_FILES = 20_000;
const MAX_HASHED_BYTES = 2 * 1024 * 1024;

export interface WorkspaceSnapshot {
  readonly root: string;
  /** The whole-workspace digest: Git's fingerprint when there is a repository, a tree hash when not. */
  readonly digest: string;
  /** Relative path → content hash, for every file the walk read. */
  readonly files: ReadonlyMap<string, string>;
  /** Directories that were not walked, so the report can say what it cannot see. */
  readonly skipped: readonly string[];
  /** True when the walk hit its file ceiling: the map is a prefix, not the whole tree. */
  readonly truncated: boolean;
}

export interface WorkspaceChanges {
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** The true count when the reported list was capped, so a receipt never understates a change. */
  readonly changedTotal: number;
}

function insideRepository(root: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", shell: false, timeout: 15_000 });
  return !result.error && result.status === 0 && String(result.stdout ?? "").trim().length > 0;
}

function hashFile(absolute: string): string {
  try {
    const stat = lstatSync(absolute);
    // A symlink is hashed as its target string rather than followed, so repointing one is a change
    // and a link that leaves the tree is never read.
    if (stat.isSymbolicLink()) return "symlink";
    if (!stat.isFile()) return "nonfile";
    if (stat.size > MAX_HASHED_BYTES) return `oversize:${String(stat.size)}`;
    return createHash("sha256").update(readFileSync(absolute)).digest("hex");
  } catch {
    // Vanished between listing and reading. Recorded, because a disappearing file is a change.
    return "unreadable";
  }
}

/**
 * Every file under `root`, hashed, with the directories above left out and reported.
 *
 * One walk, sorted, so two snapshots of an unchanged workspace are equal by construction rather
 * than by luck of readdir order.
 */
export function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const files = new Map<string, string>();
  const skipped: string[] = [];
  let truncated = false;

  const walk = (directory: string): void => {
    if (truncated) return;
    let entries: readonly string[];
    try { entries = Object.freeze([...readdirSync(directory)].sort()); }
    catch { return; }
    for (const name of entries) {
      if (truncated) return;
      const absolute = join(directory, name);
      let isDirectory = false;
      try { isDirectory = lstatSync(absolute).isDirectory(); } catch { isDirectory = false; }
      if (isDirectory) {
        if (SKIPPED_DIRECTORIES.includes(name)) { skipped.push(relative(root, absolute)); continue; }
        walk(absolute);
        continue;
      }
      if (files.size >= MAX_FILES) { truncated = true; return; }
      files.set(relative(root, absolute), hashFile(absolute));
    }
  };
  walk(root);

  const treeDigest = createHash("sha256");
  for (const [path, hash] of files) treeDigest.update(path).update("\0").update(hash).update("\0");
  // The Git fingerprint is the stronger reading where it exists: it also covers ignored file
  // *content* and the `.git` internals. Absent a repository, the tree hash is the whole answer.
  const digest = insideRepository(root) ? sourceCheckoutFingerprint(root) : treeDigest.digest("hex");

  return Object.freeze({
    root,
    digest,
    files,
    skipped: Object.freeze([...new Set(skipped)].sort()),
    truncated,
  });
}

/** What changed between two snapshots of the same directory, or `null` when nothing did. */
export function workspaceChangesSince(before: WorkspaceSnapshot, after: WorkspaceSnapshot, limit = 200): WorkspaceChanges | null {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [path, hash] of after.files) {
    const previous = before.files.get(path);
    if (previous === undefined) added.push(path);
    else if (previous !== hash) changed.push(path);
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) removed.push(path);
  }
  const changedTotal = changed.length + added.length + removed.length;
  if (changedTotal === 0) return null;
  return Object.freeze({
    changed: Object.freeze(changed.sort().slice(0, limit)),
    added: Object.freeze(added.sort().slice(0, limit)),
    removed: Object.freeze(removed.sort().slice(0, limit)),
    changedTotal,
  });
}

/** Every path a change touched, for a receipt that lists rather than counts. */
export function changedPaths(changes: WorkspaceChanges): readonly string[] {
  return Object.freeze([...new Set([...changes.changed, ...changes.added, ...changes.removed])].sort());
}

/**
 * Fails closed when a run that was supposed to leave the workspace alone did not.
 *
 * The same shape as `assertSourceCheckoutUnchanged`, and deliberately a separate function: that one
 * exists because a provider's read-only-ness is a declaration by the provider, and it can afford to
 * require Git. This one is what a workspace without a repository can be held to.
 */
export function assertWorkspaceUnchanged(root: string, before: WorkspaceSnapshot, what: string): void {
  const after = snapshotWorkspace(root);
  if (after.digest === before.digest) return;
  const changes = workspaceChangesSince(before, after);
  const listed = changes === null ? "" : ` Changed: ${changedPaths(changes).slice(0, 20).join(", ")}${changes.changedTotal > 20 ? ` (+${String(changes.changedTotal - 20)} more)` : ""}.`;
  throw new BrainGateInvariantError(
    "WORKSPACE_MUTATED",
    [
      `${what} changed the workspace it was only supposed to read.${listed}`,
      "",
      "BrainGate verifies this after the fact because a read-only posture is a declaration by the",
      "runtime, not something BrainGate can enforce on it. The change was not reverted: your files",
      "are exactly as the run left them, and nothing was committed.",
    ].join("\n"),
  );
}
