import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "@braingate/router";
import type { ProviderSnapshot } from "@braingate/providers";
import { ModelCatalog } from "./model-catalog.js";
import {
  DEFAULT_MODEL_PROFILES,
  KNOWN_MODELS_WITHOUT_LISTING,
  adoptDiscoveredModels,
  defaultProfileFor,
  planModelAdoption,
  profileRoles,
} from "./default-model-profiles.js";

/**
 * The starting scores, held to the same standard as the operator's own.
 *
 * Two things are being pinned. That every default is a definition the router would accept — a
 * profile that fails validation turns the first run into a stack trace, which is worse than the
 * empty catalogue it replaced. And that adoption is additive: the operator's scores are their
 * data, and the whole point of `/setup` being rerunnable is that rerunning it cannot undo them.
 */

function catalogPath(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `braingate-defaults-${label}-`)), "models.json");
}

/** A discovery snapshot with whatever the CLI listed — `null` for the ones that list nothing. */
function snapshot(providerId: string, binary: string, models: readonly string[] | null, available = true): ProviderSnapshot {
  const observedAt = "2026-09-19T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId, displayName: providerId, binary,
    available: obs(available),
    version: obs("1.0.0"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: obs(models === null ? null : [...models]),
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: obs(null),
    removedBillingOverrides: Object.freeze([]),
    warnings: Object.freeze([]),
  } as unknown as ProviderSnapshot;
}

/** The ids the installed CLIs listed on 2026-09-19, verbatim. */
const GROK_MODELS = ["grok-4.6", "grok-4.5"];
const AGY_MODELS = [
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  "gemini-3.1-pro-high", "gemini-3.1-pro-low",
  "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
];

test("every default profile is a definition the router accepts", () => {
  for (const row of DEFAULT_MODEL_PROFILES) {
    const registry = new ModelRegistry();
    // The id is a placeholder that matches the row, so the identity rules are exercised too.
    const modelId = row.providerId === "anthropic" ? "claude-x-1" : row.providerId === "google" ? "gemini-x-1" : row.providerId === "xai" ? "grok-4.9" : "gpt-x-1";
    const registered = registry.register(
      {
        providerId: row.providerId, modelId,
        quotaPool: row.profile.quotaPool,
        capabilities: row.profile.capabilities,
        speed: row.profile.speed,
        contextCapacity: row.profile.contextCapacity,
        writeCapable: row.profile.writeCapable,
        reasoning: row.profile.reasoning,
        underlyingFamily: null,
      },
      { available: false, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: "2026-09-19T00:00:00.000Z" },
    );
    assert.equal(registered.definition.providerId, row.providerId);
    assert.ok(profileRoles(row.profile).length > 0, `${row.family} has no role at all`);
  }
});

test("the ids the installed CLIs list today map to the roles they are chosen for", () => {
  // Measured 2026-09-19: `grok models` on grok 1.0.30, `agy models` on agy 1.2.7.
  assert.deepEqual(profileRoles(defaultProfileFor("xai", "grok-4.6")!), ["coder", "reviewer"]);
  assert.deepEqual(profileRoles(defaultProfileFor("xai", "grok-4.5")!), ["coder", "reviewer"]);
  assert.deepEqual(profileRoles(defaultProfileFor("google", "gemini-3.1-pro-high")!), ["planner", "reviewer"]);
  assert.deepEqual(profileRoles(defaultProfileFor("google", "gemini-3.8-flash-medium")!), ["coder"]);
  assert.equal(defaultProfileFor("google", "gemini-3.8-flash-low")!.speed, "fast");
  assert.equal(defaultProfileFor("google", "gemini-3.1-pro-low")!.speed, "deep");

  // The operator's catalogue ids, which the two CLIs without a listing are assumed to accept.
  assert.deepEqual(profileRoles(defaultProfileFor("anthropic", "claude-opus-5")!), ["planner", "reviewer", "judge"]);
  assert.deepEqual(profileRoles(defaultProfileFor("anthropic", "claude-fable-5-1")!), ["planner", "reviewer", "judge"]);
  assert.deepEqual(profileRoles(defaultProfileFor("anthropic", "claude-sonnet-5")!), ["coder", "reviewer"]);
  assert.deepEqual(profileRoles(defaultProfileFor("anthropic", "claude-haiku-4-5")!), ["coder"]);
  assert.deepEqual(profileRoles(defaultProfileFor("openai", "gpt-6-astra")!), ["coder", "reviewer"]);
});

test("an id no row claims scores nothing, including a model another provider serves", () => {
  assert.equal(defaultProfileFor("anthropic", "some-unreleased-thing"), null);
  assert.equal(defaultProfileFor("xai", "grok-3-mini"), null);
  // `agy models` lists these; they are reached through the Antigravity subscription and are not
  // the Anthropic or OpenAI one, so guessing their pool would put two bills in one bucket.
  assert.equal(defaultProfileFor("google", "claude-sonnet-4-6"), null);
  assert.equal(defaultProfileFor("google", "claude-opus-4-6-thinking"), null);
  assert.equal(defaultProfileFor("google", "gpt-oss-120b-medium"), null);
  // Every known-without-listing id must itself be claimed by a row, or it could never be adopted.
  for (const known of KNOWN_MODELS_WITHOUT_LISTING) {
    assert.notEqual(defaultProfileFor(known.providerId, known.modelId), null, `${known.providerId}/${known.modelId} matches no row`);
  }
});

