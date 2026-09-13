import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRegistry, type ProjectId, type RegisteredProject } from "./project-registry.js";
import { checkoutRootOf, identifyCheckout, manifestBinding, requireAttached, resolveAttachment, suggestProjectIdFor } from "./checkout.js";
import { WorkspaceRegistry, canonicalDirectory, gitMetadataFor, workspaceIdFor, workspaceStorageDir } from "./workspace.js";

/**
 * The workspace-attachment invariant.
 *
 * Two ideas, and these tests exist to keep them apart. A **project** is the operator's name for a
 * body of work and owns durable knowledge. A **workspace** is a local directory and owns execution
 * truth. A workspace's identity is its canonical path, and Git is metadata a workspace may have.
 *
 * Both halves matter, and each has been wrong here at a different time. First nothing compared the
 * registered path with the directory the operator was in, so a session could reason about another
 * clone. Then the comparison was made against `git rev-parse --show-toplevel`, so the directory the
 * operator actually chose could not be the workspace at all.
 *
 * Fixtures are disposable directories under the system temp tree, canonicalized at creation, and
 * every git operation is scoped to one of them. No test touches a real project.
 */

/** A scratch directory, already canonical, so no assertion has to know about a symlinked temp root. */
function scratch(label: string): string {
  return mkdtempSync(join(realpathSync.native(tmpdir()), `bg-ws-${label}-`));
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  return String(result.stdout ?? "").trim();
}

function makeRepo(label: string): { readonly root: string; readonly repo: string } {
  const root = scratch(label);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  return { root, repo };
}

/**
 * Writes the manifest `init` writes, binding a project id to a workspace path.
 *
 * The registry returned is a real one, rooted inside the fixture, so the canonicalization that
 * happens on a real load is part of what these tests exercise. A test that needs a registration to
 * exist while a *different* directory is what the operator is standing in uses `registered` instead.
 */
