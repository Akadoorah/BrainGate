import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderSnapshot } from "@braingate/providers";
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
