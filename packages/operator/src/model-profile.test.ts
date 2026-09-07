import test from "node:test";
import assert from "node:assert/strict";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { analyzeModelCoverage } from "./model-profile.js";

function configured(providerId: string, modelId: string, speed: "fast" | "balanced" | "deep", coder: number, reviewer: number, quotaPool = `${providerId}:subscription`): ModelCatalogEntry {
  return {
    providerId,
    modelId,
    configured: true,
    definition: {
      providerId,
      modelId,
      quotaPool,
      capabilities: { coder, reviewer, judge: reviewer },
      speed,
      contextCapacity: 200_000,
      writeCapable: true,
      reasoning: coder,
      underlyingFamily: null,
    },
  };
}

test("single provider with multiple models reports graded reviewer independence and T0-T4 coverage", () => {
  const profile = analyzeModelCoverage([
    configured("anthropic", "fast", "fast", 60, 55),
    configured("anthropic", "balanced", "balanced", 80, 82),
    configured("anthropic", "deep", "deep", 95, 96),
  ]);
  assert.equal(profile.singleProviderMode, true);
  assert.equal(profile.reviewerIndependence, "same-provider-different-model");
  assert.deepEqual(profile.coverage, { T0: true, T1: true, T2: true, T3: true, T4: true });
  assert.deepEqual(profile.providers[0]?.speeds, ["fast", "balanced", "deep"]);
});

test("multiple providers expose cross-provider review", () => {
  const profile = analyzeModelCoverage([
    configured("anthropic", "one", "balanced", 90, 90),
    configured("openai", "two", "deep", 90, 90),
  ]);
  assert.equal(profile.singleProviderMode, false);
  assert.equal(profile.reviewerIndependence, "cross-provider");
});

test("multiple quota pools on one provider produce an explicit warning", () => {
  const profile = analyzeModelCoverage([
    configured("anthropic", "one", "fast", 70, 70, "anthropic:a"),
    configured("anthropic", "two", "deep", 90, 90, "anthropic:b"),
  ]);
  assert.ok(profile.warnings.some((warning) => warning.includes("multiple quota pools")));
});
