import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import { MAX_ARTIFACTS_PER_TASK, collectArtifacts, parseArtifactDeclarations } from "./artifact-collector.js";

/** Asserts on the invariant code rather than the message, which is prose and will be reworded. */
function refuses(code: string) {
  return (error: unknown): boolean => error instanceof BrainGateInvariantError && error.code === code;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "braingate-artifacts-"));
  const worktree = join(root, "worktree");
  const providerHome = join(root, "provider-home");
  mkdirSync(worktree); mkdirSync(providerHome);
  return { root, worktree, providerHome };
}

test("a declared artifact is copied into the worktree and reported with its hash", () => {
  const { worktree, providerHome } = workspace();
  const source = join(providerHome, "generated.png");
  writeFileSync(source, PNG);

  const collected = collectArtifacts({ worktreePath: worktree, declarations: [{ sourcePath: source, destination: "assets/hero.png" }] });
  assert.equal(collected.length, 1);
  assert.equal(collected[0]!.path, "assets/hero.png");
  assert.equal(collected[0]!.mediaType, "image/png");
  assert.equal(collected[0]!.bytes, PNG.length);
  assert.match(collected[0]!.sha256, /^[0-9a-f]{64}$/);
  // The point of collecting is that the bytes end up inside the boundary, not merely described.
  assert.deepEqual(readFileSync(join(worktree, "assets", "hero.png")), PNG);
});

test("a destination outside the worktree is refused", () => {
  const { worktree, providerHome } = workspace();
  const source = join(providerHome, "generated.png");
  writeFileSync(source, PNG);
  for (const destination of ["../escaped.png", "../../etc/planted.png", "/tmp/absolute.png"]) {
    assert.throws(
      () => collectArtifacts({ worktreePath: worktree, declarations: [{ sourcePath: source, destination }] }),
      refuses("ARTIFACT_DESTINATION_DENIED"),
      `destination should have been refused: ${destination}`,
    );
  }
});

test("media type is decided by content, not by the name the provider chose", () => {
  const { worktree, providerHome } = workspace();
  // Named .png, actually a JPEG: the content wins, so the receipt cannot be misled by a name.
  const mislabelled = join(providerHome, "actually-jpeg.png");
  writeFileSync(mislabelled, JPEG);
  const collected = collectArtifacts({ worktreePath: worktree, declarations: [{ sourcePath: mislabelled, destination: "a.png" }] });
  assert.equal(collected[0]!.mediaType, "image/jpeg");

  // Named .png, actually a script: refused outright.
  const script = join(providerHome, "payload.png");
  writeFileSync(script, "#!/bin/sh\necho planted\n");
  assert.throws(() => collectArtifacts({ worktreePath: worktree, declarations: [{ sourcePath: script, destination: "b.png" }] }), refuses("ARTIFACT_MEDIA_TYPE_DENIED"));
});

test("a symlinked source cannot stand in for a file elsewhere on the machine", () => {
  const { root, worktree, providerHome } = workspace();
  const real = join(root, "private.png");
  writeFileSync(real, PNG);
  const link = join(providerHome, "link.png");
  symlinkSync(real, link);
  assert.throws(() => collectArtifacts({ worktreePath: worktree, declarations: [{ sourcePath: link, destination: "x.png" }] }), refuses("ARTIFACT_NOT_A_FILE"));
});

test("an artifact the provider declared but did not produce fails the task", () => {
  const { worktree, providerHome } = workspace();
  // Silence here would mean reporting success while the thing the task was for is missing.
  assert.throws(
    () => collectArtifacts({ worktreePath: worktree, declarations: [{ sourcePath: join(providerHome, "never-written.png"), destination: "x.png" }] }),
    refuses("ARTIFACT_MISSING"),
  );
});

test("count and duplicate destinations are bounded", () => {
  const { worktree, providerHome } = workspace();
  const source = join(providerHome, "g.png");
  writeFileSync(source, PNG);

  const many = Array.from({ length: MAX_ARTIFACTS_PER_TASK + 1 }, (_unused, index) => ({ sourcePath: source, destination: `a${String(index)}.png` }));
  assert.throws(() => collectArtifacts({ worktreePath: worktree, declarations: many }), refuses("ARTIFACT_COUNT_EXCEEDED"));

  assert.throws(
    () => collectArtifacts({ worktreePath: worktree, declarations: [{ sourcePath: source, destination: "same.png" }, { sourcePath: source, destination: "./same.png" }] }),
    refuses("ARTIFACT_DESTINATION_DUPLICATE"),
  );
});

test("declarations are read from an explicit block, never inferred from prose", () => {
  assert.deepEqual(parseArtifactDeclarations("I generated an image at /tmp/thing.png for you."), []);
  assert.deepEqual(parseArtifactDeclarations(""), []);

  const declared = parseArtifactDeclarations('done. BRAINGATE_ARTIFACTS {"artifacts":[{"sourcePath":"/tmp/a.png","destination":"assets/a.png"}]}');
  assert.deepEqual(declared, [{ sourcePath: "/tmp/a.png", destination: "assets/a.png" }]);

  const asList = parseArtifactDeclarations('BRAINGATE_ARTIFACTS [{"sourcePath":"/tmp/b.png","destination":"b.png"}]');
  assert.equal(asList[0]!.destination, "b.png");
});

test("a nested declaration survives, which a lazy pattern would have truncated", () => {
  const declared = parseArtifactDeclarations('BRAINGATE_ARTIFACTS {"artifacts":[{"sourcePath":"/tmp/a.png","destination":"a.png"},{"sourcePath":"/tmp/b.png","destination":"nested/b.png"}]} and some trailing prose.');
  assert.equal(declared.length, 2);
  assert.equal(declared[1]!.destination, "nested/b.png");
});

test("a bracket inside a filename does not end the scan early", () => {
  const declared = parseArtifactDeclarations('BRAINGATE_ARTIFACTS [{"sourcePath":"/tmp/od]d}.png","destination":"od]d}.png"}]');
  assert.equal(declared.length, 1);
  assert.equal(declared[0]!.destination, "od]d}.png");
});

test("a malformed declaration is an error, not an empty result", () => {
  // "produced nothing" and "said something unreadable" call for different responses.
  assert.throws(() => parseArtifactDeclarations("BRAINGATE_ARTIFACTS {not json}"), refuses("ARTIFACT_DECLARATION_INVALID"));
  assert.throws(() => parseArtifactDeclarations('BRAINGATE_ARTIFACTS {"artifacts":"nope"}'), refuses("ARTIFACT_DECLARATION_INVALID"));
  assert.throws(() => parseArtifactDeclarations('BRAINGATE_ARTIFACTS [{"sourcePath":"/tmp/a.png"}]'), refuses("ARTIFACT_DECLARATION_INVALID"));
  assert.throws(() => parseArtifactDeclarations('BRAINGATE_ARTIFACTS [{"sourcePath":"/tmp/a.png"'), refuses("ARTIFACT_DECLARATION_INVALID"));
});
