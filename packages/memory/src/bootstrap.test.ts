import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry } from "@braingate/core";
import { ProjectMemory } from "./memory-store.js";
import { importMemoryPreview, previewMemoryImport } from "./bootstrap.js";

function fixture(id: string) {
  const root = mkdtempSync(join(tmpdir(), `braingate-memory-bootstrap-${id}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const registry = new ProjectRegistry(join(root, "brain"));
  const project = registry.register({ projectId: id as never, name: id, repositories: [repo] });
  const memory = new ProjectMemory(project);
  return { root, repo, project, memory };
}

test("text bootstrap creates proposals only and never canonical records automatically", () => {
  const f = fixture("bootstrap-text");
  try {
    const file = join(f.root, "history.md");
    writeFileSync(file, "# Architecture decision\nUse SQLite for local canonical memory.\n\n# Known bug\nProvider quota may be unknown.");
    const preview = previewMemoryImport(f.memory, { sourcePath: file });
    assert.equal(preview.projectId, f.project.projectId);
    assert.equal(preview.rawTranscriptPersisted, false);
    assert.equal(preview.candidates.length, 2);
    assert.equal(preview.candidates[0]?.kind, "architecture_decision");
    const proposals = importMemoryPreview(f.memory, preview);
    assert.equal(proposals.length, 2);
    assert.equal(f.memory.listEffective(20).length, 0);
  } finally { f.memory.close(); }
});

test("bootstrap preview is project-bound", () => {
  const a = fixture("bootstrap-a");
  const b = fixture("bootstrap-b");
  try {
    const file = join(a.root, "history.txt");
    writeFileSync(file, "Verified fact: this belongs only to project A.");
    const preview = previewMemoryImport(a.memory, { sourcePath: file });
    assert.throws(() => importMemoryPreview(b.memory, preview), /different project/);
  } finally { a.memory.close(); b.memory.close(); }
});

test("canonical duplicate is skipped on later import", () => {
  const f = fixture("bootstrap-dedupe");
  try {
    const file = join(f.root, "history.txt");
    writeFileSync(file, "Verified fact: project uses SQLite for local state.");
    const first = previewMemoryImport(f.memory, { sourcePath: file });
    const proposal = importMemoryPreview(f.memory, first)[0]!;
    f.memory.supervisor().approve(proposal.proposalId, { verifier: "test", evidenceRefs: ["code:test"], confidence: 1 });
    const second = previewMemoryImport(f.memory, { sourcePath: file });
    assert.equal(second.duplicates, 1);
    assert.equal(importMemoryPreview(f.memory, second).length, 0);
  } finally { f.memory.close(); }
});

test("ChatGPT-style import is compact and does not preserve the full transcript", () => {
  const f = fixture("bootstrap-chatgpt");
  try {
    const long = "x".repeat(10_000);
    const file = join(f.root, "conversations.json");
    writeFileSync(file, JSON.stringify([{ title: "Waslo architecture", mapping: {
      one: { message: { author: { role: "user" }, content: { parts: [long] } } },
      two: { message: { author: { role: "assistant" }, content: { parts: [long] } } },
    } }]));
    const preview = previewMemoryImport(f.memory, { sourcePath: file });
    assert.equal(preview.format, "chatgpt");
    assert.equal(preview.candidates.length, 1);
    assert.ok((preview.candidates[0]?.body.length ?? 0) <= 4_000);
    assert.doesNotMatch(preview.candidates[0]?.sourceRefs[0] ?? "", /conversations\.json/);
  } finally { f.memory.close(); }
});