test("adoption scores what it recognises, imports what it does not, and labels both", () => {
  const catalog = new ModelCatalog(catalogPath("adopt"));
  const result = adoptDiscoveredModels(catalog, [
    snapshot("xai", "grok", GROK_MODELS),
    snapshot("google", "agy", AGY_MODELS),
    snapshot("anthropic", "claude", null),
    snapshot("openai", "codex", null),
  ]);

  assert.deepEqual(result.adopted.map((row) => `${row.providerId}/${row.modelId}`).sort(), [
    "google/gemini-3.1-pro-high", "google/gemini-3.1-pro-low",
    "google/gemini-3.8-flash-high", "google/gemini-3.8-flash-low", "google/gemini-3.8-flash-medium",
    "xai/grok-4.5", "xai/grok-4.6",
  ]);
  assert.deepEqual(result.assumed.map((row) => `${row.providerId}/${row.modelId}`).sort(), [
    "anthropic/claude-fable-5-1", "anthropic/claude-haiku-4-5", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5",
    "openai/gpt-6-astra",
  ]);
  assert.deepEqual(result.unscored.map((row) => `${row.providerId}/${row.modelId}`).sort(), [
    "google/claude-opus-4-6-thinking", "google/claude-sonnet-4-6", "google/gpt-oss-120b-medium",
  ]);
  assert.equal(result.kept.length, 0);

  // The origin is what the operator reads, and it has to name the command it came from.
  assert.match(result.adopted.find((row) => row.providerId === "google")!.origin, /from agy models/);
  assert.match(result.assumed.find((row) => row.providerId === "anthropic")!.origin, /assumed: claude lists no models/);

  // Adopted entries carry the label; unmatched ones carry no scores at all.
  const entries = catalog.load();
  const grok = entries.find((entry) => entry.modelId === "grok-4.6")!;
  assert.equal(grok.configured, true);
  assert.equal(grok.configured ? grok.source : null, "braingate-default");
  const claude = entries.find((entry) => entry.modelId === "claude-sonnet-5")!;
  assert.equal(claude.configured ? claude.source : null, "braingate-assumed");
  assert.equal(entries.find((entry) => entry.modelId === "gpt-oss-120b-medium")!.configured, false);
});

test("a model the operator scored is kept, and never re-scored by a rerun", () => {
  const path = catalogPath("kept");
  const catalog = new ModelCatalog(path);
  catalog.upsert({
    providerId: "xai", modelId: "grok-4.6", quotaPool: "grok-subscription",
    capabilities: { coder: 99 }, speed: "deep", contextCapacity: 256_000,
    writeCapable: true, reasoning: 99, underlyingFamily: null,
  });

  const first = adoptDiscoveredModels(catalog, [snapshot("xai", "grok", GROK_MODELS)]);
  assert.deepEqual(first.kept.map((row) => row.modelId), ["grok-4.6"]);
  assert.deepEqual(first.adopted.map((row) => row.modelId), ["grok-4.5"]);

  const afterFirst = catalog.load().find((entry) => entry.modelId === "grok-4.6")!;
  assert.equal(afterFirst.configured ? afterFirst.definition.capabilities.coder : null, 99, "the operator's score was overwritten");
  assert.equal(afterFirst.configured ? afterFirst.source : "absent", undefined, "the operator's entry was relabelled");

  // Rerunning is the whole point of `/setup` being safe: the second pass changes nothing.
  const before = readFileSync(path, "utf8");
  const second = adoptDiscoveredModels(catalog, [snapshot("xai", "grok", GROK_MODELS)]);
  assert.deepEqual(second.kept.map((row) => row.modelId).sort(), ["grok-4.5", "grok-4.6"]);
  assert.equal(second.adopted.length, 0);
  assert.equal(readFileSync(path, "utf8"), before, "a rerun rewrote the catalogue");
});

test("a CLI that is not installed offers nothing, and a listing CLI never falls back to assumptions", () => {
  const catalog = new ModelCatalog(catalogPath("absent"));
  const rows = planModelAdoption(catalog.load(), [
    snapshot("anthropic", "claude", null, false),
    snapshot("xai", "grok", GROK_MODELS),
  ]);
  assert.equal(rows.some((row) => row.providerId === "anthropic"), false, "a missing binary was offered anyway");
  assert.equal(rows.every((row) => row.disposition === "adopt"), true);

  // A CLI that lists models is taken at its word: the assumed ids are for the ones that list none.
  const listed = planModelAdoption(catalog.load(), [snapshot("anthropic", "claude", ["claude-sonnet-5"])]);
  assert.deepEqual(listed.map((row) => row.modelId), ["claude-sonnet-5"]);
  assert.match(listed[0]!.origin, /from claude models/);
});

test("Codex's cached list adopts the gpt ids, leaves its own review model unscored, and names the file", () => {
  const catalog = new ModelCatalog(catalogPath("codex-cache"));
  const base = snapshot("openai", "codex", ["gpt-6-astra", "gpt-5.6-sol", "gpt-reserve", "codex-auto-review"]);
  const codex = { ...base, models: { ...base.models, sourceCommand: "/Users/someone/.codex/models_cache.json" } } as ProviderSnapshot;
  const rows = planModelAdoption(catalog.load(), [codex]);
  const byId = Object.fromEntries(rows.map((row) => [row.modelId, row]));
  assert.equal(byId["gpt-6-astra"]?.disposition, "adopt");
  assert.equal(byId["gpt-5.6-sol"]?.disposition, "adopt");
  assert.equal(byId["gpt-reserve"]?.disposition, "adopt");
  assert.equal(byId["codex-auto-review"]?.disposition, "unscored", "Codex's approval-review model is not a worker anyone routes to");
  assert.equal(byId["gpt-6-astra"]?.origin, "from ~/.codex/models_cache.json", "the wizard says where the list came from, with the home elided");
  assert.equal(rows.some((row) => row.disposition === "assume"), false, "nothing is assumed once the CLI's own list is there");
});
