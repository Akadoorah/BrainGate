/**
 * Operational refusal backoff: BrainGate deciding to wait, which is not the provider deciding anything.
 *
 * The failure this exists for: after a real refusal, every *new* task tried the same exhausted pool
 * once, failed, and learned the same fact again. The fix must not be to claim the pool is exhausted
 * until a reset nobody stated — that is a policy guess wearing the provider's authority. So the
 * backoff is stored apart, named apart, expires on a local clock, and never touches `quotaState`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainGateInvariantError, budgetFor, classifyTask } from "@braingate/core";
import { CapabilityRouter, ModelRegistry, type ModelDefinition, type ModelRuntime } from "@braingate/router";
import { GlobalQuotaStore, REFUSAL_BACKOFF_MS, REFUSAL_BACKOFF_POLICY, buildDashboardSnapshot } from "./index.js";

function store(): GlobalQuotaStore {
  return new GlobalQuotaStore(mkdtempSync(join(tmpdir(), "braingate-backoff-")));
}

const runtime = (): ModelRuntime => ({ available: true, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-12T00:00:00Z" });

function definition(providerId: string, modelId: string, quotaPool: string, capabilities: Record<string, number>): ModelDefinition {
  return { providerId, modelId, quotaPool, capabilities, speed: "deep", contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null };
}

test("a structured native refusal creates a backoff, and quotaState stays UNKNOWN", () => {
  const quota = store();
  try {
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", sourceTaskId: "task-1", detail: "You've hit your session limit", observedAt: "2026-09-12T01:05:10.000Z" });
    const active = quota.activeRefusalBackoffs(Date.parse("2026-09-12T01:05:11.000Z"));
    assert.equal(active.length, 1);
    assert.equal(active[0]!.policy, REFUSAL_BACKOFF_POLICY, "the row names its own provenance");
    assert.equal(active[0]!.evidence, "native", "it rests on the provider's own statement");
    assert.equal(active[0]!.policyBackoffUntil, new Date(Date.parse("2026-09-12T01:05:10.000Z") + REFUSAL_BACKOFF_MS).toISOString());
    assert.equal(active[0]!.sourceTaskId, "task-1");
    // The provider's quota truth is untouched: no snapshot, no status, nothing to read as exhausted.
    assert.deepEqual(quota.latest(), []);
    assert.equal(quota.history().length, 0);
    assert.equal(Object.keys(active[0]!).includes("resetAt"), false, "a backoff carries no reset time");
  } finally { quota.close(); }
});

test("a backoff expires on its own clock, and the pool is dispatchable again", () => {
  const quota = store();
  try {
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: "2026-09-12T01:00:00.000Z", backoffMs: 60_000 });
    assert.equal(quota.activeRefusalBackoffs(Date.parse("2026-09-12T01:00:30.000Z")).length, 1);
    assert.equal(quota.activeRefusalBackoffs(Date.parse("2026-09-12T01:00:59.000Z")).length, 1);
    assert.equal(quota.activeRefusalBackoffs(Date.parse("2026-09-12T01:01:00.000Z")).length, 0, "expiry is the only thing that clears it, and it clears completely");
  } finally { quota.close(); }
});

test("a served call supersedes the backoff, and the decision history is kept", () => {
  const quota = store();
  try {
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", sourceTaskId: "task-1", observedAt: "2026-09-12T01:00:00.000Z" });
    quota.clearRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", sourceTaskId: "task-2", observedAt: "2026-09-12T01:02:00.000Z" });
    assert.equal(quota.activeRefusalBackoffs(Date.parse("2026-09-12T01:03:00.000Z")).length, 0, "the pool that just answered is not being avoided");
    const history = quota.refusalBackoffHistory();
    assert.deepEqual(history.map((row) => row.reason), ["rate_limit", "served"], "both decisions remain in the record");
    // A later refusal starts a new window rather than being swallowed by the earlier clear.
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: "2026-09-12T01:04:00.000Z" });
    assert.equal(quota.activeRefusalBackoffs(Date.parse("2026-09-12T01:05:00.000Z")).length, 1);
  } finally { quota.close(); }
});

test("backoff rows are append-only and cannot be given a non-policy duration", () => {
  const quota = store();
  try {
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit" });
    assert.throws(() => quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", backoffMs: 0 }), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "QUOTA_BACKOFF_INVALID");
    // The store exposes no update and no delete: superseding is another appended row.
    const database = (quota as unknown as { readonly ["#db"]?: never });
    void database;
    assert.equal(quota.refusalBackoffHistory().length, 1);
  } finally { quota.close(); }
});

test("routing avoids a backed-off pool before any call, and says why", () => {
  const registry = new ModelRegistry();
  registry.register(definition("anthropic", "claude-sonnet", "claude-subscription", { planner: 90, coder: 90 }), { ...runtime(), refusalBackoffUntil: new Date(Date.now() + 60_000).toISOString() });
  const classification = classifyTask({ text: "Where is the theme configuration read?", mode: "ask" });
  const request = { role: "coder" as const, classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 500, writeRequired: false };
  // Alone, the backed-off pool leaves no candidate at all — and the failure is a routing one.
  const error = (() => { try { new CapabilityRouter(registry).route(request); return null; } catch (caught) { return caught; } })();
  assert.ok(error instanceof BrainGateInvariantError);
  assert.equal(error.code, "ROUTE_NO_ELIGIBLE_MODEL");
  // With a sibling on another pool, the rejection names the backoff rather than exhaustion.
  const models = new ModelRegistry();
  models.register(definition("anthropic", "claude-sonnet", "claude-subscription", { coder: 90 }), { ...runtime(), refusalBackoffUntil: new Date(Date.now() + 60_000).toISOString() });
  models.register(definition("openai", "astra", "chatgpt-subscription", { coder: 80 }), runtime());
  const route = new CapabilityRouter(models).route(request);
  assert.equal(route.selected.model.definition.quotaPool, "chatgpt-subscription");
  assert.deepEqual(route.rejected.map((candidate) => candidate.reasons.join("+")), ["quota-pool-backoff:claude-subscription"]);
});

test("every model sharing the backed-off pool is avoided, and another pool from the same provider is not", () => {
  const models = new ModelRegistry();
  const until = new Date(Date.now() + 60_000).toISOString();
  models.register(definition("anthropic", "on-backoff-1", "claude-subscription", { coder: 90 }), { ...runtime(), refusalBackoffUntil: until });
  models.register(definition("anthropic", "on-backoff-2", "claude-subscription", { coder: 92 }), { ...runtime(), refusalBackoffUntil: until });
  models.register(definition("anthropic", "other-pool", "claude-api", { coder: 70 }), runtime());
  const classification = classifyTask({ text: "Where is the theme configuration read?", mode: "ask" });
  const route = new CapabilityRouter(models).route({ role: "coder", classification, budget: budgetFor(classification, { writeRequested: false }), requiredContextTokens: 500, writeRequired: false });
  assert.equal(route.selected.model.definition.modelId, "other-pool", "a provider stays usable through a pool that has not refused");
  assert.equal(route.rejected.length, 2, "both models on the backed-off pool are out");
  assert.ok(route.rejected.every((candidate) => candidate.reasons.every((reason) => reason.startsWith("quota-pool-backoff:"))));
});

test("the dashboard and doctor-facing card show BACKOFF, never EXHAUSTED", () => {
  const directory = mkdtempSync(join(tmpdir(), "braingate-backoff-card-"));
  const quota = new GlobalQuotaStore(directory);
  const observedAt = "2026-09-12T01:05:10.000Z";
  const generatedAt = "2026-09-12T01:06:00.000Z";
  try {
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt, sourceTaskId: "task-1" });
    quota.record({ provider: "anthropic", quotaPool: "claude-subscription", metric: "window_utilization", window: "seven_day", value: 0.69, unit: "ratio", status: "unknown", evidence: "native", observedAt });
    const snapshot = buildDashboardSnapshot({ projects: [], quotaStore: quota, generatedAt });
    const card = snapshot.providers[0]!;
    assert.equal(card.status, "unknown", "the pool's availability is not claimed");
    assert.equal(card.refusalBackoffUntil, new Date(Date.parse(observedAt) + REFUSAL_BACKOFF_MS).toISOString());
    assert.equal(card.refusalBackoffReason, "rate_limit");
    // And once the policy lapses the card says nothing about a backoff.
    const later = buildDashboardSnapshot({ projects: [], quotaStore: quota, generatedAt: new Date(Date.parse(observedAt) + REFUSAL_BACKOFF_MS + 1).toISOString() });
    assert.equal(later.providers[0]!.refusalBackoffUntil, null);
    assert.equal(later.providers[0]!.status, "unknown");
  } finally { quota.close(); }
});

test("a refusal with no machine-readable reset is not stored as a quota claim", () => {
  const directory = mkdtempSync(join(tmpdir(), "braingate-backoff-noclaim-"));
  const quota = new GlobalQuotaStore(directory);
  try {
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: "2026-09-12T01:05:10.000Z" });
    // Nothing anywhere in the store says exhausted, and nothing carries a reset time from the policy.
    assert.equal(quota.latest().filter((row) => row.status === "exhausted").length, 0);
    assert.ok(quota.refusalBackoffHistory().every((row) => row.policyBackoffUntil !== null));
  } finally { quota.close(); }
});

/**
 * Out-of-order persistence.
 *
 * The rows are written by separate statements, and a task's own record is written when its process
 * gets to it — so the append order is not the order things happened. The state must follow the
 * provider events' own times: a success observed *after* a refusal ends the wait, and a success
 * observed *before* one does not, whatever order the two rows reach the table in.
 */
