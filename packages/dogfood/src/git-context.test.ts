import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readGitContext } from "./git-context.js";

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

/**
 * Real defect this closes: a DIRECT read on a build with no local shell tool answered "I don't have
 * Bash in this environment" to "what changed?", though it could read every file fine. BrainGate now
 * answers the git-shaped half of that question itself, once, for every worker.
 */

test("a clean repository reports itself clean, with no diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "braingate-git-context-"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "t@example.invalid"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "init"]);
    const context = readGitContext(dir);
    assert.notEqual(context, null);
    assert.equal(context!.branch, "main");
    assert.notEqual(context!.head, null);
    assert.equal(context!.clean, true);
    assert.equal(context!.status.trim(), "");
    assert.equal(context!.diff, "");
    assert.equal(context!.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an uncommitted edit shows up in both status and diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "braingate-git-context-"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "t@example.invalid"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "init"]);
    writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
    const context = readGitContext(dir);
    assert.notEqual(context, null);
    assert.equal(context!.clean, false);
    assert.match(context!.status, /a\.txt/);
    assert.match(context!.diff, /\+world/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository with no commit yet reports itself with no head and no diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "braingate-git-context-"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    const context = readGitContext(dir);
    assert.notEqual(context, null);
    assert.equal(context!.head, null);
    assert.equal(context!.diff, "", "there is no HEAD to diff against yet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory that is not a git repository yields no context at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "braingate-git-context-"));
  try {
    mkdirSync(join(dir, "nested"), { recursive: true });
    assert.equal(readGitContext(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
