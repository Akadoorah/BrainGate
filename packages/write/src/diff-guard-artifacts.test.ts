import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError } from "@braingate/core";
import { collectGuardedDiff } from "./diff-guard.js";

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

/** A PNG large enough to exceed the untracked-text review cap, as a real image would. */
function png(bytes: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - header.length), 0)]);
}

function worktree() {
  const root = mkdtempSync(join(tmpdir(), "braingate-diff-artifacts-"));
  const wt = join(root, "wt"); mkdirSync(wt);
  git(wt, ["init", "-b", "main"]);
  git(wt, ["config", "user.email", "test@example.invalid"]);
  git(wt, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(wt, "README.md"), "hello\n");
  git(wt, ["add", "."]); git(wt, ["commit", "-m", "initial"]);
  return wt;
}

function artifactFor(wt: string, path: string, data: Buffer, mediaType = "image/png") {
  writeFileSync(join(wt, path), data);
  return { path, mediaType, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

function refuses(code: string) {
  return (error: unknown): boolean => error instanceof BrainGateInvariantError && error.code === code;
}

test("a collected artifact is summarised in the diff, not inlined", () => {
  const wt = worktree();
  const artifact = artifactFor(wt, "hero.png", png(400_000));

  const result = collectGuardedDiff(wt, [artifact]);
  assert.ok(result.changedFiles.includes("hero.png"));
  assert.match(result.diff, /new artifact/);
  assert.match(result.diff, new RegExp(`image/png 400000 bytes sha256:${artifact.sha256}`));
  // 400 KB of image bytes must not be in the review text.
  assert.ok(result.diff.length < 10_000, "the artifact was inlined instead of summarised");
});

test("the exemption applies to the declared path only, never to a neighbour", () => {
  const wt = worktree();
  const artifact = artifactFor(wt, "hero.png", png(2_000));
  // Same directory, same extension, not collected: still an untracked binary.
  writeFileSync(join(wt, "sneaked.png"), png(2_000));

  assert.throws(() => collectGuardedDiff(wt, [artifact]), refuses("WRITE_BINARY_UNTRACKED"));
});

test("without a collection the same file is still rejected", () => {
  const wt = worktree();
  writeFileSync(join(wt, "hero.png"), png(2_000));
  // The exemption comes from having been collected and verified, not from being an image.
  assert.throws(() => collectGuardedDiff(wt), refuses("WRITE_BINARY_UNTRACKED"));
});

test("an artifact swapped after verification is caught by rehashing", () => {
  const wt = worktree();
  const artifact = artifactFor(wt, "hero.png", png(2_000));
  // Replaced on disk after the collector verified it, keeping the claimed hash.
  writeFileSync(join(wt, "hero.png"), png(2_048));

  assert.throws(() => collectGuardedDiff(wt, [artifact]), refuses("WRITE_ARTIFACT_ALTERED"));
});

test("an artifact is not exempt from the sensitive and control path guards", () => {
  const wt = worktree();
  mkdirSync(join(wt, ".github", "workflows"), { recursive: true });
  const artifact = artifactFor(wt, ".github/workflows/planted.png", png(2_000));
  // Being a verified image says nothing about where it may land.
  assert.throws(() => collectGuardedDiff(wt, [artifact]), refuses("WRITE_CONTROL_PATH"));
});

test("an ordinary text change still reviews normally alongside an artifact", () => {
  const wt = worktree();
  const artifact = artifactFor(wt, "hero.png", png(2_000));
  writeFileSync(join(wt, "README.md"), "hello\nworld\n");

  const result = collectGuardedDiff(wt, [artifact]);
  assert.deepEqual([...result.changedFiles].sort(), ["README.md", "hero.png"]);
  assert.match(result.diff, /\+world/);
  assert.match(result.diff, /new artifact/);
});
