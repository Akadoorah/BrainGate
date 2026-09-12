import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetFor, classifyTask } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type ModelDefinition } from "@braingate/router";
import { ModelCatalog, hydrateModelRegistry, resolveOperatorState } from "./index.js";
import { GlobalQuotaStore, buildDashboardSnapshot } from "@braingate/observability";

const definition: ModelDefinition = {
  providerId: "anthropic",
  modelId: "model-a",
  quotaPool: "claude-subscription",
  capabilities: { coder: 90, reviewer: 88 },
  speed: "balanced",
  contextCapacity: 200_000,
  writeCapable: false,
  reasoning: 90,
  underlyingFamily: null,
};

function provider(available = true): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId: "anthropic", displayName: "Claude", binary: "claude",
    available: obs(available), version: obs("2.1.248"), authState: obs("authenticated"), authMode: obs("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt }, removedBillingOverrides: [], warnings: [],
  };
}

test("model catalog round-trips atomically in deterministic order", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-catalog-"));
  const catalog = new ModelCatalog(join(root, "models.json"));
  catalog.upsert({ ...definition, modelId: "z-model" });
  catalog.upsert({ ...definition, modelId: "a-model" });
  assert.deepEqual(catalog.configured().map((item) => item.modelId), ["a-model", "z-model"]);
  const raw = readFileSync(catalog.path, "utf8");
  assert.ok(raw.indexOf("a-model") < raw.indexOf("z-model"));
  assert.doesNotMatch(raw, /tmp/);
});

test("duplicate and invalid catalog data fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-catalog-invalid-"));
  const path = join(root, "models.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, entries: [
    { providerId: "anthropic", modelId: "dup", configured: true, definition: { ...definition, modelId: "dup" } },
    { providerId: "anthropic", modelId: "dup", configured: false },
  ] }));
  assert.throws(() => new ModelCatalog(path).load(), /Duplicate/);
  const catalog = new ModelCatalog(join(root, "other.json"));
  assert.throws(() => catalog.upsert({ ...definition, reasoning: 101 }), /reasoning/);
});

test("unscored discovered candidates never become routable", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-catalog-unscored-"));
  const catalog = new ModelCatalog(join(root, "models.json"));
  const snapshot = { ...provider(), models: { value: ["discovered-model"], evidence: "native" as const, sourceCommand: "models", observedAt: "2026-09-07T00:00:00.000Z" } };
  catalog.importDiscovered([snapshot]);
  const hydrated = hydrateModelRegistry({ entries: catalog.load(), providers: [snapshot], quota: [], observedAt: "2026-09-07T00:00:00.000Z" });
  assert.equal(hydrated.registry.list().length, 0);
});

test("runtime hydration preserves unknown quota and blocks unavailable/exhausted models", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-runtime-"));
  const catalog = new ModelCatalog(join(root, "models.json"));
  catalog.upsert(definition);
  const unknown = hydrateModelRegistry({ entries: catalog.load(), providers: [provider(true)], quota: [], observedAt: "2026-09-07T00:00:00.000Z" });
  assert.equal(unknown.runtimes[0]?.quotaState, "unknown");
  assert.equal(unknown.runtimes[0]?.quotaHint, null);

  const unavailable = hydrateModelRegistry({ entries: catalog.load(), providers: [provider(false)], quota: [], observedAt: "2026-09-07T00:00:00.000Z" });
  const router = new CapabilityRouter(unavailable.registry);
  const classification = classifyTask({ text: "Where is the theme config?", mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  assert.throws(() => router.route({ role: "coder", classification, budget, requiredContextTokens: 100, writeRequired: false }), /No eligible model/);

  const exhausted = hydrateModelRegistry({ entries: catalog.load(), providers: [provider(true)], quota: [{ sequence: 1, provider: "anthropic", quotaPool: "claude-subscription", metric: "remaining", window: null, value: 0, unit: "requests", resetAt: null, status: "exhausted", evidence: "native", source: "status", observedAt: "2026-09-07T00:00:00.000Z" }], observedAt: "2026-09-07T00:00:00.000Z" });
  assert.equal(exhausted.runtimes[0]?.quotaState, "exhausted");
});

test("BRAINGATE_HOME override is isolated", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-home-"));
  const a = resolveOperatorState({ BRAINGATE_HOME: join(root, "a") }, root);
  const b = resolveOperatorState({ BRAINGATE_HOME: join(root, "b") }, root);
  assert.notEqual(a.home, b.home);
  assert.notEqual(a.modelCatalogPath, b.modelCatalogPath);
});


