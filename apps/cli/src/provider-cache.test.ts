import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSnapshot } from "@braingate/providers";
import { IsolationAttestationCache, grokIsolationProfileHash, type GrokIsolationAttestation } from "@braingate/shadow";
import { grokIsolationStatus } from "./provider-proof.js";
import { ProviderSnapshotCache } from "./provider-cache.js";

function snapshots(label: string): readonly ProviderSnapshot[] {
  const observedAt = "2026-09-09T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return Object.freeze([{
    providerId: "anthropic" as const, displayName: label, binary: "claude",
    available: obs(true), version: obs(label), authState: obs("authenticated" as const), authMode: obs("subscription" as const),
    models: { value: null, evidence: "unknown" as const, sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown" as const, sourceCommand: null, observedAt },
    removedBillingOverrides: [], warnings: [],
  }]);
}

function harness(ttlMs = 60_000) {
  let calls = 0;
  let clock = 0;
  const cache = new ProviderSnapshotCache({
    discover: async () => { calls += 1; return snapshots(`probe-${String(calls)}`); },
    ttlMs,
    now: () => clock,
  });
  return { cache, calls: () => calls, advance: (ms: number) => { clock += ms; } };
}

test("a request probes once, however many times it asks", async () => {
  const h = harness();
  const lease = h.cache.lease();
  const [a, b, c] = await Promise.all([lease(), lease(), lease()]);
  assert.equal(h.calls(), 1);
  assert.equal(a[0]!.version.value, b[0]!.version.value);
  assert.equal(b[0]!.version.value, c[0]!.version.value);
});

test("the plan and the run of one request see the same machine", async () => {
  const h = harness(60_000);
  const lease = h.cache.lease();
  const planned = await lease();
  // The operator reads the plan and thinks about it. Even past the cache window, the run they
  // approved must be the run they were shown — routing to a provider the plan never named would
  // be a correctness failure, not just a surprise.
  h.advance(10 * 60_000);
  const ran = await lease();
  assert.equal(h.calls(), 1);
  assert.equal(planned[0]!.version.value, ran[0]!.version.value);
});

test("a later request reuses a recent probe, and re-measures a stale one", async () => {
  const h = harness(60_000);
  await h.cache.lease()();
  h.advance(30_000);
  await h.cache.lease()();
  assert.equal(h.calls(), 1, "nothing about the machine changes in thirty seconds");

  // But it can change while the session is open: a provider signed out, a CLI updated. A stale
  // "authenticated" is worse than a slow one.
  h.advance(60_001);
  await h.cache.lease()();
  assert.equal(h.calls(), 2);
});

test("a failed probe is not cached as the answer", async () => {
  let calls = 0;
  const cache = new ProviderSnapshotCache({
    discover: async () => {
      calls += 1;
      if (calls === 1) throw new Error("PATH was broken for a moment");
      return snapshots("recovered");
    },
  });
  await assert.rejects(() => cache.lease()());
  // The next request must try again rather than inherit a transient failure for the window.
  const recovered = await cache.lease()();
  assert.equal(recovered[0]!.version.value, "recovered");
  assert.equal(calls, 2);
});

test("invalidating forces the next request to measure again", async () => {
  const h = harness();
  await h.cache.lease()();
  h.cache.invalidate();
  await h.cache.lease()();
  assert.equal(h.calls(), 2);
});

// A remembered proof is a candidate, not a verdict. It is put through the same validation that
// accepted it when it was earned — against a snapshot taken moments ago — so an updated CLI or a
// changed policy falls through to a fresh self-test rather than being believed.
test("a remembered Grok proof is re-validated against the machine as it is now", async () => {
  const home = mkdtempSync(join(tmpdir(), "braingate-proof-home-"));
  writeFileSync(join(home, "config.toml"), "[cli]\n", "utf8");
  const binary = join(home, "grok");
  writeFileSync(binary, "#!/bin/sh\n", "utf8");
  const cache = new IsolationAttestationCache({ path: join(home, "isolation.json") });
  const env = { GROK_HOME: home };

  const grok = (version: string): ProviderSnapshot => {
    const observedAt = "2026-09-09T00:00:00.000Z";
    const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
    return {
      providerId: "xai", displayName: "Grok Build", binary,
      available: obs(true), version: obs(version), authState: obs("authenticated" as const), authMode: obs("subscription" as const),
      models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
      capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
      usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
      removedBillingOverrides: [], warnings: [],
    };
  };

  let selfTests = 0;
  const attestation = (version: string): GrokIsolationAttestation => ({
    providerId: "xai", source: "sandbox-event-self-test", version,
    platform: process.platform === "darwin" ? "darwin" : "linux",
    profileHash: grokIsolationProfileHash(), readableRoots: [], networkRestricted: false, configSurfaces: [],
    observedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const run = async (version: string) => await grokIsolationStatus({
    snapshots: [grok(version)], env, shouldAttempt: true, cache,
    verify: async () => { selfTests += 1; return attestation(version); },
  });

  const first = await run("grok 1.0.13");
  assert.equal(first.eligible, true);
  assert.equal(first.attempted, true, "the first command has to measure");

  const second = await run("grok 1.0.13");
  assert.equal(second.eligible, true);
  assert.equal(second.attempted, false, "the second must reuse rather than spawn the CLI again");
  assert.equal(selfTests, 1);

  // The operator updated Grok. The stored proof describes a build that is no longer installed,
  // so it says nothing about this one.
  const updated = await run("grok 1.1.0");
  assert.equal(updated.attempted, true, "an updated CLI must be measured again");
  assert.equal(selfTests, 2);
});
