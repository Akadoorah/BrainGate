import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetFor, classifyTask } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type ModelDefinition } from "@braingate/router";
import { ModelCatalog, hydrateModelRegistry, resolveOperatorState } from "./index.js";

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
  assert.equal(unknown.runtimes[0]?.quotaPressure, null);

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

