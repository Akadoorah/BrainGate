import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrainGateInvariantError, ProjectRegistry, parseProjectConfig } from "./index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "braingate-projects-"));
}

test("registry isolates project identities and storage", () => {
  const root = tempRoot();
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  mkdirSync(repoA);
  mkdirSync(repoB);

  const registry = new ProjectRegistry(join(root, "state"));
  const a = registry.register(parseProjectConfig({ project_id: "waslo", name: "Waslo", repositories: [repoA] }));
  const b = registry.register(parseProjectConfig({ project_id: "tabaq", name: "Tabaq", repositories: [repoB] }));

  assert.notEqual(a.storageDir, b.storageDir);
  assert.equal(registry.get("waslo")?.name, "Waslo");
  assert.equal(registry.get("tabaq")?.name, "Tabaq");
  assert.equal(registry.resolveRepository(repoA)?.projectId, "waslo");
  assert.equal(registry.resolveRepository(repoB)?.projectId, "tabaq");
  assert.equal(registry.resolveRepository(join(root, "missing")), undefined);
});

test("registry fails closed on duplicate project ids and repository mappings", () => {
  const root = tempRoot();
  const repo = join(root, "repo");
  const other = join(root, "other");
  mkdirSync(repo);
  mkdirSync(other);
  const registry = new ProjectRegistry(join(root, "state"));
  registry.register(parseProjectConfig({ project_id: "waslo", name: "Waslo", repositories: [repo] }));

  assert.throws(
    () => registry.register(parseProjectConfig({ project_id: "waslo", name: "Duplicate", repositories: [other] })),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "PROJECT_ID_CONFLICT",
  );
  assert.throws(
    () => registry.register(parseProjectConfig({ project_id: "other", name: "Other", repositories: [repo] })),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "PROJECT_REPOSITORY_CONFLICT",
  );
});

test("project lookup is exact and never fuzzy", () => {
  const root = tempRoot();
  const repo = join(root, "repo");
  mkdirSync(repo);
  const registry = new ProjectRegistry(join(root, "state"));
  registry.register(parseProjectConfig({ project_id: "saudigpt", name: "SaudiGPT", repositories: [repo] }));

  assert.equal(registry.get("saudigpt")?.name, "SaudiGPT");
  assert.equal(registry.get("saudi-gpt"), undefined);
  assert.throws(() => registry.get("SaudiGPT"), (error: unknown) => error instanceof BrainGateInvariantError);
});

test("symlink aliases cannot map one repository to two projects", async (t) => {
  const root = tempRoot();
  const repo = join(root, "repo");
  const alias = join(root, "repo-alias");
  mkdirSync(repo);
  const { symlinkSync } = await import("node:fs");
  try {
    symlinkSync(repo, alias, "dir");
  } catch {
    t.skip("symlinks are unavailable in this environment");
    return;
  }

  const registry = new ProjectRegistry(join(root, "state"));
  registry.register(parseProjectConfig({ project_id: "one", name: "One", repositories: [repo] }));
  assert.throws(
    () => registry.register(parseProjectConfig({ project_id: "two", name: "Two", repositories: [alias] })),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "PROJECT_REPOSITORY_CONFLICT",
  );
});
