import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_MANIFEST, findManifest } from "./manifest-path.js";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "braingate-manifest-"));
  const repo = join(root, "monorepo");
  const nested = join(repo, "apps", "flutter_migration");
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(repo, ".brain"), { recursive: true });
  writeFileSync(join(repo, ".brain", "project.json"), JSON.stringify({ project_id: "monorepo", name: "Monorepo", repositories: [".."] }));
  return { root, repo, nested };
}

test("the manifest is found from a subdirectory, the way git works from one", () => {
  const { repo, nested } = tree();
  // init writes at the repository root; running below it must still find the project rather
  // than offer to register a second one.
  assert.equal(findManifest(nested), resolve(repo, DEFAULT_MANIFEST));
  assert.equal(findManifest(repo), resolve(repo, DEFAULT_MANIFEST));
});

test("with no manifest anywhere above, the current directory is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-manifest-none-"));
  const where = join(root, "somewhere");
  mkdirSync(where, { recursive: true });
  // The caller then says "no project here", naming the path the operator would expect.
  assert.equal(findManifest(where), resolve(where, DEFAULT_MANIFEST));
});

test("an explicit --project path is used exactly as given, never searched for", () => {
  const { repo, nested } = tree();
  // A caller naming a manifest must get that manifest or a clear failure, not a different one
  // discovered further up.
  assert.equal(findManifest(nested, "other/place.json"), resolve(nested, "other/place.json"));
  assert.equal(findManifest(nested, join(repo, "elsewhere.json")), join(repo, "elsewhere.json"));
});

test("the search stops at the filesystem root instead of looping", () => {
  // dirname("/") returns "/", so a naive walk never terminates.
  assert.equal(findManifest("/"), resolve("/", DEFAULT_MANIFEST));
});
