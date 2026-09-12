import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError, ProjectRegistry, parseProjectConfig } from "@braingate/core";
import { ProjectSnapshotter, ProjectSnapshotProvider, SNAPSHOT_LIMITS, sweepSnapshots } from "./index.js";

/**
 * The fixture lives under the operator's home, not in a system temporary directory.
 *
 * That is not tidiness: Grok's sandbox is allowed to read the system temporary trees, so a project
 * registered there fails its isolation self-test — which is what a benchmark or trial repository in
 * `/tmp` would do. Testing the snapshot on a path where the provider story actually holds keeps the
 * test honest about the world the feature runs in.
 */
function setupRepo(options: { readonly files?: Readonly<Record<string, string>> } = {}) {
  const home = mkdtempSync(join(homedir(), ".braingate-snapshot-test-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  const git = (args: readonly string[]): void => {
    const result = spawnSync("git", [...args], { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "BrainGate Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, "app.ts"), "export const answer = 42;\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "util.ts"), "export const util = true;\n");
  mkdirSync(join(repo, ".brain"));
  writeFileSync(join(repo, ".brain", "project.json"), "{}\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\n");
  for (const [path, content] of Object.entries(options.files ?? {})) writeFileSync(join(repo, path), content);
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  const registry = new ProjectRegistry(join(home, "state"));
  const project = registry.register(parseProjectConfig({ project_id: "sample", name: "Sample", repositories: [repo] }));
  return { home, repo, project, git };
}

/** Backdates a snapshot's metadata, so a sweep can be tested without waiting an hour. */
function setOldSnapshot(project: { readonly storageDir: string }, snapshot: { readonly id: string }, ageMs: number) {
  const directory = join(project.storageDir, "snapshots", snapshot.id);
  const path = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { createdAt: string; lease: { pid: number } };
  manifest.createdAt = new Date(Date.now() - ageMs).toISOString();
  // A pid that is certainly not alive, so the age is what the sweep decides on.
  manifest.lease.pid = 999999;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return snapshot;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function codeOf(action: () => unknown): string {
  try { action(); return "no-error"; }
  catch (error) { return error instanceof BrainGateInvariantError ? error.code : String(error); }
}

test("a snapshot holds the project's source and nothing that is not project content", () => {
  const { home, repo, project } = setupRepo();
  try {
    // Untracked-but-not-ignored, ignored, and a dirty tracked modification, all at once: these are
    // the four states a checkout presents and the policy has to answer for each of them.
    writeFileSync(join(repo, "notes.txt"), "untracked\n");
    writeFileSync(join(repo, "debug.log"), "ignored\n");
    writeFileSync(join(repo, "app.ts"), "export const answer = 43;\n");

    const snapshot = new ProjectSnapshotter({ project }).create();

    assert.equal(readFileSync(join(snapshot.root, "README.md"), "utf8"), "hello\n");
    // A tracked file is represented as it is on disk, not as it is in HEAD: the provider is being
    // asked about the project the operator is working on.
    assert.equal(readFileSync(join(snapshot.root, "app.ts"), "utf8"), "export const answer = 43;\n");
    assert.equal(readFileSync(join(snapshot.root, "src", "util.ts"), "utf8"), "export const util = true;\n");
    assert.equal(readFileSync(join(snapshot.root, "notes.txt"), "utf8"), "untracked\n");
    // Version-control metadata is not in the copy, so the copy is not a repository.
    assert.equal(existsSync(join(snapshot.root, ".git")), false);
    // BrainGate's own project state is not project content.
    assert.equal(existsSync(join(snapshot.root, ".brain")), false);
    // Git-ignored files are outside what git considers the project.
    assert.equal(existsSync(join(snapshot.root, "debug.log")), false);

    const reasons = Object.fromEntries(snapshot.manifest.excludedEntries.map((entry) => [entry.path, entry.reason]));
    assert.equal(reasons[".brain/project.json"], "brain-gate-private");
    // The ignored tree is not enumerated at all: the policy is stated once, and a cache directory
    // rewriting under it cannot change what the provider was given.
    assert.equal(snapshot.manifest.ignoredPolicy, "git-exclude-standard");
    assert.equal(snapshot.manifest.excludedEntries.some((entry) => entry.path === "debug.log"), false);
    assert.equal(snapshot.manifest.complete, true, "the policy's omissions are decisions, not gaps");
    assert.equal(snapshot.manifest.entries.some((entry) => entry.path === ".gitignore"), true);
    assert.equal(snapshot.manifest.providerVisibleRoot, "workspace");
    assert.equal(snapshot.manifest.sourceProjectId, "sample");
    assert.equal(JSON.stringify(snapshot.manifest).includes(repo), false, "the manifest carries no host path");
    new ProjectSnapshotter({ project }).discard(snapshot);
    assert.equal(existsSync(snapshot.root), false);
  } finally { cleanup(home); }
});

test("the manifest is deterministic for an unchanged project, and follows it when it changes", () => {
  const { home, repo, project } = setupRepo();
  try {
    const first = new ProjectSnapshotter({ project }).create();
    const second = new ProjectSnapshotter({ project }).create();
    assert.equal(second.manifestHash, first.manifestHash, "same content, same identity");
    assert.notEqual(second.id, first.id, "but each snapshot is its own directory");
    writeFileSync(join(repo, "app.ts"), "export const answer = 44;\n");
    const third = new ProjectSnapshotter({ project }).create();
    assert.notEqual(third.manifestHash, first.manifestHash, "a changed file changes what the provider was given");
    for (const snapshot of [first, second, third]) new ProjectSnapshotter({ project }).discard(snapshot);
  } finally { cleanup(home); }
});

test("an in-project symlink is copied as content, and one that leaves the project is refused", () => {
  const { home, repo, project } = setupRepo();
  try {
    writeFileSync(join(repo, "real.txt"), "real content\n");
    symlinkSync(join(repo, "real.txt"), join(repo, "link.txt"));
    const snapshot = new ProjectSnapshotter({ project }).create();
    const copied = join(snapshot.root, "link.txt");
    assert.equal(readFileSync(copied, "utf8"), "real content\n");
    // Materialised, not reproduced: the copy holds no links, so a later reader cannot follow one out.
    assert.equal(readFileSync(copied, "utf8"), readFileSync(join(snapshot.root, "real.txt"), "utf8"));
    new ProjectSnapshotter({ project }).discard(snapshot);

    const outside = join(home, "outside.txt");
    writeFileSync(outside, "outside the project\n");
    symlinkSync(outside, join(repo, "escape.txt"));
    assert.equal(codeOf(() => new ProjectSnapshotter({ project }).create()), "SNAPSHOT_SYMLINK_ESCAPE");
    // A refused snapshot leaves nothing behind: half a copy is the incoherent project the policy
    // exists to prevent.
    const storage = ProjectSnapshotter.storageRoot(project);
    assert.equal(existsSync(storage) ? readdirSync(storage).length : 0, 0);
  } finally { cleanup(home); }
});

test("a special file is left out rather than copied or followed", () => {
  const { home, repo, project } = setupRepo();
  try {
    const fifo = join(repo, "pipe");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    if (made.status !== 0) return; // no mkfifo on this platform: the case cannot be constructed
    const snapshot = new ProjectSnapshotter({ project }).create();
    // A fifo carries no readable content and nothing in the copy may be one: git does not enumerate
    // non-regular files at all, so it cannot reach the snapshot, and the policy names the case anyway
    // for a path git does hand over.
    assert.equal(existsSync(join(snapshot.root, "pipe")), false);
    assert.equal(snapshot.manifest.entries.some((entry) => entry.path === "pipe"), false);
    assert.equal(snapshot.manifest.complete, true);
    new ProjectSnapshotter({ project }).discard(snapshot);
  } finally { cleanup(home); }
});

test("the limits fail closed instead of producing an incomplete project", () => {
  const { home, repo, project } = setupRepo();
  try {
    writeFileSync(join(repo, "big.txt"), "x".repeat(2048));
    assert.equal(codeOf(() => new ProjectSnapshotter({ project, limits: { maxFiles: 100, maxFileBytes: 1024, maxTotalBytes: 10_000 , maxPathBytes: 512 * 1024, maxPathLength: 1024 } }).create()), "SNAPSHOT_LIMIT_EXCEEDED");
    assert.equal(codeOf(() => new ProjectSnapshotter({ project, limits: { maxFiles: 2, maxFileBytes: 1024 * 1024, maxTotalBytes: 10_000 , maxPathBytes: 512 * 1024, maxPathLength: 1024 } }).create()), "SNAPSHOT_LIMIT_EXCEEDED");
    assert.equal(codeOf(() => new ProjectSnapshotter({ project, limits: { maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 64 , maxPathBytes: 512 * 1024, maxPathLength: 1024 } }).create()), "SNAPSHOT_LIMIT_EXCEEDED");
    // And the defaults are the real caps, not a test's.
    assert.ok(SNAPSHOT_LIMITS.maxFiles >= 1_000 && SNAPSHOT_LIMITS.maxTotalBytes >= 8 * 1024 * 1024);
    const storage = ProjectSnapshotter.storageRoot(project);
    assert.equal(existsSync(storage) ? readdirSync(storage).length : 0, 0, "a refused snapshot is not left on disk");
  } finally { cleanup(home); }
});

test("a mutation during the copy is refused rather than turned into a snapshot of the newer tree", () => {
  const { home, repo, project, git } = setupRepo();
  try {
    git(["add", "."]);
    let mutated = false;
    // `now()` is called once in the middle of building a snapshot: a deterministic stand-in for the
    // operator saving a file while the copy is being made.
    const mutateOnce = (): Date => {
      if (!mutated) { mutated = true; writeFileSync(join(repo, "app.ts"), "export const answer = 99;\n"); }
      return new Date();
    };
    assert.equal(codeOf(() => new ProjectSnapshotter({ project, now: mutateOnce }).create()), "SNAPSHOT_SOURCE_MUTATED");
    const storage = ProjectSnapshotter.storageRoot(project);
    assert.equal(existsSync(storage) ? readdirSync(storage).length : 0, 0, "nothing of the newer tree is left on disk");
  } finally { cleanup(home); }
});

test("a mutation that settles back to the task-start state still yields a coherent snapshot", () => {
  const { home, repo, project } = setupRepo();
  try {
    const before = readFileSync(join(repo, "app.ts"), "utf8");
    // `now()` is called three times per attempt, so call 1 lands inside the first copy and call 4
    // lands at the start of the retry — an editor that wrote through a temp file and put the original
    // back. The retry exists for that case and must produce the task-start state, not the temporary one.
    let calls = 0;
    const touchAndRestore = (): Date => {
      calls += 1;
      if (calls === 1) writeFileSync(join(repo, "app.ts"), "export const answer = 99;\n");
      if (calls === 4) writeFileSync(join(repo, "app.ts"), before);
      return new Date();
    };
    const snapshot = new ProjectSnapshotter({ project, now: touchAndRestore }).create();
    assert.equal(readFileSync(join(snapshot.root, "app.ts"), "utf8"), before);
    new ProjectSnapshotter({ project }).discard(snapshot);
  } finally { cleanup(home); }
});

test("a project that changed after the task started is refused, and the copy is never taken", () => {
  const { home, repo, project } = setupRepo();
  try {
    const snapshotter = new ProjectSnapshotter({ project });
    const taskStart = snapshotter.fingerprint();
    writeFileSync(join(repo, "app.ts"), "export const answer = 43;\n");
    assert.equal(codeOf(() => snapshotter.create({ taskId: "task-1", expectedSourceFingerprint: taskStart })), "SNAPSHOT_SOURCE_CHANGED_SINCE_TASK_START");
    const storage = ProjectSnapshotter.storageRoot(project);
    assert.equal(existsSync(storage) ? readdirSync(storage).length : 0, 0, "no copy of either state was left behind");
    // And an unchanged tree gives a copy whose record *is* the task-start state.
    const unchanged = snapshotter.fingerprint();
    const snapshot = snapshotter.create({ taskId: "task-2", expectedSourceFingerprint: unchanged });
    assert.equal(snapshot.manifest.taskStartFingerprint, unchanged);
    assert.equal(snapshot.manifest.sourceFingerprint, unchanged);
    assert.equal(snapshot.manifest.taskId, "task-2");
    assert.equal(snapshot.manifest.lifecycleVersion, 1);
    assert.equal(snapshot.manifest.lease.taskId, "task-2");
    assert.equal(snapshot.manifest.lease.pid, process.pid);
    snapshotter.discard(snapshot);
  } finally { cleanup(home); }
});

test("filenames git can legally report are copied as themselves, never split or reinterpreted", () => {
  const { home, repo, project } = setupRepo();
  try {
    // Every one of these is a legal git path, and three of them are the shapes a newline-parsing
    // implementation would corrupt: a newline split into two paths, a leading dash read as a flag,
    // and whitespace collapsed.
    const names = ["with space.txt", "with\ttab.txt", "-leading-dash.txt", "with\nnewline.txt", "unicode-\u00e9\u4e2d\u6587.txt"];
    for (const name of names) writeFileSync(join(repo, name), `content of ${name}\n`);
    const snapshot = new ProjectSnapshotter({ project }).create();
    for (const name of names) {
      assert.equal(readFileSync(join(snapshot.root, name), "utf8"), `content of ${name}\n`, name);
      assert.equal(snapshot.manifest.entries.filter((entry) => entry.path === name).length, 1, `exactly one entry for ${JSON.stringify(name)}`);
    }
    assert.equal(snapshot.manifest.fileCount >= names.length, true);
    new ProjectSnapshotter({ project }).discard(snapshot);
  } finally { cleanup(home); }
});

test("a credential file is not copied, whatever git thinks of it", () => {
  const { home, repo, project } = setupRepo();
  try {
    // git does not ignore this one, so it is part of the project by git's rules — and it is still a
    // credential file, which is the policy BrainGate's write guard already enforces.
    writeFileSync(join(repo, ".env"), "ANTHROPIC_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345\n");
    writeFileSync(join(repo, "server.key"), "-----BEGIN PRIVATE KEY-----\n");
    writeFileSync(join(repo, "notes.md"), "ordinary project file\n");
    const snapshot = new ProjectSnapshotter({ project }).create();
    assert.equal(existsSync(join(snapshot.root, ".env")), false);
    assert.equal(existsSync(join(snapshot.root, "server.key")), false);
    assert.equal(readFileSync(join(snapshot.root, "notes.md"), "utf8"), "ordinary project file\n");
    const reasons = Object.fromEntries(snapshot.manifest.excludedEntries.map((entry) => [entry.path, entry.reason]));
    assert.equal(reasons[".env"], "sensitive-path");
    assert.equal(reasons["server.key"], "sensitive-path");
    new ProjectSnapshotter({ project }).discard(snapshot);
  } finally { cleanup(home); }
});

test("the sweep removes an orphaned copy, keeps an active one, and refuses to guess about anything else", () => {
  const { home, project, repo } = setupRepo();
  try {
    const snapshotter = new ProjectSnapshotter({ project });
    const root = ProjectSnapshotter.storageRoot(project);
    // An orphan: written as if its process had died an hour ago.
    const old = setOldSnapshot(project, snapshotter.create({ taskId: "task-old" }), 2 * 60 * 60_000);
    // An active one: this process still holds it, and it is fresh anyway.
    const active = snapshotter.create({ taskId: "task-active" });
    // Something BrainGate did not make, in the same directory.
    mkdirSync(join(root, "not-a-snapshot-id"));
    mkdirSync(join(root, "0123456789abcdef0123456789abcdef"));
    // A directory that looks like one but whose metadata is not BrainGate's.
    const stranger = join(root, "abcdefabcdefabcdefabcdefabcdefab");
    mkdirSync(stranger);
    writeFileSync(join(stranger, "manifest.json"), "{\"lifecycleVersion\": 1, \"snapshotId\": \"someone-else\", \"sourceProjectId\": \"other\", \"lease\": {\"pid\": 999999}}");

    const sweep = sweepSnapshots({ project, now: Date.now() + 3 * 60 * 60_000, isTaskFinished: () => true });
    assert.deepEqual([...sweep.removed], [old.id], "the orphan goes");
    assert.equal(existsSync(join(root, old.id)), false);
    assert.equal(existsSync(join(root, active.id)), true, "a live snapshot is never removed");
    assert.equal(existsSync(join(root, "not-a-snapshot-id")), true);
    assert.equal(existsSync(stranger), true, "a directory whose metadata is not ours is left alone");
    assert.equal(sweep.kept.some((entry) => entry.id === active.id && entry.reason === "active"), true);
    assert.deepEqual([...sweep.unrecognised].sort(), ["0123456789abcdef0123456789abcdef", "not-a-snapshot-id", "abcdefabcdefabcdefabcdefabcdefab"].sort());
    // Idempotent: the second sweep has nothing to do.
    const second = sweepSnapshots({ project, now: Date.now() + 3 * 60 * 60_000, isTaskFinished: () => true });
    assert.deepEqual([...second.removed], []);
    snapshotter.discard(active);
  } finally { cleanup(home); }
});

test("the sweep will not follow a symlink out of its root", () => {
  const { home, project } = setupRepo();
  try {
    const root = ProjectSnapshotter.storageRoot(project);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const precious = join(home, "precious");
    mkdirSync(precious);
    writeFileSync(join(precious, "keep.txt"), "do not delete\n");
    // A link named like a snapshot, pointing at a directory outside the root.
    symlinkSync(precious, join(root, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    const sweep = sweepSnapshots({ project, now: Date.now() + 10 * 60 * 60_000, isTaskFinished: () => true });
    assert.deepEqual([...sweep.removed], []);
    assert.equal(existsSync(join(precious, "keep.txt")), true);
    assert.deepEqual([...sweep.unrecognised], ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  } finally { cleanup(home); }
});

test("verification notices a provider that wrote into the snapshot and one that only read", () => {
  const { home, repo, project } = setupRepo();
  try {
    const snapshotter = new ProjectSnapshotter({ project });
    const snapshot = snapshotter.create();
    assert.equal(snapshotter.verify(snapshot), true, "an untouched copy matches its manifest");
    // BrainGate's own control files are expected: the invocation writes a schema and a request.
    writeFileSync(join(snapshot.root, "braingate-request.json"), "{}");
    assert.equal(snapshotter.verify(snapshot), true, "BrainGate's own control files are not project content");
    // Anything else is a boundary violation, whether it is an edit, an addition or a deletion.
    writeFileSync(join(snapshot.root, "app.ts"), "export const answer = 1;\n");
    assert.equal(snapshotter.verify(snapshot), false, "an edited file is caught");
    writeFileSync(join(snapshot.root, "app.ts"), "export const answer = 42;\n");
    assert.equal(snapshotter.verify(snapshot), true);
    writeFileSync(join(snapshot.root, "planted.txt"), "planted\n");
    assert.equal(snapshotter.verify(snapshot), false, "a planted file is caught");
    rmSync(join(snapshot.root, "planted.txt"));
    rmSync(join(snapshot.root, "README.md"));
    assert.equal(snapshotter.verify(snapshot), false, "a deleted file is caught");
    snapshotter.discard(snapshot);
  } finally { cleanup(home); }
});

test("the snapshot is taken from the registered repository and refuses anything else", () => {
  const { home, project } = setupRepo();
  try {
    const empty = { ...project, repositories: [] as string[] };
    assert.equal(codeOf(() => new ProjectSnapshotter({ project: empty }).create()), "SNAPSHOT_REPOSITORY_AMBIGUOUS");
    const two = { ...project, repositories: [project.repositories[0]!, project.repositories[0]!] };
    assert.equal(codeOf(() => new ProjectSnapshotter({ project: two }).create()), "SNAPSHOT_REPOSITORY_AMBIGUOUS");
  } finally { cleanup(home); }
});

test("snapshots live under the project's own storage, never in a system temporary tree", () => {
  const { home, project } = setupRepo();
  try {
    const storage = ProjectSnapshotter.storageRoot(project);
    assert.equal(storage.startsWith(project.storageDir), true);
    assert.equal(storage.startsWith("/tmp") || storage.startsWith("/private/tmp") || storage.startsWith("/var/tmp"), false);
  } finally { cleanup(home); }
});

test("the task-start state recorded before any provider call is the state the copy is taken of", () => {
  const { home, repo, project } = setupRepo();
  try {
    const provider = new ProjectSnapshotProvider(project);
    const taskStart = provider.beginTask({ taskId: "task-1", source: repo });
    assert.equal(existsSync(ProjectSnapshotter.storageRoot(project)), false, "recording the starting state copies nothing");
    // Nothing the provider is asked later changes the answer, while the project stands still.
    const evidence = provider.ensure({ taskId: "task-1", source: repo });
    assert.equal(evidence.sourceFingerprint, taskStart, "the copy is of the state the task started from");
    const manifest = JSON.parse(readFileSync(join(ProjectSnapshotter.storageRoot(project), evidence.snapshotId, "manifest.json"), "utf8")) as { taskStartFingerprint: string; sourceFingerprint: string; taskId: string };
    assert.equal(manifest.taskStartFingerprint, taskStart);
    assert.equal(manifest.sourceFingerprint, taskStart);
    assert.equal(manifest.taskId, "task-1");
    provider.discard("task-1");
    assert.equal(existsSync(ProjectSnapshotter.storageRoot(project)), true, "the root remains; the copy does not");
    assert.equal(readdirSync(ProjectSnapshotter.storageRoot(project)).length, 0);
  } finally { cleanup(home); }
});

test("a project that moved after the task started fails the copy closed when a failover would need it", () => {
  const { home, repo, project } = setupRepo();
  try {
    const provider = new ProjectSnapshotProvider(project);
    const taskStart = provider.beginTask({ taskId: "task-1", source: repo });
    writeFileSync(join(repo, "app.ts"), "export const answer = 43;\n");
    assert.equal(codeOf(() => provider.ensure({ taskId: "task-1", source: repo })), "SNAPSHOT_SOURCE_CHANGED_SINCE_TASK_START");
    // The edit is still there, untouched: refusing is not the same as reverting someone's work.
    assert.equal(readFileSync(join(repo, "app.ts"), "utf8"), "export const answer = 43;\n");
    assert.equal(existsSync(ProjectSnapshotter.storageRoot(project)) ? readdirSync(ProjectSnapshotter.storageRoot(project)).length : 0, 0);
    // And the invariant survives a second attempt rather than drifting to the newer state: the
    // baseline is recorded once per task, so a later caller cannot re-base it onto the moved project
    // and make the change look like the starting state.
    assert.equal(codeOf(() => provider.ensure({ taskId: "task-1", source: repo })), "SNAPSHOT_SOURCE_CHANGED_SINCE_TASK_START");
    assert.equal(provider.beginTask({ taskId: "task-1", source: repo }), taskStart, "a task's starting state is not re-based mid-task");
    provider.discard("task-1");
  } finally { cleanup(home); }
});

test("a change inside an ignored directory does not invalidate the task's project state", () => {
  const { home, repo, project, git } = setupRepo();
  try {
    mkdirSync(join(repo, "node_modules", ".cache"), { recursive: true });
    writeFileSync(join(repo, "node_modules", ".cache", "entry.json"), "{\"v\":1}\n");
    const snapshotter = new ProjectSnapshotter({ project });
    const taskStart = snapshotter.fingerprint();
    const first = snapshotter.create({ taskId: "task-1", expectedSourceFingerprint: taskStart });
    // A build rewriting its own cache while the task runs: the provider never sees this file, so it
    // must not read as "the project changed under the task".
    for (let index = 0; index < 40; index += 1) writeFileSync(join(repo, "node_modules", ".cache", `entry-${String(index)}.json`), "{\"v\":2}\n");
    git(["checkout", "--", "app.ts"]);
    const after = snapshotter.fingerprint();
    assert.equal(after, taskStart, "an ignored tree churning is not a project change");
    const second = snapshotter.create({ taskId: "task-2", expectedSourceFingerprint: taskStart });
    assert.equal(second.manifestHash, first.manifestHash, "and the provider-visible content is identical");
    snapshotter.discard(first);
    snapshotter.discard(second);
  } finally { cleanup(home); }
});

test("a huge ignored tree neither enters the manifest nor defeats the snapshot limits", () => {
  const { home, repo, project } = setupRepo();
  try {
    // 300 ignored files with long names: the shape that would cost real memory if it were enumerated.
    const long = "d".repeat(120);
    for (let index = 0; index < 300; index += 1) {
      mkdirSync(join(repo, "node_modules", long), { recursive: true });
      writeFileSync(join(repo, "node_modules", long, `${String(index)}-${"f".repeat(100)}.js`), "// build output\n");
    }
    const snapshot = new ProjectSnapshotter({ project }).create();
    assert.equal(snapshot.manifest.excludedEntries.some((entry) => entry.path.startsWith("node_modules")), false, "nothing from the ignored tree is listed");
    assert.deepEqual(snapshot.manifest.excludedEntries.map((entry) => entry.path), [".brain/project.json"], "the only exclusion is BrainGate's own state, which is a policy decision");
    assert.equal(snapshot.manifest.entries.some((entry) => entry.path.startsWith("node_modules")), false);
    assert.ok(snapshot.manifest.fileCount < 20, `the manifest describes the project, not the build tree: ${String(snapshot.manifest.fileCount)}`);
    new ProjectSnapshotter({ project }).discard(snapshot);
    // And the metadata cap refuses an enumeration that is itself the attack.
    writeFileSync(join(repo, "many.ts"), "export const x = 1;\n");
    assert.equal(codeOf(() => new ProjectSnapshotter({ project, limits: { maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024, maxPathBytes: 8, maxPathLength: 1_024 } }).create()), "SNAPSHOT_LIMIT_EXCEEDED");
    assert.equal(codeOf(() => new ProjectSnapshotter({ project, limits: { maxFiles: 1, maxFileBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024, maxPathBytes: 1024 * 1024, maxPathLength: 1_024 } }).create()), "SNAPSHOT_LIMIT_EXCEEDED");
  } finally { cleanup(home); }
});

test("the state that can affect the provider's copy is exactly what coherence watches", () => {
  const { home, repo, project } = setupRepo();
  try {
    const snapshotter = new ProjectSnapshotter({ project });
    const baseline = snapshotter.fingerprint();
    // A non-ignored untracked file: it would be in the copy, so it is watched.
    writeFileSync(join(repo, "notes-new.txt"), "new\n");
    const withUntracked = snapshotter.fingerprint();
    assert.notEqual(withUntracked, baseline, "an eligible untracked file is part of the state");
    assert.equal(codeOf(() => snapshotter.create({ taskId: "t", expectedSourceFingerprint: baseline })), "SNAPSHOT_SOURCE_CHANGED_SINCE_TASK_START");
    rmSync(join(repo, "notes-new.txt"));
    // A tracked file's content on disk: also in the copy, also watched.
    writeFileSync(join(repo, "app.ts"), "export const answer = 43;\n");
    assert.notEqual(snapshotter.fingerprint(), baseline, "a dirty tracked file is part of the state");
    // A sensitive-path candidate appearing is watched too — but its bytes never enter the copy, and
    // removing it returns the state to where it was, because it was never part of the content.
    writeFileSync(join(repo, "app.ts"), "export const answer = 42;\n");
    assert.equal(snapshotter.fingerprint(), baseline);
    writeFileSync(join(repo, ".env"), "TOKEN=sk-abcdefghijklmnopqrstuvwxyz012345\n");
    assert.notEqual(snapshotter.fingerprint(), baseline, "a credential file is a policy event, so it is watched");
    const snapshot = snapshotter.create({ taskId: "t2" });
    assert.equal(existsSync(join(snapshot.root, ".env")), false, "and it is still never copied");
    assert.equal(snapshot.manifest.excludedEntries.some((entry) => entry.path === ".env" && entry.reason === "sensitive-path"), true);
    snapshotter.discard(snapshot);
    rmSync(join(repo, ".env"));
    assert.equal(snapshotter.fingerprint(), baseline, "removing the credential file restores the watched state");
  } finally { cleanup(home); }
});