function manifest(
  workspacePath: string,
  input: { readonly projectId?: string; readonly workspace?: string; readonly home?: string } = {},
): { readonly manifestPath: string; readonly registry: ProjectRegistry } {
  const brain = join(workspacePath, ".brain");
  mkdirSync(brain, { recursive: true });
  const manifestPath = join(brain, "project.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    project_id: input.projectId ?? "sample",
    name: "Sample",
    repositories: [input.workspace ?? workspacePath],
  }, null, 2)}\n`);
  return { manifestPath, registry: new ProjectRegistry(input.home ?? join(dirname(workspacePath), "home")) };
}

/**
 * A registry resolving any manifest to one fixed workspace.
 *
 * `ProjectRegistry` refuses a path it has already registered, which is right for one process and
 * wrong here: the test needs a registration to exist while the operator stands somewhere else.
 */
function registered(projectId: string, workspacePath: string | null): { readonly loadFile: (path: string) => RegisteredProject } {
  const repositories = workspacePath === null ? [] : [canonicalDirectory(workspacePath) ?? workspacePath];
  const project = {
    projectId: projectId as ProjectId,
    name: "Sample",
    repositories: Object.freeze(repositories),
    storageDir: join(tmpdir(), "bg-ws-home", "projects", projectId),
  };
  return { loadFile: () => Object.freeze(project) as unknown as RegisteredProject };
}

function attach(cwd: string, registry: { readonly loadFile: (path: string) => RegisteredProject }) {
  return resolveAttachment({ cwd, registry });
}

const esc = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------- the matching case

test("a workspace that matches its registration attaches, and is the directory selected", () => {
  const f = makeRepo("match");
  try {
    const m = manifest(f.repo);
    const attachment = attach(f.repo, m.registry);
    assert.equal(attachment.kind, "attached");
    if (attachment.kind !== "attached") return;
    // Identity is the directory the operator is in — not derived from Git, and not a slug.
    assert.equal(attachment.checkout.root, f.repo);
    assert.equal(attachment.checkout.gitRoot, f.repo);
    assert.equal(attachment.registeredRoot, f.repo);
    assert.equal(attachment.project.projectId, "sample");
    assert.match(attachment.project.storageDir, /projects[/\\]sample$/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a directory bound to another workspace is refused, not attached", () => {
  const first = makeRepo("bound-a");
  const second = makeRepo("bound-b");
  try {
    // The second directory's manifest names the first, which is how a copied clone arrives.
    manifest(second.repo, { workspace: first.repo });
    const attachment = attach(second.repo, registered("sample", first.repo));
    assert.equal(attachment.kind, "refused");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "different-workspace");
    assert.equal(attachment.projectId, "sample");
    assert.equal(attachment.registeredRoot, first.repo);
    assert.match(attachment.message, new RegExp(esc(first.repo)));
    assert.match(attachment.message, new RegExp(esc(second.repo)));
    assert.match(attachment.message, /will not choose between them/);
    assert.match(attachment.message, /init --rebind/);
    assert.match(attachment.message, /--project-id/);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("two clones of one remote are still two workspaces", () => {
  const f = makeRepo("remote");
  const secondRoot = scratch("remote-b");
  try {
    const remoteRoot = join(f.root, "remote");
    mkdirSync(remoteRoot);
    const bare = join(remoteRoot, "origin.git");
    git(remoteRoot, ["init", "-q", "--bare", "-b", "main", bare]);
    git(f.repo, ["remote", "add", "origin", bare]);
    git(f.repo, ["push", "-q", "origin", "main"]);

    const second = join(secondRoot, "repo");
    git(secondRoot, ["clone", "-q", bare, second]);
    assert.equal(git(second, ["remote", "get-url", "origin"]), bare, "fixture premise: one remote");
    assert.equal(git(second, ["rev-parse", "HEAD"]), git(f.repo, ["rev-parse", "HEAD"]), "fixture premise: one commit");

    manifest(second);
    const attachment = attach(second, registered("sample", f.repo));
    assert.equal(attachment.kind, "refused", "a shared remote and commit are not a shared workspace");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "different-workspace");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("an existing registered workspace that is not this one is never used silently", () => {
  const first = makeRepo("other-exists");
  const secondRoot = scratch("other-b");
  try {
    const second = join(secondRoot, "repo");
    mkdirSync(second);
    manifest(second, { workspace: first.repo });
    assert.notEqual(canonicalDirectory(first.repo), null, "fixture premise: the registered workspace exists");

    const attachment = attach(second, registered("sample", first.repo));
    assert.equal(attachment.kind, "refused", "availability is not the question — identity is");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "different-workspace");
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the selected directory

test("a subdirectory is a workspace in its own right, not widened to the repository root", () => {
  const f = makeRepo("subdir");
  try {
    // The shape the correction is about: the operator works inside a directory of a repository.
    const workspace = join(f.repo, "flutter_migration");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "main.dart"), "void main() {}\n");
    const m = manifest(workspace, { home: join(f.root, "home") });
    assert.equal(m.manifestPath, join(workspace, ".brain", "project.json"));

    const attachment = attach(workspace, m.registry);
    assert.equal(attachment.kind, "attached");
    if (attachment.kind !== "attached") return;
    // The workspace is the directory they chose; Git still knows about the repository above it.
    assert.equal(attachment.checkout.root, workspace, "the workspace is the selected directory");
    assert.equal(attachment.checkout.gitRoot, f.repo, "and the repository is metadata");
    assert.notEqual(attachment.checkout.root, attachment.checkout.gitRoot);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("launching deeper finds the manifest above, and the workspace is where they launched", () => {
  const f = makeRepo("deeper");
  try {
    const workspace = join(f.repo, "flutter_migration");
    const nested = join(workspace, "lib", "src");
    mkdirSync(nested, { recursive: true });
    manifest(workspace, { home: join(f.root, "home") });

    // The registration names the directory the manifest sits in — a parent of where they are now.
    const attachment = attach(nested, registered("sample", workspace));
    assert.equal(attachment.kind, "attached");
    if (attachment.kind !== "attached") return;
    assert.equal(attachment.registeredRoot, workspace);
    // Attaching is right, and the workspace is still the directory they are standing in, because
    // that is where a native CLI has to run.
    assert.equal(attachment.checkout.root, nested, "a registration of a parent never widens the workspace");
    assert.equal(attachment.checkout.manifestPath, join(workspace, ".brain", "project.json"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a symlinked path to a workspace is the same workspace", () => {
  const f = makeRepo("symlink");
  try {
    const link = join(f.root, "linked");
    symlinkSync(f.repo, link);
    const m = manifest(f.repo, { home: join(f.root, "home") });
    const attachment = attach(link, m.registry);
    assert.equal(attachment.kind, "attached");
    if (attachment.kind !== "attached") return;
    assert.equal(attachment.checkout.root, f.repo, "the identity is canonical");
    assert.notEqual(attachment.checkout.root, link, "and never the link that reached it");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- a workspace without Git

test("a plain directory is a workspace — Git is a capability, not a requirement", () => {
  const root = scratch("nogit");
  try {
    const workspace = join(root, "plain-app");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "app.py"), "print('hello')\n");

    assert.equal(checkoutRootOf(workspace), null, "fixture premise: no repository above it");
    const m = manifest(workspace, { home: join(root, "home") });
    const attachment = attach(workspace, m.registry);
    assert.equal(attachment.kind, "attached", "a directory with no repository is still a workspace");
    if (attachment.kind !== "attached") return;
    assert.equal(attachment.checkout.root, workspace);
    assert.equal(attachment.checkout.gitRoot, null, "and no git metadata is not an error");

    const record = new WorkspaceRegistry(join(root, "state")).register({ projectId: "sample", path: workspace });
    assert.equal(record.path, workspace);
    assert.equal(record.git, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("git metadata is evidence, and an unborn branch is a state rather than a failure", () => {
  const root = scratch("meta");
  try {
    const repo = join(root, "fresh");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    const metadata = gitMetadataFor(repo);
    assert.notEqual(metadata, null);
    if (metadata === null) return;
    assert.equal(metadata.gitRoot, repo);
    assert.equal(metadata.branch, "main");
    assert.equal(metadata.head, null, "an unborn branch has no HEAD");
    assert.equal(metadata.remote, null, "and no remote is a state too");
    assert.equal(metadata.dirty, false, "an empty repository is clean");
    const plain = join(root, "plain");
    mkdirSync(plain);
    assert.equal(gitMetadataFor(plain), null, "and a directory outside any repository reports none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- missing and unusable

test("a registration whose workspace is missing is refused with a way forward", () => {
  const root = scratch("missing");
  try {
    const workspace = join(root, "repo");
    mkdirSync(workspace);
    manifest(workspace, { workspace: join(root, "gone"), home: join(root, "home") });
    const attachment = attach(workspace, new ProjectRegistry(join(root, "home")));
    assert.equal(attachment.kind, "refused");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "registered-workspace-missing");
    assert.equal(attachment.projectId, "sample", "the project is still nameable on the failure path");
    assert.match(attachment.message, /not usable right now/);
    assert.match(attachment.message, /init --rebind/);
    assert.match(attachment.message, new RegExp(esc(workspace)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a registration naming a path that is not a directory is refused as that", () => {
  const root = scratch("notdir");
  try {
    const workspace = join(root, "repo");
    mkdirSync(workspace);
    const file = join(root, "a-file");
    writeFileSync(file, "not a directory\n");
    manifest(workspace, { home: join(root, "home") });
    const attachment = attach(workspace, registered("sample", file));
    assert.equal(attachment.kind, "refused");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "registered-path-not-a-directory");
    assert.match(attachment.message, /no longer usable/);
    assert.match(attachment.message, new RegExp(esc(file)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a registration naming no workspace at all is refused as nothing to execute against", () => {
  const root = scratch("empty");
  try {
    const workspace = join(root, "repo");
    mkdirSync(workspace);
    manifest(workspace, { home: join(root, "home") });
    const attachment = attach(workspace, registered("sample", null));
    assert.equal(attachment.kind, "refused");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "registered-workspace-missing");
    assert.equal(attachment.registeredRoot, null);
    assert.match(attachment.message, /names no repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- first run, identification

test("a manifest the operator named themselves is inspection, not an attachment", () => {
  const f = makeRepo("inspect");
  const elsewhere = scratch("inspect-cwd");
  try {
    manifest(f.repo, { home: join(f.root, "home") });
    const attachment = resolveAttachment({
      cwd: elsewhere,
      registry: { loadFile: (path) => new ProjectRegistry(join(f.root, "home")).loadFile(path) },
      manifest: join(f.repo, ".brain", "project.json"),
      namedByOperator: true,
    });
    assert.equal(attachment.kind, "inspecting", "reading another workspace's record is what --project is for");
    if (attachment.kind !== "inspecting") return;
    // Nothing may execute against where they happen to be standing: the workspace is the registered one.
    assert.equal(attachment.registeredRoot, f.repo);
    assert.equal(attachment.checkout.root, canonicalDirectory(elsewhere));
    assert.equal(requireAttached(attachment).projectId, "sample");

    // The same call without the flag is the copied-registration case, and is still refused: there the
    // manifest was found by walking up, so it is a claim about the directory they are standing in.
    const walked = resolveAttachment({ cwd: elsewhere, registry: { loadFile: (path) => new ProjectRegistry(join(f.root, "home")).loadFile(path) }, manifest: join(f.repo, ".brain", "project.json") });
    assert.equal(walked.kind, "refused");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a directory with no manifest anywhere is a first run, not a refusal", () => {
  const root = scratch("first");
  try {
    const workspace = join(root, "fresh");
    mkdirSync(workspace);
    const attachment = attach(workspace, new ProjectRegistry(join(root, "home")));
    assert.equal(attachment.kind, "unregistered");
    if (attachment.kind !== "unregistered") return;
    assert.equal(attachment.checkout.root, workspace);
    assert.equal(attachment.checkout.manifestPath, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("identifying a workspace needs no manifest, no repository and no project", () => {
  const root = scratch("identify");
  try {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const identified = identifyCheckout(plain);
    assert.equal(identified.root, plain);
    assert.equal(identified.gitRoot, null);
    assert.equal(identified.manifestPath, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("checkoutRootOf still answers the git question, and answers null when there is none", () => {
  const f = makeRepo("gitroot");
  const root = scratch("plain-root");
  try {
    const nested = join(f.repo, "pkg");
    mkdirSync(nested);
    assert.equal(checkoutRootOf(nested), f.repo, "the repository above a subdirectory");
    const plain = join(root, "plain");
    mkdirSync(plain);
    assert.equal(checkoutRootOf(plain), null, "and nothing above a directory that has none");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second directory is offered its own name rather than sharing one", () => {
  const taken = new Set(["repo", "tabaq-ai-tabaqai-31aug-fixed-issues"]);
  const suggestion = suggestProjectIdFor("/Volumes/Lexar/Tabaq-ai-TabaqAi_31Aug_fixed_issues", (candidate) => taken.has(candidate));
  assert.notEqual(suggestion, null);
  assert.match(suggestion!, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
  assert.match(suggestion!, /lexar$/, "a parent's name disambiguates two clones better than a number");

  const busy = new Set(["repo", "repo-a"]);
  assert.match(suggestProjectIdFor("/a/repo", (candidate) => busy.has(candidate))!, /^repo-\d+$/);
  assert.equal(suggestProjectIdFor("/a/repo", () => true), null, "it says so rather than inventing a colliding name");
});

test("the binding a manifest records is readable without resolving a project handle", () => {
  const f = makeRepo("binding");
  try {
    const m = manifest(f.repo, { home: join(f.root, "home") });
    const binding = manifestBinding(m.manifestPath);
    assert.equal(binding.projectId, "sample");
    assert.equal(binding.registeredRoot, f.repo);
    assert.equal(binding.manifestRoot, f.repo);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- workspaces of one project

test("two workspaces of one project have two ids, two storage roots and no shared state file", () => {
  const f = makeRepo("two-ws");
  const secondRoot = scratch("two-b");
  try {
    const second = join(secondRoot, "repo");
    mkdirSync(second);
    const state = join(f.root, "state");
    const workspaces = new WorkspaceRegistry(state);
    const a = workspaces.register({ projectId: "tabaq", path: f.repo });
    const b = workspaces.register({ projectId: "tabaq", path: second });

    assert.notEqual(a.workspaceId, b.workspaceId, "one project, two workspaces, two identities");
    assert.equal(a.projectId, b.projectId, "and one logical project");
    assert.notEqual(workspaceStorageDir(state, a.workspaceId), workspaceStorageDir(state, b.workspaceId));
    assert.notEqual(a.git, null);
    assert.equal(a.git?.gitRoot, f.repo);
    assert.equal(b.git, null);
    // Registration is idempotent on the path, so attaching twice cannot mint a second identity.
    assert.equal(workspaces.register({ projectId: "tabaq", path: f.repo }).workspaceId, a.workspaceId);
    assert.equal(workspaces.list().length, 2);
    assert.notEqual(workspaces.findByPath(f.repo), null);
    assert.equal(workspaces.find(a.workspaceId)?.path, f.repo);

    assert.equal(new WorkspaceRegistry(state).list().length, 2, "and the registry survives a reopen");
    const document = JSON.parse(readFileSync(join(state, "workspaces.json"), "utf8")) as { schemaVersion: number; workspaces: unknown[] };
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.workspaces.length, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("legacy project state written when a slug was the identity is never touched", () => {
  // `<home>/projects/<id>` holds a real project's ledger, goals and dogfood corpus from a release
  // whose identity was a slug. Two directories with that slug wrote one of these, so the state in it
  // belongs to a workspace nobody can identify any more. Preserved read-only: not moved, not
  // rewritten, not deleted, and never adopted as a workspace on a guess.
  const root = scratch("legacy");
  try {
    const workspace = join(root, "repo");
    mkdirSync(workspace);
    const legacy = join(root, "brain-home", "projects", "flutter-migration");
    mkdirSync(legacy, { recursive: true });
    const state = join(legacy, "ledger.sqlite");
    writeFileSync(state, "legacy bytes that must not change\n");

    const registered = new WorkspaceRegistry(legacy).register({ projectId: "flutter-migration", path: workspace });
    assert.equal(registered.path, workspace, "the workspace is the directory that was selected");
    assert.equal(readFileSync(state, "utf8"), "legacy bytes that must not change\n");
    // The registry is the only thing written here, and it is new state rather than a rewrite of old:
    // nothing that existed was opened, moved or removed.
    assert.ok(existsSync(state));
    assert.equal(new WorkspaceRegistry(legacy).find(registered.workspaceId)?.path, workspace);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a workspace id is derived from the path, so every process agrees without a registry", () => {
  assert.equal(workspaceIdFor("/a/b"), workspaceIdFor("/a/b"));
  assert.notEqual(workspaceIdFor("/a/b"), workspaceIdFor("/a/c"));
  assert.match(workspaceIdFor("/a/b"), /^[0-9a-f]{16}$/);
});

test("a workspace on a volume that is gone is still listed, so a message can name it", () => {
  const root = scratch("gone");
  try {
    const state = join(root, "state");
    const missing = join(root, "not-there");
    mkdirSync(missing);
    new WorkspaceRegistry(state).register({ projectId: "p", path: missing });
    rmSync(missing, { recursive: true, force: true });
    const reopened = new WorkspaceRegistry(state).list();
    assert.equal(reopened.length, 1, "the record survives its directory");
    assert.equal(reopened[0]?.path, missing);
    assert.equal(reopened[0]?.label, basename(missing));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("registering a path that is not a directory is refused rather than recorded", () => {
  const root = scratch("bad");
  try {
    const workspaces = new WorkspaceRegistry(join(root, "state"));
    const file = join(root, "file");
    writeFileSync(file, "x\n");
    assert.throws(() => workspaces.register({ projectId: "p", path: file }), /existing directory/);
    assert.throws(() => workspaces.register({ projectId: "p", path: join(root, "absent") }), /existing directory/);
    assert.equal(workspaces.list().length, 0, "and nothing was written");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
