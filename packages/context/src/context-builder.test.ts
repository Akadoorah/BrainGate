import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrainGateInvariantError, ProjectRegistry, parseProjectConfig } from "@braingate/core";
import { ProjectMemory } from "@braingate/memory";
import { ContextBuilder, conservativeTokenEstimate, type ContextCandidate } from "./index.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "braingate-context-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  mkdirSync(repoA);
  mkdirSync(repoB);
  const registry = new ProjectRegistry(join(root, "state"));
  const a = registry.register(parseProjectConfig({ project_id: "waslo", name: "Waslo", repositories: [repoA] }));
  const b = registry.register(parseProjectConfig({ project_id: "tabaq", name: "Tabaq", repositories: [repoB] }));
  return { a, b };
}

function addMemory(memory: ProjectMemory, body: string) {
  const proposal = memory.propose({
    kind: "architecture_decision",
    body,
    reason: "architecture",
    sourceRefs: ["docs/architecture.md"],
    proposedBy: "worker",
  });
  return memory.supervisor().approve(proposal.proposalId, {
    verifier: "brain",
    evidenceRefs: ["docs/architecture.md:1"],
    confidence: 1,
  });
}

test("ContextBuilder fails closed on cross-project memory or candidates", () => {
  const { a, b } = setup();
  const memoryA = new ProjectMemory(a);
  const memoryB = new ProjectMemory(b);
  try {
    assert.throws(
      () => new ContextBuilder(a, memoryB),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "CONTEXT_MEMORY_PROJECT_MISMATCH",
    );
    const builder = new ContextBuilder(a, memoryA);
    const foreign: ContextCandidate = {
      id: "foreign",
      projectId: b.projectId,
      kind: "code",
      content: "foreign code",
      source: "src/foreign.ts",
      reason: "should never cross",
      priority: 90,
      relevance: 1,
    };
    assert.throws(
      () => builder.build({ task: "Fix auth", maxTokens: 500, candidates: [foreign] }),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "CONTEXT_PROJECT_MISMATCH",
    );
  } finally {
    memoryA.close();
    memoryB.close();
  }
});

test("context pack includes relevant canonical memory and stays within hard budget", () => {
  const { a } = setup();
  const memory = new ProjectMemory(a);
  try {
    addMemory(memory, "OAuth refresh tokens are encrypted before persistence.");
    const builder = new ContextBuilder(a, memory);
    const pack = builder.build({
      task: "Fix OAuth refresh token logout",
      query: "OAuth refresh token",
      maxTokens: 120,
      candidates: [{
        id: "auth-file",
        projectId: a.projectId,
        kind: "code",
        content: "x".repeat(2_000),
        source: "src/auth.ts",
        reason: "direct auth implementation",
        priority: 100,
        relevance: 1,
      }],
    });
    assert.ok(pack.items.some((item) => item.kind === "memory"));
    assert.ok(pack.items.some((item) => item.id === "auth-file" && item.truncated));
    assert.ok(pack.budget.estimatedTokens <= pack.budget.maxTokens);
    assert.ok(pack.budget.usedCharacters <= pack.budget.hardCharacterLimit);
    assert.equal(pack.items[0]?.kind, "task");
  } finally {
    memory.close();
  }
});

test("duplicate context candidates are included once", () => {
  const { a } = setup();
  const memory = new ProjectMemory(a);
  try {
    const builder = new ContextBuilder(a, memory);
    const base: ContextCandidate = {
      id: "one",
      projectId: a.projectId,
      kind: "code",
      content: "export const value = 1;",
      source: "src/value.ts",
      reason: "relevant symbol",
      priority: 50,
      relevance: 0.8,
    };
    const pack = builder.build({
      task: "Explain value",
      maxTokens: 200,
      memoryLimit: 0,
      candidates: [base, { ...base, id: "two" }],
    });
    assert.equal(pack.items.filter((item) => item.kind === "code").length, 1);
    assert.equal(pack.skipped.filter((item) => item.reason === "duplicate").length, 1);
  } finally {
    memory.close();
  }
});

test("very large task/candidate input is bounded instead of overflowing context", () => {
  const { a } = setup();
  const memory = new ProjectMemory(a);
  try {
    const builder = new ContextBuilder(a, memory);
    const pack = builder.build({
      task: "T".repeat(10_000),
      maxTokens: 64,
      memoryLimit: 0,
      candidates: [{
        id: "huge",
        projectId: a.projectId,
        kind: "code",
        content: "C".repeat(100_000),
        source: "whole-repo.txt",
        reason: "oversized candidate",
        priority: 100,
        relevance: 1,
      }],
    });
    assert.equal(pack.items[0]?.truncated, true);
    assert.ok(pack.budget.estimatedTokens <= 64);
    assert.ok(pack.budget.usedCharacters <= 128);
    assert.ok(pack.skipped.some((item) => item.id === "huge" && item.reason === "budget"));
  } finally {
    memory.close();
  }
});

test("token estimator is deliberately conservative for mixed Arabic/code text", () => {
  const value = "الدفع workspace token refresh";
  assert.equal(conservativeTokenEstimate(value), Math.ceil(Array.from(value).length / 2));
});