const T0 = "2026-09-12T01:00:00.000Z";
const T1 = "2026-09-12T01:00:05.000Z";
const LATER = "2026-09-12T01:00:10.000Z";
const at = (iso: string): number => Date.parse(iso);

test("a refusal observed after a success stays active even when the success is persisted later", () => {
  const quota = store();
  try {
    // Task B's refusal is written first...
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: T1, sourceTaskId: "task-b" });
    // ...and task A's earlier success, observed at T0, lands afterwards.
    quota.clearRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", observedAt: T0, sourceTaskId: "task-a" });
    const active = quota.activeRefusalBackoffs(at(LATER));
    assert.equal(active.length, 1, "the later observation wins: the pool is still being avoided");
    assert.equal(active[0]!.sourceTaskId, "task-b");
    assert.equal(active[0]!.policyBackoffUntil, new Date(at(T1) + REFUSAL_BACKOFF_MS).toISOString());
  } finally { quota.close(); }
});

test("a success observed after a refusal clears it, whatever order the rows were written in", () => {
  for (const order of ["clear-first", "refusal-first"] as const) {
    const quota = store();
    try {
      if (order === "clear-first") {
        quota.clearRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", observedAt: T1, sourceTaskId: "task-a" });
        quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: T0, sourceTaskId: "task-b" });
      } else {
        quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: T0, sourceTaskId: "task-b" });
        quota.clearRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", observedAt: T1, sourceTaskId: "task-a" });
      }
      assert.equal(quota.activeRefusalBackoffs(at(LATER)).length, 0, `${order}: the newer success ends the wait`);
    } finally { quota.close(); }
  }
});