// The hint is the fullest window anyone has seen, not the most recent reading of one. A five-minute
// window that has barely been touched is not the window that will refuse the next call, and taking
// the newest row would have made routing prefer whichever window happened to report last.
test("the routing hint is the fullest window, and a status nobody stated is not a state", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-hint-"));
  const catalog = new ModelCatalog(join(root, "models.json"));
  catalog.upsert(definition);
  const at = (sequence: number, value: number, observedAt: string) => ({
    sequence, provider: "anthropic", quotaPool: "claude-subscription", metric: "window_utilization",
    window: sequence === 1 ? "weekly" : "5h", value, unit: "ratio", resetAt: null,
    status: "unknown" as const, evidence: "native" as const, source: "provider-rate-limit-event", observedAt,
  });

  const hydrated = hydrateModelRegistry({
    entries: catalog.load(),
    providers: [provider(true)],
    quota: [at(1, 0.93, "2026-09-07T00:00:00.000Z"), at(2, 0.04, "2026-09-07T06:00:00.000Z")],
    observedAt: "2026-09-07T06:00:00.000Z",
  });
  assert.equal(hydrated.runtimes[0]?.quotaHint, 0.93);
  assert.equal(hydrated.runtimes[0]?.quotaObservedAt, "2026-09-07T00:00:00.000Z");
  // A utilisation reading, however full, is not a statement that the pool is unusable.
  assert.equal(hydrated.runtimes[0]?.quotaState, "unknown");

  // A reading BrainGate derived itself is history: it is kept, and it does not decide routing.
  const derived = hydrateModelRegistry({
    entries: catalog.load(),
    providers: [provider(true)],
    quota: [{ sequence: 1, provider: "anthropic", quotaPool: "claude-subscription", metric: "used", window: null, value: 1, unit: "requests", resetAt: null, status: "exhausted", evidence: "measured", source: "brain-gate", observedAt: "2026-09-07T06:00:00.000Z" }],
    observedAt: "2026-09-07T06:00:00.000Z",
  });
  assert.equal(derived.runtimes[0]?.quotaState, "unknown");

  // And a window that has already reset stops describing the pool.
  const expired = hydrateModelRegistry({
    entries: catalog.load(),
    providers: [provider(true)],
    quota: [{ sequence: 1, provider: "anthropic", quotaPool: "claude-subscription", metric: "remaining", window: null, value: 0, unit: "requests", resetAt: "2026-09-07T05:00:00.000Z", status: "exhausted", evidence: "native", source: "provider", observedAt: "2026-09-07T04:00:00.000Z" }],
    observedAt: "2026-09-07T06:00:00.000Z",
    now: Date.parse("2026-09-07T06:00:00.000Z"),
  });
  assert.equal(expired.runtimes[0]?.quotaState, "unknown");
});

