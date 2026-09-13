import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRegistry } from "./project-registry.js";
import { checkoutRootOf, identifyCheckout, manifestBinding, resolveAttachment, suggestProjectIdFor } from "./checkout.js";

/**
 * The checkout-attachment invariant.
 *
 * Two clones of one repository are two checkouts, and the defect this file pins down is that nothing
 * ever said so: identity was a slug, two clones could carry the same slug, and a session could reason
 * about a checkout the operator was not in. Every case below is written from the operator's side —
 * where they launched from, what was registered, and what BrainGate is allowed to do about it.
 *
 * A fixture lives under the operator's home rather than a temp tree so that `git` sees the same
 * filesystem the product does; the registry itself is a fresh directory per test.
 */

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  return String(result.stdout ?? "").trim();
}

/** A repository with a manifest that registers it under `projectId`. */
function registeredRepo(label: string, input: { readonly projectId?: string; readonly repositories?: readonly string[] } = {}): { readonly root: string; readonly repo: string; readonly manifestPath: string; readonly registry: ProjectRegistry } {
  const root = mkdtempSync(join(tmpdir(), `braingate-attach-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);

  mkdirSync(join(repo, ".brain"));
  const manifestPath = join(repo, ".brain", "project.json");
  writeFileSync(manifestPath, JSON.stringify({
    project_id: input.projectId ?? "sample",
    name: "Sample",
    repositories: input.repositories ?? [".."],
  }, null, 2));
  const registry = new ProjectRegistry(join(root, "home"));
  return { root, repo, manifestPath, registry };
}

/**
 * A registry that resolves a manifest the way the real one does, but without its in-memory map.
 *
 * `ProjectRegistry` refuses to register a repo it has already seen, which is right for one process
 * and wrong for this fixture: a test needs the *registration* to exist while a *different* checkout is
 * what the operator is standing in, and a stale in-memory mapping would resolve the wrong one.
 */
function pointingAt(projectId: string, root: string): { readonly loadFile: (path: string) => never } {
  return Object.freeze({
    loadFile: (): never => {
      const registered = Object.freeze({
        projectId: projectId as never,
        name: "Sample",
        repositories: Object.freeze([root]),
        storageDir: join(tmpdir(), "braingate-attach-storage", projectId),
        [Symbol.for("braingate.registered-project")]: true,
      });
      return registered as never;
    },
  });
}

function attach(cwd: string, registry: ProjectRegistry | ReturnType<typeof pointingAt>) {
  return resolveAttachment({ cwd, registry: { loadFile: (path) => registry.loadFile(path) } });
}

// ---------------------------------------------------------------- A. the matching case

test("A: a checkout that matches its registration attaches", () => {
  const f = registeredRepo("match");
  try {
    const attachment = attach(f.repo, f.registry);
    assert.equal(attachment.kind, "attached");
    if (attachment.kind !== "attached") return;
    assert.equal(attachment.checkout.root, checkoutRootOf(f.repo));
    assert.equal(attachment.registeredRoot, attachment.checkout.root);
    assert.equal(attachment.project.projectId, "sample");
    // The storage the session will use is inside the operator's home; the repository is theirs.
    assert.match(attachment.project.storageDir, /projects[/\\]sample$/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- B. two clones, one basename

test("B: a second clone with the same basename and the same project id is refused, not attached", () => {
  // The exact real-world shape: two clones of one repository, on two volumes, both initialised so
  // that both manifests carry the same project id. Nothing about a basename or a slug makes these
  // interchangeable — they hold different uncommitted state.
  const first = registeredRepo("clone-a");
  const secondRoot = mkdtempSync(join(tmpdir(), "braingate-attach-clone-b-"));
  try {
    // The second clone is a *copy* of the first, so every shared fact is genuinely shared: the same
    // basename, the same commit, the same manifest, therefore the same project id.
    const second = join(secondRoot, "repo");
    mkdirSync(second);
    git(second, ["init", "-q", "-b", "main"]);
    git(second, ["config", "user.email", "test@example.invalid"]);
    git(second, ["config", "user.name", "BrainGate Test"]);
    writeFileSync(join(second, "a.txt"), "a different working state\n");
    mkdirSync(join(second, ".brain"));
    writeFileSync(join(second, ".brain", "project.json"), JSON.stringify({ project_id: "sample", name: "Sample", repositories: [".."] }));

    // The registration points at the first clone; the operator is standing in the second.
    const attachment = attach(second, pointingAt("sample", first.repo));
    assert.equal(attachment.kind, "refused");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "different-checkout");
    assert.equal(attachment.projectId, "sample");
    // Both paths are named, so the operator can see which two directories are in conflict.
    assert.match(attachment.message, new RegExp(first.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(attachment.message, new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(attachment.message, /two local checkouts/);
    assert.match(attachment.message, /init --rebind/);
    assert.match(attachment.message, /--project-id/);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- C. same remote, different checkout

test("C: two clones of one remote are still two checkouts", () => {
  const f = registeredRepo("remote");
  const secondRoot = mkdtempSync(join(tmpdir(), "braingate-attach-remote-b-"));
  try {
    // The remote lives outside the clone, so the two checkouts share it without sharing a directory.
    const remoteRoot = join(f.root, "remote");
    mkdirSync(remoteRoot);
    const bare = join(remoteRoot, "origin.git");
    git(remoteRoot, ["init", "-q", "--bare", "-b", "main", bare]);
    git(f.repo, ["remote", "add", "origin", bare]);
    git(f.repo, ["push", "-q", "origin", "main"]);

    // A genuine second clone, from the same remote, with the same commit checked out.
    const second = join(secondRoot, "repo");
    git(secondRoot, ["clone", "-q", bare, second]);
    git(second, ["config", "user.email", "test@example.invalid"]);
    git(second, ["config", "user.name", "BrainGate Test"]);
    mkdirSync(join(second, ".brain"));
    writeFileSync(join(second, ".brain", "project.json"), JSON.stringify({ project_id: "sample", name: "Sample", repositories: [".."] }));

    assert.equal(git(second, ["remote", "get-url", "origin"]), bare, "fixture premise: the same remote");
    assert.equal(git(second, ["rev-parse", "HEAD"]), git(f.repo, ["rev-parse", "HEAD"]), "fixture premise: the same commit");

    const attachment = attach(second, pointingAt("sample", f.repo));
    assert.equal(attachment.kind, "refused", "a shared remote is not a shared checkout");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "different-checkout");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- D. launching from a subdirectory

test("D: launching from a subdirectory attaches to the repository root, not the subdirectory", () => {
  const f = registeredRepo("subdir");
  try {
    const nested = join(f.repo, "flutter_migration", "tabaq_app_clean");
    mkdirSync(nested, { recursive: true });

    const attachment = attach(nested, f.registry);
    assert.equal(attachment.kind, "attached", "the manifest is found upward, as git finds its root");
    if (attachment.kind !== "attached") return;
    assert.equal(attachment.checkout.root, checkoutRootOf(f.repo));
    assert.notEqual(attachment.checkout.root, nested, "the checkout is the repository, not the directory launched from");
    // And the manifest found is the one at the root, not a second one beside the subdirectory.
    assert.equal(attachment.checkout.manifestPath, f.manifestPath);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- E. symlinks

test("E: a symlinked path to the same checkout is the same checkout", () => {
  const f = registeredRepo("symlink");
  try {
    const link = join(f.root, "linked-repo");
    symlinkSync(f.repo, link);
    // The registered root is the canonical one; the operator arrives through a link to it.
    const attachment = attach(link, f.registry);
    assert.equal(attachment.kind, "attached", "a canonical path and its symlink are one checkout");
    if (attachment.kind !== "attached") return;
    assert.equal(attachment.checkout.root, checkoutRootOf(f.repo));
    assert.doesNotMatch(attachment.checkout.root, /linked-repo/, "the identity is the canonical path");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("E: a registration written through a symlink still matches the canonical checkout", () => {
  // The registry canonicalizes what a manifest names, so a manifest that pointed at a link and a
  // checkout reached by its real path are not falsely different.
  const f = registeredRepo("symlink-registered");
  try {
    const link = join(f.root, "alias");
    symlinkSync(f.repo, link);
    const registry = new ProjectRegistry(join(f.root, "home2"));
    // Absolute path through the link, rather than "..", so the registry is the thing canonicalizing.
    writeFileSync(f.manifestPath, JSON.stringify({ project_id: "sample", name: "Sample", repositories: [link] }));
    const attachment = attach(f.repo, registry);
    assert.equal(attachment.kind, "attached");
    if (attachment.kind !== "attached") return;
    assert.equal(attachment.registeredRoot, checkoutRootOf(f.repo));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- F. the registered checkout is gone

test("F: a registration whose checkout is missing is refused with a way forward", () => {
  const f = registeredRepo("missing");
  const secondRoot = mkdtempSync(join(tmpdir(), "braingate-attach-missing-b-"));
  try {
    // A manifest that names a directory which does not exist: an unmounted volume looks exactly like
    // this, and so does a directory that was moved.
    const elsewhere = join(secondRoot, "repo");
    mkdirSync(elsewhere);
    git(elsewhere, ["init", "-q", "-b", "main"]);
    mkdirSync(join(elsewhere, ".brain"));
    writeFileSync(join(elsewhere, ".brain", "project.json"), JSON.stringify({
      project_id: "sample", name: "Sample", repositories: [join(f.root, "gone")],
    }));

    const attachment = attach(elsewhere, new ProjectRegistry(join(secondRoot, "home")));
    assert.equal(attachment.kind, "refused");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "registered-checkout-missing");
    assert.match(attachment.message, /not usable right now/);
    // The path that is gone is named, and so is the one the operator is in: the remedy acts on both.
    assert.match(attachment.message, new RegExp(join("gone").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(attachment.message, /init --rebind/);
    // Nothing was executed there, and the current checkout is named so the choice is informed.
    assert.match(attachment.message, new RegExp(elsewhere.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("F: a registered path that exists but is no longer a repository is refused as that", () => {
  const f = registeredRepo("not-a-repo");
  const secondRoot = mkdtempSync(join(tmpdir(), "braingate-attach-notrepo-b-"));
  try {
    const plain = join(f.root, "plain-directory");
    mkdirSync(plain);
    const elsewhere = join(secondRoot, "repo");
    mkdirSync(elsewhere);
    git(elsewhere, ["init", "-q", "-b", "main"]);
    mkdirSync(join(elsewhere, ".brain"));
    writeFileSync(join(elsewhere, ".brain", "project.json"), JSON.stringify({
      project_id: "sample", name: "Sample", repositories: [plain],
    }));

    const attachment = attach(elsewhere, f.registry);
    assert.equal(attachment.kind, "refused");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "registered-path-not-a-repository");
    assert.match(attachment.message, /no longer a git checkout/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- G. the registered checkout exists but is another

test("G: an existing registered checkout that is not this one is never used silently", () => {
  const f = registeredRepo("other-exists");
  const secondRoot = mkdtempSync(join(tmpdir(), "braingate-attach-other-b-"));
  try {
    // Both clones exist and are perfectly usable. The refusal is not about availability.
    const second = join(secondRoot, "repo");
    mkdirSync(second);
    git(second, ["init", "-q", "-b", "main"]);
    mkdirSync(join(second, ".brain"));
    writeFileSync(join(second, ".brain", "project.json"), JSON.stringify({ project_id: "sample", name: "Sample", repositories: [".."] }));
    assert.equal(existsSync(f.repo), true, "fixture premise: the registered checkout is present");

    const attachment = attach(second, pointingAt("sample", f.repo));
    assert.equal(attachment.kind, "refused");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "different-checkout");
    // The message tells the operator both directories and both remedies, and never picks for them.
    assert.match(attachment.message, /will not choose between them/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- first run, and the not-a-repository case

test("a directory with no manifest anywhere is a first run, not a refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-attach-first-"));
  try {
    const repo = join(root, "fresh");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    const attachment = attach(repo, new ProjectRegistry(join(root, "home")));
    assert.equal(attachment.kind, "unregistered");
    if (attachment.kind !== "unregistered") return;
    assert.equal(attachment.checkout.root, checkoutRootOf(repo));
    assert.equal(attachment.checkout.manifestPath, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a directory that is not a repository cannot attach, and says so", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-attach-norepo-"));
  try {
    const plain = join(root, "plain");
    mkdirSync(plain);
    mkdirSync(join(plain, ".brain"));
    writeFileSync(join(plain, ".brain", "project.json"), JSON.stringify({ project_id: "sample", name: "Sample", repositories: [".."] }));
    const attachment = attach(plain, new ProjectRegistry(join(root, "home")));
    assert.equal(attachment.kind, "refused");
    if (attachment.kind !== "refused") return;
    assert.equal(attachment.reason, "not-a-repository");
    assert.match(attachment.message, /not inside a git repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- naming a second checkout

test("a second checkout is offered its own name rather than sharing one", () => {
  const taken = new Set(["repo", "repo-downloads"]);
  const suggestion = suggestProjectIdFor("/Volumes/Lexar/Tabaq-ai-TabaqAi_31Aug_fixed_issues", (candidate) => taken.has(candidate));
  // The basename is taken, the parent disambiguates, and the slug stays inside the id grammar.
  assert.equal(suggestion, "tabaq-ai-tabaqai-31aug-fixed-issues");
  assert.match(suggestion!, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
  // When the descriptive names are taken, a numbered one is offered rather than nothing.
  const busy = new Set(["repo", "repo-a"]);
  const numbered = suggestProjectIdFor("/a/repo", (candidate) => busy.has(candidate));
  assert.match(numbered!, /^repo-\d+$/, "a numbered name is offered when the descriptive ones are taken");
  // And when every candidate is taken, it says so rather than inventing a name that would collide.
  assert.equal(suggestProjectIdFor("/a/repo", () => true), null);
  assert.equal(suggestProjectIdFor("/", () => false), null, "a path with no usable name suggests nothing");
});

test("the binding a manifest records is readable without resolving a project handle", () => {
  const f = registeredRepo("binding");
  try {
    const binding = manifestBinding(f.manifestPath);
    assert.equal(binding.projectId, "sample");
    assert.equal(binding.registeredRoot, checkoutRootOf(f.repo));
    assert.equal(binding.manifestRoot, f.repo);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("identifying a checkout does not need a manifest to exist", () => {
  const f = registeredRepo("identify");
  try {
    const checkout = identifyCheckout(f.repo);
    assert.equal(checkout.root, checkoutRootOf(f.repo));
    assert.equal(checkout.manifestPath, f.manifestPath);
    // And a subdirectory reports the same root, which is what makes a session launched anywhere work.
    const nested = join(f.repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    assert.equal(identifyCheckout(nested).root, checkout.root);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