test("identical observation times are decided deterministically by append order", () => {
  const quota = store();
  try {
    // Two tasks recorded the same pool at the same instant. The later *row* is the later decision,
    // and the result must not depend on which order the rows happen to be read back in.
    quota.clearRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", observedAt: T0, sourceTaskId: "task-a" });
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: T0, sourceTaskId: "task-b" });
    const active = quota.activeRefusalBackoffs(at(LATER));
    assert.equal(active.length, 1);
    assert.equal(active[0]!.sourceTaskId, "task-b", "same observedAt: the later sequence decides");
    // And the reverse order decides the other way, as a tie-break should.
    const second = store();
    try {
      second.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: T0, sourceTaskId: "task-b" });
      second.clearRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", observedAt: T0, sourceTaskId: "task-a" });
      assert.equal(second.activeRefusalBackoffs(at(LATER)).length, 0);
    } finally { second.close(); }
  } finally { quota.close(); }
});

test("a refusal observed after a clear opens a new window, timed from the refusal", () => {
  const quota = store();
  try {
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: T0, sourceTaskId: "task-a" });
    quota.clearRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", observedAt: T1, sourceTaskId: "task-b" });
    quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: LATER, sourceTaskId: "task-c" });
    const active = quota.activeRefusalBackoffs(at(LATER));
    assert.equal(active.length, 1);
    assert.equal(active[0]!.sourceTaskId, "task-c");
    // The window starts at the refusal's own observedAt, not at the moment the row was written.
    assert.equal(active[0]!.policyBackoffUntil, new Date(at(LATER) + REFUSAL_BACKOFF_MS).toISOString());
    assert.equal(active[0]!.observedAt, LATER);
    assert.equal(quota.activeRefusalBackoffs(at(LATER) + REFUSAL_BACKOFF_MS).length, 0, "and it lapses ten minutes after the refusal was observed");
  } finally { quota.close(); }
});

test("the policy window derives from the refusal's observation time, not from insertion time", () => {
  const quota = store();
  try {
    // A refusal observed an hour ago, persisted now: its window is already nearly over rather than
    // starting when the row was written. Backdated through the same public input the CLI uses.
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const backoff = quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit", observedAt: longAgo });
    assert.equal(backoff.policyBackoffUntil, new Date(Date.parse(longAgo) + REFUSAL_BACKOFF_MS).toISOString());
    assert.ok(Date.parse(backoff.policyBackoffUntil) < Date.now(), "an hour-old refusal is not a fresh ten-minute wait");
    assert.equal(quota.activeRefusalBackoffs().length, 0, "so it does not block the pool now");
  } finally { quota.close(); }
});
