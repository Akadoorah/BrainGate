import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The only tests in this repository that let a provider actually answer.
 *
 * Every other suite drives a fake executor that returns a perfectly shaped response, which
 * proves BrainGate's own plumbing but says nothing about whether a real CLI ever produced a
 * real result. That gap hid a run of defects: the account-name environment variable stripped
 * from provider subprocesses, a role contract no model had ever satisfied, turn and wall-clock
 * ceilings that no real repository fit inside, and a write path disabled by its own hardening.
 * Each shipped green.
 *
 * These tests spend real subscription quota, so they are opt-in and never run in CI:
 *
 *   BRAINGATE_INTEGRATION=1 pnpm --filter @braingate/cli test
 *
 * They assert outcomes, not arguments: an answer that could only come from reading this
 * repository, and a file whose bytes actually changed.
 */

const ENABLED = process.env.BRAINGATE_INTEGRATION === "1";
const SKIP = ENABLED ? false : "opt-in: set BRAINGATE_INTEGRATION=1 (spends real subscription quota)";

// Distinctive enough that it cannot appear by chance or be guessed without reading the file.
const CANARY = "BRAINGATE_INTEGRATION_CANARY_7F3A9C";
const LAUNCHER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "braingate.mjs");

interface Cli {
  readonly repo: string;
  readonly home: string;
  readonly run: (args: readonly string[], timeoutMs?: number) => { status: number | null; stdout: string; stderr: string };
  readonly git: (args: readonly string[]) => string;
  readonly cleanup: () => void;
}

function makeCli(): Cli {
  const root = mkdtempSync(join(tmpdir(), "braingate-integration-"));
  const repo = join(root, "sample-service");
  const home = join(root, "brain-home");
  mkdirSync(repo);

  const git = (args: readonly string[]): string => {
    const result = spawnSync("git", [...args], { cwd: repo, encoding: "utf8", shell: false });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(result.stderr || result.stdout)}`);
    return String(result.stdout ?? "").trim();
  };

  git(["init", "-b", "main"]);
  git(["config", "user.email", "integration@example.invalid"]);
  git(["config", "user.name", "BrainGate Integration"]);
  // The answer to the read task exists only here, so a model that does not read the working
  // tree cannot produce it.
  writeFileSync(join(repo, "SERVICE.md"), `# Sample Service\n\nThe build identifier for this service is ${CANARY}.\n`);
  writeFileSync(join(repo, "labels.txt"), "empty-state: Nothing here yet\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);

  const run = (args: readonly string[], timeoutMs = 15 * 60_000) => {
    const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
      cwd: repo,
      encoding: "utf8",
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, BRAINGATE_HOME: home },
    });
    return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  };

  return { repo, home, run, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Copies the operator's real model catalog into the isolated home.
 *
 * The catalog holds provider-owned model ids and capacities that BrainGate deliberately never
 * invents, so the test reuses whatever the operator has already verified rather than pinning
 * ids of its own that would rot with every provider release.
 */
function useRealCatalog(home: string): void {
  const source = join(homedir(), ".braingate", "global", "models.json");
  if (!existsSync(source)) {
    throw new Error("No model catalog found. Run `braingate models add --definition <file>` before the integration tests.");
  }
  const globalDir = join(home, "global");
  mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  copyFileSync(source, join(globalDir, "models.json"));
}

function register(cli: Cli): void {
  useRealCatalog(cli.home);
  const init = cli.run(["init", "--project-id", "integration-sample", "--name", "Integration Sample"], 60_000);
  assert.equal(init.status, 0, `init failed: ${init.stdout}${init.stderr}`);
}

test("a read task returns an answer that could only come from reading the repository", { skip: SKIP }, async () => {
  const cli = makeCli();
  try {
    register(cli);

    const preflight = cli.run(["dogfood", "preflight"], 120_000);
    assert.equal(preflight.status, 0, `preflight failed: ${preflight.stdout}${preflight.stderr}`);
    assert.match(preflight.stdout, /ask=ready/);

    // Without --execute nothing may reach a provider.
    const plan = cli.run(["dogfood", "ask", "plan", "--task", "What build identifier is recorded in SERVICE.md?"], 120_000);
    assert.equal(plan.status, 0, `plan failed: ${plan.stdout}${plan.stderr}`);
    assert.match(plan.stdout, /Zero provider model calls/);
    assert.doesNotMatch(plan.stdout, new RegExp(CANARY));

    const run = cli.run(["dogfood", "ask", "run", "--task", "Which build identifier does SERVICE.md record? Answer with it exactly.", "--execute"]);
    // Exit status is part of the contract: 0 only when the task completed cleanly. A reviewer
    // asking for changes exits 1, so a caller can tell "done" from "needs your eyes".
    assert.equal(run.status, 0, `run failed: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /outcome=completed/);
    // The whole chain in one assertion: the provider was invoked with a usable environment,
    // it read the working tree, it satisfied the role contract, and the answer reached stdout.
    assert.match(run.stdout, new RegExp(CANARY), "the answer did not contain the canary, so nothing actually read the repository");
  } finally {
    cli.cleanup();
  }
});

test("a write task changes the task worktree and leaves the source checkout byte-identical", { skip: SKIP }, async () => {
  const cli = makeCli();
  try {
    register(cli);

    const before = readFileSync(join(cli.repo, "labels.txt"), "utf8");
    const headBefore = cli.git(["rev-parse", "HEAD"]);

    const plan = cli.run(["dogfood", "write", "plan", "--task", "In labels.txt, change the empty-state label to 'Nothing here yet, add your first item'"], 120_000);
    assert.equal(plan.status, 0, `write plan failed: ${plan.stdout}${plan.stderr}`);
    assert.match(plan.stdout, /Zero provider model calls\. Zero worktrees\./);

    const run = cli.run(["dogfood", "write", "run", "--task", "In labels.txt, change the empty-state label to 'Nothing here yet, add your first item'", "--execute"]);
    assert.equal(run.status, 0, `write run failed: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /Changed: labels\.txt/, "the provider produced no reviewable change");
    assert.match(run.stdout, /No merge performed/);

    // The invariant, checked against the filesystem rather than against a log line.
    assert.equal(readFileSync(join(cli.repo, "labels.txt"), "utf8"), before, "the source checkout was modified");
    assert.equal(cli.git(["rev-parse", "HEAD"]), headBefore, "HEAD moved");
    assert.equal(cli.git(["status", "--porcelain"]), "", "the source checkout is no longer clean");

    // The edit exists, in the task worktree, where the only merge is a human one.
    const worktrees = cli.git(["worktree", "list"]).split("\n").filter((line) => line.includes("braingate/task-"));
    assert.equal(worktrees.length, 1, `expected exactly one task worktree, got ${String(worktrees.length)}`);
    const worktreePath = worktrees[0]!.split(/\s+/)[0]!;
    const edited = readFileSync(join(worktreePath, "labels.txt"), "utf8");
    assert.notEqual(edited, before, "the worktree copy is unchanged, so no edit was actually made");
    assert.match(edited, /add your first item/);
  } finally {
    cli.cleanup();
  }
});
