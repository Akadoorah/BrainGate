import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { BrainGateInvariantError, ProjectRegistry, parseProjectConfig } from "@braingate/core";
import { ProjectMemory } from "./index.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "braingate-memory-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  mkdirSync(repoA);
  mkdirSync(repoB);
  const registry = new ProjectRegistry(join(root, "state"));
  const a = registry.register(parseProjectConfig({ project_id: "waslo", name: "Waslo", repositories: [repoA] }));
  const b = registry.register(parseProjectConfig({ project_id: "tabaq", name: "Tabaq", repositories: [repoB] }));
  return { a, b };
}

function proposeAndApprove(memory: ProjectMemory, body: string, kind: "verified_fact" | "architecture_decision" = "verified_fact") {
  const proposal = memory.propose({
    kind,
    body,
    reason: "Needed for future engineering work",
    sourceRefs: ["src/example.ts"],
    proposedBy: "worker:test",
  });
  return memory.supervisor().approve(proposal.proposalId, {
    verifier: "brain:test",
    evidenceRefs: ["src/example.ts:1-10"],
    confidence: 0.95,
    commitRef: "abc123",
  });
}

test("project memories are physically and logically isolated", () => {
  const { a, b } = setup();
  const memoryA = new ProjectMemory(a);
  const memoryB = new ProjectMemory(b);
  try {
    proposeAndApprove(memoryA, "Waslo uses workspace scoped billing.");
    proposeAndApprove(memoryB, "Tabaq stores meal scans separately.");
    assert.notEqual(memoryA.databasePath, memoryB.databasePath);
    assert.equal(memoryA.search("workspace billing").length, 1);
    assert.equal(memoryA.search("meal scans").length, 0);
    assert.equal(memoryB.search("workspace billing").length, 0);
  } finally {
    memoryA.close();
    memoryB.close();
  }
});

test("proposals are not canonical until supervisor approval and rejected proposals never appear", () => {
  const { a } = setup();
  const memory = new ProjectMemory(a);
  try {
    const pending = memory.propose({
      kind: "verified_fact",
      body: "Pending OAuth fact",
      reason: "worker observation",
      sourceRefs: ["src/oauth.ts"],
      proposedBy: "worker:claude",
    });
    assert.equal(memory.search("OAuth").length, 0);
    memory.supervisor().reject(pending.proposalId, {
      verifier: "brain",
      evidenceRefs: ["src/oauth.ts:1"],
      notes: "Not proven by code.",
    });
    assert.equal(memory.search("OAuth").length, 0);
    assert.throws(
      () => memory.supervisor().approve(pending.proposalId, { verifier: "brain", evidenceRefs: ["x"], confidence: 1 }),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "MEMORY_PROPOSAL_ALREADY_REVIEWED",
    );
  } finally {
    memory.close();
  }
});

test("canonical corrections supersede rather than mutate older records", () => {
  const { a } = setup();
  const memory = new ProjectMemory(a);
  try {
    const oldRecord = proposeAndApprove(memory, "Sessions expire after 14 days.");
    const replacement = memory.propose({
      kind: "verified_fact",
      body: "Sessions expire after 30 days.",
      reason: "Configuration changed",
      sourceRefs: ["src/session.ts"],
      proposedBy: "worker:codex",
      supersedesId: oldRecord.recordId,
    });
    const newRecord = memory.supervisor().approve(replacement.proposalId, {
      verifier: "brain",
      evidenceRefs: ["src/session.ts:20"],
      confidence: 1,
    });
    assert.equal(memory.getRecord(oldRecord.recordId)?.effectiveStatus, "superseded");
    assert.equal(memory.getRecord(newRecord.recordId)?.effectiveStatus, "active");
    assert.equal(memory.search("Sessions expire").length, 1);
    assert.match(memory.search("Sessions expire")[0]!.record.body, /30 days/);
  } finally {
    memory.close();
  }
});

test("TTL expiry is computed from approval while architecture decisions default to no expiry", () => {
  const { a } = setup();
  let current = new Date("2026-09-07T00:00:00.000Z");
  const memory = new ProjectMemory(a, { clock: () => current });
  try {
    const temporary = memory.propose({
      kind: "temporary_observation",
      body: "Temporary migration observation",
      reason: "migration work",
      sourceRefs: ["migration.log"],
      proposedBy: "worker",
      ttlDays: 1,
    });
    const tempRecord = memory.supervisor().approve(temporary.proposalId, {
      verifier: "brain",
      evidenceRefs: ["migration.log:1"],
      confidence: 0.8,
    });
    const architecture = proposeAndApprove(memory, "Canonical project IDs are immutable.", "architecture_decision");
    assert.equal(architecture.expiresAt, null);
    current = new Date("2026-09-09T00:00:00.000Z");
    assert.equal(memory.getRecord(tempRecord.recordId)?.effectiveStatus, "expired");
    assert.equal(memory.search("migration observation").length, 0);
    assert.equal(memory.getRecord(architecture.recordId)?.effectiveStatus, "active");
  } finally {
    memory.close();
  }
});

test("Arabic FTS retrieval works and result count is hard capped", () => {
  const { a } = setup();
  const memory = new ProjectMemory(a);
  try {
    proposeAndApprove(memory, "نظام الدفع مربوط بمساحة العمل وليس بالمستخدم.");
    assert.equal(memory.search("الدفع مساحة العمل").length, 1);
    for (let index = 0; index < 25; index += 1) proposeAndApprove(memory, `Shared searchable fact number-${index} sharedword`);
    assert.equal(memory.search("sharedword", { limit: 100 }).length, 20);
  } finally {
    memory.close();
  }
});

test("memory tables reject direct mutation and obvious secrets", () => {
  const { a } = setup();
  const memory = new ProjectMemory(a);
  const record = proposeAndApprove(memory, "Safe canonical fact.");
  const path = memory.databasePath;
  memory.close();

  const db = new Database(path);
  try {
    assert.throws(() => db.prepare("UPDATE memory_records SET body = 'tampered'").run(), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM memory_reviews").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM memory_proposals").run(), /append-only/);
    assert.equal(db.prepare("SELECT body FROM memory_records WHERE record_id = ?").get(record.recordId)?.body, "Safe canonical fact.");
  } finally {
    db.close();
  }

  const safeMemory = new ProjectMemory(a);
  try {
    assert.throws(
      () => safeMemory.propose({
        kind: "verified_fact",
        body: "api_key=super-secret-value-123456",
        reason: "bad",
        sourceRefs: [".env"],
        proposedBy: "worker",
      }),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "MEMORY_SECRET_REJECTED",
    );
  } finally {
    safeMemory.close();
  }
});
