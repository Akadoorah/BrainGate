import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryCli } from "./memory-cli.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "braingate-memory-cli-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".brain"), { recursive: true });
  writeFileSync(join(repo, ".brain", "project.json"), JSON.stringify({ project_id: "sample", name: "Sample", repositories: [".."] }));
  const source = join(repo, "history.md");
  writeFileSync(source, "# Architecture decision\nUse SQLite for local memory.\n\n# Business rule\nNever auto-deploy from an agent.");
  return { root, repo, source, env: { BRAINGATE_HOME: join(root, "brain-home") } };
}

function io() {
  let stdout = ""; let stderr = "";
  return { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; }, out: () => stdout, err: () => stderr };
}

test("memory preview persists nothing, import creates proposals, promote creates canonical record", async () => {
  const f = fixture(); const out = io();
  const deps = { cwd: f.repo, env: f.env, stdout: out.stdout, stderr: out.stderr };
  const preview = await runMemoryCli(["memory", "preview", "--source", "history.md", "--json"], deps);
  assert.equal(preview.exitCode, 0);
  assert.equal((preview.data as { candidates: unknown[] }).candidates.length, 2);

  const imported = await runMemoryCli(["memory", "import", "--source", "history.md", "--json"], deps);
  assert.equal(imported.exitCode, 0);
  const proposals = (imported.data as { proposals: { proposalId: string }[] }).proposals;
  assert.equal(proposals.length, 2);
  assert.equal((imported.data as { canonicalRecordsCreated: number }).canonicalRecordsCreated, 0);

  const promoted = await runMemoryCli(["memory", "promote", "--proposal", proposals[0]!.proposalId, "--evidence", "manual:verified", "--confidence", "0.9", "--json"], deps);
  assert.equal(promoted.exitCode, 0);
  const listed = await runMemoryCli(["memory", "list", "--json"], deps);
  assert.equal(listed.exitCode, 0);
  assert.equal((listed.data as unknown[]).length, 1);
});

test("memory promote requires explicit evidence", async () => {
  const f = fixture(); const out = io();
  const deps = { cwd: f.repo, env: f.env, stdout: out.stdout, stderr: out.stderr };
  const imported = await runMemoryCli(["memory", "import", "--source", "history.md", "--json"], deps);
  const id = (imported.data as { proposals: { proposalId: string }[] }).proposals[0]!.proposalId;
  const result = await runMemoryCli(["memory", "promote", "--proposal", id, "--confidence", "1", "--json"], deps);
  assert.equal(result.exitCode, 1);
  assert.match(out.err(), /MEMORY_EVIDENCE_REQUIRED/);
});
