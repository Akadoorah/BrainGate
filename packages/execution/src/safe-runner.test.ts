import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError, ProjectRegistry, parseProjectConfig } from "@braingate/core";
import { SafeCommandRunner, WorktreeGuard } from "./index.js";

function git(cwd: string, args: string[]) { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(String(r.stderr)); }
function setup() {
  const root = mkdtempSync(join(tmpdir(), "braingate-runner-")); const repo = join(root, "repo"); mkdirSync(repo); git(repo, ["init", "-b", "main"]); writeFileSync(join(repo, "a.txt"), "hello\n"); git(repo, ["add", "."]); git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"]);
  const registry = new ProjectRegistry(join(root, "state")); const project = registry.register(parseProjectConfig({ project_id: "sample", name: "Sample", repositories: [repo] }));
  return { root, repo, project };
}

test("read-only profile permits inspection git but denies shell and arbitrary executable", async () => {
  const { repo, project } = setup(); const runner = new SafeCommandRunner();
  const result = await runner.run({ project, profile: "read-only", command: { executable: "git", args: ["status", "--short"], cwd: repo }, env: { PATH: process.env.PATH } });
  assert.equal(result.exitCode, 0);
  await assert.rejects(() => runner.run({ project, profile: "read-only", command: { executable: "sh", args: ["-c", "cat .env"], cwd: repo } }), (e: unknown) => e instanceof BrainGateInvariantError && e.code === "COMMAND_SHELL_DENIED");
  await assert.rejects(() => runner.run({ project, profile: "read-only", command: { executable: "node", args: ["-e", "console.log('x')"], cwd: repo } }), /only a restricted set/);
});

test("write-capable process is blocked until isolation backend exists; verify command is exact allowlist", async () => {
  const { repo, project } = setup(); const worktrees = new WorktreeGuard(project);
  try {
    const handle = worktrees.prepare({ taskId: "123e4567-e89b-12d3-a456-426614174005", repositoryPath: repo, baseRef: "main" });
    const runner = new SafeCommandRunner([{ executable: "git", args: ["status", "--short"] }]);
    await assert.rejects(() => runner.run({ project, profile: "worktree-write", worktree: handle, command: { executable: "node", args: ["-e", "require('fs').writeFileSync('x','x')"], cwd: handle.worktreePath } }), /isolation backend/);
    const verify = await runner.run({ project, profile: "verify", worktree: handle, command: { executable: "git", args: ["status", "--short"], cwd: handle.worktreePath }, env: { PATH: process.env.PATH } });
    assert.equal(verify.exitCode, 0);
    await assert.rejects(() => runner.run({ project, profile: "verify", worktree: handle, command: { executable: "git", args: ["clean", "-fdx"], cwd: handle.worktreePath } }), /not declared/);
    worktrees.cleanup(handle);
  } finally { worktrees.close(); }
});
