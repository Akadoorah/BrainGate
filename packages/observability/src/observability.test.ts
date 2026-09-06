import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  ProjectRegistry,
  TaskLedger,
  budgetFor,
  classifyTask,
  parseProjectConfig,
  type RegisteredProject,
} from "@braingate/core";
import type { RouteResult } from "@braingate/router";
import {
  GlobalQuotaStore,
  buildDashboardSnapshot,
  buildTaskBrief,
  buildTaskCard,
  normalizeTaskReceipt,
  recordTaskBrief,
} from "./index.js";

function setupProject(name = "Waslo", id = "waslo") {
  const root = mkdtempSync(join(tmpdir(), "braingate-observe-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const registry = new ProjectRegistry(join(root, "registry"));
  const project = registry.register(parseProjectConfig({ project_id: id, name, repositories: [repo] }));
  const ledger = new TaskLedger(project);
  return { root, project, ledger };
}

function route(providerId: string, modelId: string, quotaPool: string): RouteResult {
  const registered = {
    definition: {
      providerId, modelId, quotaPool,
      capabilities: { coder: 90 }, speed: "balanced" as const,
      contextCapacity: 100_000, writeCapable: true, reasoning: 90, underlyingFamily: null,
    },
    runtime: { available: true, quotaState: "healthy" as const, quotaPressure: 0.2, observedAt: "2026-09-07T00:00:00.000Z" },
  };
  return {
    role: "coder",
    selected: { model: registered, score: 90, reasons: ["sufficient"] },
    fallbacks: [], rejected: [], rationale: ["selected sufficient healthy model"],
  };
}

function createBrief(project: RegisteredProject, ledger: TaskLedger) {
  const classification = classifyTask({ text: "Fix the OAuth login bug", mode: "write", inspection: { auth: true, affectedFiles: 6 } });
  const task = ledger.createTask({ title: "Fix login sk-abcdefghijklmnopqrstuvwxyz012345", complexity: classification.complexity, risk: classification.risk });
  const budget = budgetFor(classification, { writeRequested: true });
  const brief = buildTaskBrief({
    project, task, classification, budget, routes: [route("anthropic", "model-x", "claude-subscription")],
    context: { memoryRecords: 4, explicitCandidates: 7, includedItems: 6, estimatedTokens: 2200, truncatedItems: 1, sourceLabels: ["src/auth.ts", "docs/auth.md"] },
    skills: { loaded: ["waslo-auth"], denied: ["tabaq-payments"] },
    permissions: { executionProfile: "worktree-write", networkAllowed: false },
    worktree: { enabled: true, taskWorktreeLabel: "TASK-safe" },
    createdAt: "2026-09-07T00:00:00.000Z",
  });
  return { task, classification, budget, brief };
}

test("task brief keeps policy/counts, redacts secret-looking labels, and persists in the existing ledger", () => {
  const { project, ledger } = setupProject();
  try {
    const { task, brief } = createBrief(project, ledger);
    const serialized = JSON.stringify(brief);
    assert.doesNotMatch(serialized, /sk-abcdefghijklmnopqrstuvwxyz012345/);
    assert.equal(brief.context.memoryRecords, 4);
    assert.equal(brief.context.estimatedTokens, 2200);
    assert.equal(brief.permissions.productionSecretsAllowed, false);
    assert.equal(brief.permissions.originalCheckoutWriteAllowed, false);
    assert.ok(!("content" in brief.context));
    recordTaskBrief(ledger, brief);
    const receipt = ledger.receipt(task.taskId);
    assert.ok(receipt.events.some((event) => event.kind === "task.brief"));
    assert.equal(normalizeTaskReceipt(receipt).brief?.taskId, task.taskId);
  } finally { ledger.close(); }
});

test("quota snapshots are append-only, latest is deterministic, and unknown stays null", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-quota-"));
  const store = new GlobalQuotaStore(root);
  try {
    store.record({ provider: "anthropic", quotaPool: "claude", metric: "remaining", window: "5h", value: 70, unit: "%", status: "healthy", evidence: "native", observedAt: "2026-09-07T00:00:00Z" });
    store.record({ provider: "anthropic", quotaPool: "claude", metric: "remaining", window: "5h", value: 40, unit: "%", status: "limited", evidence: "native", observedAt: "2026-09-07T01:00:00Z" });
    store.record({ provider: "xai", quotaPool: "grok-free", metric: "remaining", status: "unknown", evidence: "unknown", observedAt: "2026-09-07T01:00:00Z" });
    store.record({ provider: "github-copilot", quotaPool: "copilot", metric: "requests", value: 20, unit: "requests", status: "healthy", evidence: "measured", observedAt: "2026-09-07T01:00:00Z" });
    const latest = store.latest();
    assert.equal(latest.find((item) => item.provider === "anthropic")?.value, 40);
    assert.equal(latest.find((item) => item.provider === "xai")?.value, null);
    assert.notEqual(latest.find((item) => item.provider === "github-copilot")?.quotaPool, latest.find((item) => item.provider === "anthropic")?.quotaPool);
    assert.throws(() => store.record({ provider: "xai", quotaPool: "grok-free", metric: "remaining", value: 100, status: "unknown", evidence: "unknown" }));

    const db = new Database(store.databasePath);
    try {
      assert.throws(() => db.prepare("UPDATE quota_snapshots SET value = 999").run(), /append-only/);
      assert.throws(() => db.prepare("DELETE FROM quota_snapshots").run(), /append-only/);
    } finally { db.close(); }
  } finally { store.close(); }
});

test("dashboard snapshot is deterministic and task cards reject cross-project mixing", () => {
  const a = setupProject("Waslo", "waslo");
  const b = setupProject("Tabaq", "tabaq");
  const globalRoot = mkdtempSync(join(tmpdir(), "braingate-dashboard-quota-"));
  const quota = new GlobalQuotaStore(globalRoot);
  try {
    const { task, brief } = createBrief(a.project, a.ledger);
    recordTaskBrief(a.ledger, brief);
    quota.record({ provider: "openai", quotaPool: "chatgpt", metric: "remaining", status: "unknown", evidence: "unknown", observedAt: "2026-09-07T00:00:00Z" });
    quota.record({ provider: "anthropic", quotaPool: "claude", metric: "remaining", value: 50, unit: "%", status: "healthy", evidence: "native", observedAt: "2026-09-07T00:00:00Z" });
    const snapshot = buildDashboardSnapshot({ projects: [{ project: a.project, ledger: a.ledger }, { project: b.project, ledger: b.ledger }], quotaStore: quota, generatedAt: "2026-09-07T02:00:00Z" });
    assert.deepEqual(snapshot.providers.map((item) => item.provider), ["anthropic", "openai"]);
    assert.equal(snapshot.activeTasks[0]?.taskId, task.taskId);
    const normalized = normalizeTaskReceipt(a.ledger.receipt(task.taskId));
    assert.throws(() => buildTaskCard(b.project, normalized), /mix project identities/);
  } finally {
    a.ledger.close(); b.ledger.close(); quota.close();
  }
});
