import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, unlinkSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError, ProjectRegistry, parseProjectConfig } from "@braingate/core";
import { WorktreeGuard } from "./index.js";

function git(cwd: string, args: string[]) { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(String(r.stderr)); }
function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "braingate-git-")); const repo = join(root, "repo"); const other = join(root, "other"); mkdirSync(repo); mkdirSync(other);
  git(repo, ["init", "-b", "main"]); writeFileSync(join(repo, "README.md"), "hello\n"); git(repo, ["add", "."]); git(repo, ["-c", "user.name=BrainGate Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"]);
  git(other, ["init", "-b", "main"]); writeFileSync(join(other, "README.md"), "other\n"); git(other, ["add", "."]); git(other, ["-c", "user.name=BrainGate Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"]);
  const registry = new ProjectRegistry(join(root, "state"));
  const project = registry.register(parseProjectConfig({ project_id: "sample", name: "Sample", repositories: [repo] }));
  const foreign = registry.register(parseProjectConfig({ project_id: "foreign", name: "Foreign", repositories: [other] }));
  return { root, repo, other, project, foreign };
}

test("worktree is created only for a project repository and original checkout stays unchanged", () => {
  const { repo, other, project } = setupRepo(); const guard = new WorktreeGuard(project);
  try {
    assert.throws(() => guard.prepare({ taskId: "123e4567-e89b-12d3-a456-426614174000", repositoryPath: other, baseRef: "main" }), (e: unknown) => e instanceof BrainGateInvariantError && e.code === "WORKTREE_PROJECT_MISMATCH");
    const handle = guard.prepare({ taskId: "123e4567-e89b-12d3-a456-426614174001", repositoryPath: repo, baseRef: "main" });
    writeFileSync(join(handle.worktreePath, "new.txt"), "worktree only");
    assert.equal(existsSync(join(repo, "new.txt")), false);
    guard.assertActive(handle); guard.cleanup(handle);
    assert.throws(() => guard.assertActive(handle), /already removed/);
  } finally { guard.close(); }
});

test("dirty repo, unsafe ref and tampered symlink path fail closed", (t) => {
  const { repo, project, root } = setupRepo(); const guard = new WorktreeGuard(project);
  try {
    writeFileSync(join(repo, "dirty.txt"), "dirty");
    assert.throws(() => guard.prepare({ taskId: "123e4567-e89b-12d3-a456-426614174002", repositoryPath: repo, baseRef: "main" }), /clean/);
    unlinkSync(join(repo, "dirty.txt"));
    assert.throws(() => guard.prepare({ taskId: "123e4567-e89b-12d3-a456-426614174003", repositoryPath: repo, baseRef: "../main" }), /Unsafe base ref/);
    const handle = guard.prepare({ taskId: "123e4567-e89b-12d3-a456-426614174004", repositoryPath: repo, baseRef: "main" });
    guard.cleanup(handle);
    const outside = join(root, "outside"); mkdirSync(outside);
    try { symlinkSync(outside, handle.worktreePath, "dir"); } catch { t.skip("symlink unavailable"); return; }
    assert.throws(() => guard.assertActive(handle));
  } finally { guard.close(); }
});
