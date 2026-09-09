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

// The memory model was complete and unusable. Making BrainGate know one sentence meant writing
// a file, previewing it, importing it and promoting it, so nothing was ever recorded and the
// store stayed empty — a gate nobody can reach is not a safeguard, it is an absence.
test("a note the operator states is recorded, and is a proposal rather than memory", async () => {
  const f = fixture(); const out = io();
  const deps = { cwd: f.repo, env: f.env, stdout: out.stdout, stderr: out.stderr };

  const noted = await runMemoryCli(["memory", "note", "--text", "Subscription state lives in Riverpod providers.", "--json"], deps);
  assert.equal(noted.exitCode, 0);
  const proposal = noted.data as { proposalId: string; kind: string; proposedBy: string; body: string };
  assert.equal(proposal.kind, "verified_fact");
  // Recorded as the operator's claim, never as BrainGate's: a model's own output must not be
  // able to enter here, which is the boundary the ephemeral session thread exists to hold.
  assert.equal(proposal.proposedBy, "operator");

  // It is not memory yet. Tasks read canonical records only.
  const listed = await runMemoryCli(["memory", "list", "--json"], deps);
  assert.deepEqual(listed.data, []);

  const waiting = await runMemoryCli(["memory", "proposals", "--json"], deps);
  assert.equal((waiting.data as readonly unknown[]).length, 1);
});

test("a noted claim reaches memory only through the same evidence gate as everything else", async () => {
  const f = fixture(); const out = io();
  const deps = { cwd: f.repo, env: f.env, stdout: out.stdout, stderr: out.stderr };
  const noted = await runMemoryCli(["memory", "note", "--text", "Auth uses email OTP, not OAuth.", "--json"], deps);
  const { proposalId } = noted.data as { proposalId: string };

  // Convenience must not become a way around the gate: promotion still demands evidence.
  const withoutEvidence = await runMemoryCli(["memory", "promote", "--proposal", proposalId, "--confidence", "0.9", "--json"], deps);
  assert.equal(withoutEvidence.exitCode, 1);
  assert.match(out.err(), /MEMORY_EVIDENCE_REQUIRED/);

  assert.equal((await runMemoryCli(["memory", "promote", "--proposal", proposalId, "--evidence", "lib/auth/otp.dart", "--confidence", "0.9", "--json"], deps)).exitCode, 0);
  const canonical = await runMemoryCli(["memory", "list", "--json"], deps);
  assert.equal((canonical.data as readonly { body: string }[])[0]?.body, "Auth uses email OTP, not OAuth.");
  // Once decided, it stops waiting on the operator.
  assert.deepEqual((await runMemoryCli(["memory", "proposals", "--json"], deps)).data, []);
});

test("an unrecognised memory kind is refused with the list of real ones", async () => {
  const f = fixture(); const out = io();
  const deps = { cwd: f.repo, env: f.env, stdout: out.stdout, stderr: out.stderr };
  const result = await runMemoryCli(["memory", "note", "--text", "x", "--kind", "vibes", "--json"], deps);
  assert.equal(result.exitCode, 1);
  assert.match(out.err(), /MEMORY_KIND_INVALID/);
  assert.match(out.err(), /architecture_decision/);
});