// The real validation run found this: a pre-M19 row saying `healthy`, written thirty-three hours
// earlier by code that coined the label from its own traffic ("it served this call"), was still being
// handed to routing as current availability. The label is history; only a refusal the provider stated
// may close a pool. The row keeps its utilization and its timestamp, because those are readings.
test("a legacy healthy or limited label is history, and never current availability", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-legacy-healthy-"));
  const catalog = new ModelCatalog(join(root, "models.json"));
  catalog.upsert(definition);
  const now = Date.parse("2026-09-11T20:17:27.000Z");
  const row = (sequence: number, value: number, status: "healthy" | "limited" | "exhausted" | "unknown", resetAt: string | null) => ({
    sequence, provider: "anthropic", quotaPool: "claude-subscription", metric: "window_utilization",
    window: "seven_day", value, unit: "ratio", resetAt, status, evidence: "native" as const,
    source: "provider-rate-limit-event", observedAt: "2026-09-10T11:07:13.858Z",
  });

  const legacy = hydrateModelRegistry({
    entries: catalog.load(), providers: [provider(true)],
    quota: [row(1, 0.47, "healthy", "2026-09-12T08:00:00.000Z"), row(2, 0.39, "limited", "2026-09-12T08:00:00.000Z")],
    observedAt: "2026-09-11T20:17:27.000Z", now,
  });
  assert.equal(legacy.runtimes[0]?.quotaState, "unknown", "a legacy label is not a current state");
  // The readings themselves survive: the fullest window, with the moment it was seen.
  assert.equal(legacy.runtimes[0]?.quotaHint, 0.47);
  assert.equal(legacy.runtimes[0]?.quotaObservedAt, "2026-09-10T11:07:13.858Z");

  // And the consequence the operator cares about: the pool is still usable. Skipping a subscription
  // they pay for, on the strength of a label this code invented, is the bug.
  const classification = classifyTask({ text: "Where is the theme config?", mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  const routed = new CapabilityRouter(legacy.registry).route({ role: "coder", classification, budget, requiredContextTokens: 100, writeRequired: false });
  assert.equal(routed.selected.model.definition.modelId, "model-a");

  // A refusal the provider stated still closes the pool, and still expires with its own window.
  const refused = hydrateModelRegistry({
    entries: catalog.load(), providers: [provider(true)],
    quota: [row(1, 1, "exhausted", "2026-09-12T08:00:00.000Z")],
    observedAt: "2026-09-11T20:17:27.000Z", now,
  });
  assert.equal(refused.runtimes[0]?.quotaState, "exhausted");
  const expired = hydrateModelRegistry({
    entries: catalog.load(), providers: [provider(true)],
    quota: [row(1, 1, "exhausted", "2026-09-11T10:00:00.000Z")],
    observedAt: "2026-09-11T20:17:27.000Z", now,
  });
  assert.equal(expired.runtimes[0]?.quotaState, "unknown", "a window that has reset is over");
});

// The dashboard draws the same boundary as routing, including the freshness rule: a refusal is
// current availability only while its own window is open, and a label this code coined never is.
// Historical rows stay on the card, each with its own status, evidence, timestamp and reset.
test("a provider card reports a refusal only while its window is current", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-card-status-"));
  const generatedAt = "2026-09-11T20:00:00.000Z";
  // Each case gets its own store: the real one is append-only, and a shared directory would let an
  // earlier case's rows decide a later case's card.
  let caseIndex = 0;
  const snapshot = (spec: readonly { readonly status: "healthy" | "limited" | "unknown" | "exhausted"; readonly resetAt: string | null; readonly evidence?: "native" | "measured" }[]) => {
    caseIndex += 1;
    const store = new GlobalQuotaStore(join(root, `global-${String(caseIndex)}`));
    try {
      spec.forEach((item, index) => {
        store.record({
          provider: "anthropic", quotaPool: "claude-subscription", metric: "window_utilization",
          window: `w${String(index)}`, value: 0.5, unit: "ratio", resetAt: item.resetAt, status: item.status,
          evidence: item.evidence ?? "native",
          source: (item.evidence ?? "native") === "native" ? "provider-rate-limit-event" : "brain-gate",
          observedAt: "2026-09-10T11:07:13.858Z",
        });
      });
      return buildDashboardSnapshot({ projects: [], quotaStore: store, generatedAt });
    } finally { store.close(); }
  };
  const statusOf = (spec: Parameters<typeof snapshot>[0]) => snapshot(spec).providers[0]!.status;

  // A refusal the provider stated, in a window that has not reset.
  assert.equal(statusOf([{ status: "exhausted", resetAt: "2026-09-12T08:00:00.000Z" }]), "exhausted");
  // The same refusal, after its window has passed: history, not availability.
  assert.equal(statusOf([{ status: "exhausted", resetAt: "2026-09-11T10:00:00.000Z" }]), "unknown");
  // A label this code coined is never availability, however recent the window.
  assert.equal(statusOf([{ status: "healthy", resetAt: "2026-09-12T08:00:00.000Z" }]), "unknown");
  assert.equal(statusOf([{ status: "limited", resetAt: "2026-09-11T10:00:00.000Z" }]), "unknown");
  // A refusal BrainGate inferred from its own traffic is not a provider statement either.
  assert.equal(statusOf([{ status: "exhausted", resetAt: "2026-09-12T08:00:00.000Z", evidence: "measured" }]), "unknown");

  // An expired refusal does not outrank a current utilisation reading, and both rows stay visible.
  const mixed = snapshot([
    { status: "exhausted", resetAt: "2026-09-11T10:00:00.000Z" },
    { status: "unknown", resetAt: "2026-09-12T08:00:00.000Z" },
  ]);
  assert.equal(mixed.providers[0]!.status, "unknown");
  assert.equal(mixed.providers[0]!.metrics.length, 2, "history is not hidden");
  assert.deepEqual(mixed.providers[0]!.metrics.map((row) => row.status), ["exhausted", "unknown"]);
  assert.equal(mixed.providers[0]!.metrics[0]!.resetAt, "2026-09-11T10:00:00.000Z", "the expired row keeps its own reset");
  // The card describes the window it is speaking about, so its own reset is the current one.
  assert.equal(mixed.providers[0]!.resetAt, "2026-09-12T08:00:00.000Z");
  const onlyExpired = snapshot([{ status: "exhausted", resetAt: "2026-09-11T10:00:00.000Z" }]);
  assert.equal(onlyExpired.providers[0]!.resetAt, null, "no current window, no current reset");
});

