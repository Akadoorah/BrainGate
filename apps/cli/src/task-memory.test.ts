import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry, parseProjectConfig, type RegisteredProject } from "@braingate/core";
import { ProjectMemory } from "@braingate/memory";
import { collectTaskMemory } from "./task-memory.js";

function project(): RegisteredProject {
  const root = mkdtempSync(join(tmpdir(), "braingate-task-memory-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const registry = new ProjectRegistry(join(root, "registry"));
  return registry.register(parseProjectConfig({ project_id: "sample", name: "Sample", repositories: [repo] }));
}

/** Writes a canonical record the way the supervisor path does: propose, then approve. */
function remember(memory: ProjectMemory, body: string): void {
  const proposal = memory.propose({
    kind: "architecture_decision",
    body,
    reason: "test fixture",
    sourceRefs: ["docs/ADR.md"],
    proposedBy: "test",
  });
  memory.supervisor().approve(proposal.proposalId, { verifier: "test", evidenceRefs: ["docs/ADR.md"], confidence: 0.9, notes: null });
}

test("a task carries the canonical memory that matches it", () => {
  const registered = project();
  const memory = new ProjectMemory(registered);
  try {
    remember(memory, "Payment webhooks are verified with an HMAC over the raw body.");
    remember(memory, "The frontend theme is configured in config.yml.");
  } finally { memory.close(); }

  const result = collectTaskMemory(registered, "how are payment webhooks verified?", 48_000);
  assert.ok(result.recordCount >= 1, "the matching record was not retrieved");
  assert.match(result.records.map((r) => r.body).join("\n"), /HMAC over the raw body/);
  assert.ok(result.estimatedTokens > 0, "retrieved memory must be counted, not reported as free");
});

test("a proposal is not memory until it is promoted", () => {
  const registered = project();
  const memory = new ProjectMemory(registered);
  try {
    // Proposed but never approved. Promotion requires explicit evidence, and reading proposals
    // here would route around that gate.
    memory.propose({ kind: "architecture_decision", body: "Unverified claim about the billing flow.", reason: "test", sourceRefs: ["chat.md"], proposedBy: "test" });
  } finally { memory.close(); }

  const result = collectTaskMemory(registered, "billing flow", 48_000);
  assert.doesNotMatch(JSON.stringify(result.records), /Unverified claim/);
});

test("memory is bounded by the task's own context budget and reports what it left out", () => {
  const registered = project();
  const memory = new ProjectMemory(registered);
  try {
    for (let index = 0; index < 8; index += 1) {
      remember(memory, `Routing decision number ${String(index)}: ${"the router scores every candidate model before selecting one. ".repeat(12)}`);
    }
  } finally { memory.close(); }

  const small = collectTaskMemory(registered, "routing decision router scores candidate model", 1_200);
  const large = collectTaskMemory(registered, "routing decision router scores candidate model", 160_000);

  assert.ok(small.estimatedTokens <= Math.floor(1_200 * 0.25), "a small task must not carry more than its share of context");
  assert.ok(small.recordCount < large.recordCount, "a larger budget should admit more memory");
  assert.ok(small.truncated > 0, "records left out must be counted, not silently dropped");
});

test("an unusable memory store yields no memory rather than failing the task", () => {
  const registered = project();
  // Nothing was ever written, so the store is empty; a task must still run.
  const result = collectTaskMemory(registered, "anything at all", 24_000);
  assert.equal(result.recordCount, 0);
  assert.equal(result.estimatedTokens, 0);
});