/**
 * The refusal backoff reaches routing without becoming a quota claim.
 *
 * Hydration is where a task's routing inputs are assembled, so it is where "BrainGate is avoiding
 * this pool for a few minutes" must arrive — as its own field, with `quotaState` untouched.
 */
test("hydration carries the refusal backoff and leaves quota state unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "braingate-backoff-hydrate-"));
  const catalog = new ModelCatalog(join(directory, "models.json"));
  const definition = (providerId: string, modelId: string, quotaPool: string, coder: number) => ({
    providerId, modelId, quotaPool, capabilities: { coder }, speed: "deep" as const, contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null,
  });
  catalog.upsert(definition("anthropic", "claude-sonnet", "claude-subscription", 90));
  catalog.upsert(definition("openai", "astra", "chatgpt-subscription", 80));
  const now = Date.parse("2026-09-12T01:05:00.000Z");
  const providers = ["anthropic", "openai"].map((providerId) => ({
    providerId, displayName: providerId, binary: providerId === "anthropic" ? "claude" : "codex",
    available: { value: true, evidence: "native" as const, sourceCommand: null, observedAt: "2026-09-12T00:00:00Z" },
    version: { value: "1.0.0", evidence: "native" as const, sourceCommand: null, observedAt: "2026-09-12T00:00:00Z" },
    authState: { value: "authenticated" as const, evidence: "native" as const, sourceCommand: null, observedAt: "2026-09-12T00:00:00Z" },
    authMode: { value: "subscription" as const, evidence: "native" as const, sourceCommand: null, observedAt: "2026-09-12T00:00:00Z" },
    models: { value: null, evidence: "unknown" as const, sourceCommand: null, observedAt: "2026-09-12T00:00:00Z" },
    capabilities: { value: null, evidence: "unknown" as const, sourceCommand: null, observedAt: "2026-09-12T00:00:00Z" },
    usage: { value: null, evidence: "unknown" as const, sourceCommand: null, observedAt: "2026-09-12T00:00:00Z" },
    removedBillingOverrides: [], warnings: [],
  }));
  const { runtimes } = hydrateModelRegistry({
    entries: catalog.load(),
    providers: providers as never,
    quota: [],
    backoff: [{ provider: "anthropic", quotaPool: "claude-subscription", policyBackoffUntil: "2026-09-12T01:15:00.000Z" }],
    now,
  });
  const anthropic = runtimes.find((entry) => entry.modelId === "claude-sonnet")!;
  const openai = runtimes.find((entry) => entry.modelId === "astra")!;
  assert.equal(anthropic.refusalBackoffUntil, "2026-09-12T01:15:00.000Z");
  assert.equal(anthropic.quotaState, "unknown", "a policy wait is not a quota verdict");
  assert.equal(anthropic.quotaHint, null);
  assert.equal(openai.refusalBackoffUntil, null);
  assert.equal(openai.quotaState, "unknown");
});
