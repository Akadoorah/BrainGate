import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalQuotaStore } from "./quota-store.js";
import { POOL_LOAD_METRIC, loadShareFrom, poolLoad, recordPoolLoad, recordPoolSpend } from "./local-load.js";

function store() {
  return new GlobalQuotaStore(mkdtempSync(join(tmpdir(), "braingate-local-load-")));
}

const AT = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

test("the busiest pool scores one and the quietest zero", () => {
  const quota = store();
  try {
    recordPoolSpend(quota, [{ provider: "anthropic", quotaPool: "claude-subscription", tokens: 90_000 }], AT(10));
    recordPoolSpend(quota, [{ provider: "google", quotaPool: "antigravity-subscription", tokens: 10_000 }], AT(9));
    const loads = poolLoad(quota);
    const claude = loads.find((entry) => entry.quotaPool === "claude-subscription")!;
    const gemini = loads.find((entry) => entry.quotaPool === "antigravity-subscription")!;
    assert.equal(claude.share, 1);
    assert.equal(gemini.share, 0);
    assert.equal(claude.tokens, 90_000);
  } finally { quota.close(); }
});

test("spend accumulates within the window and ages out of it", () => {
  const quota = store();
  try {
    recordPoolSpend(quota, [{ provider: "anthropic", quotaPool: "claude-subscription", tokens: 1_000 }], AT(30));
    recordPoolSpend(quota, [{ provider: "anthropic", quotaPool: "claude-subscription", tokens: 2_000 }], AT(10));
    recordPoolSpend(quota, [{ provider: "xai", quotaPool: "grok-subscription", tokens: 500 }], AT(10));
    assert.equal(poolLoad(quota).find((entry) => entry.provider === "anthropic")!.tokens, 3_000);
    // A pool that was busy this morning is not busy now.
    assert.equal(poolLoad(quota, { windowMs: 20 * 60_000 }).find((entry) => entry.provider === "anthropic")!.tokens, 2_000);
  } finally { quota.close(); }
});

// Codex and Copilot report no token counts. Reading silence as "idle" would send them
// everything — a measurement gap turned into a routing preference.
test("a pool nobody measured gets no signal, never a zero", () => {
  const quota = store();
  try {
    recordPoolSpend(quota, [
      { provider: "anthropic", quotaPool: "claude-subscription", tokens: 50_000 },
      { provider: "xai", quotaPool: "grok-subscription", tokens: 5_000 },
    ], AT(5));
    recordPoolLoad(quota);
    const snapshots = quota.latest();
    assert.equal(loadShareFrom(snapshots, "anthropic", "claude-subscription"), 1);
    assert.equal(loadShareFrom(snapshots, "xai", "grok-subscription"), 0);
    // Never measured, so nothing is claimed about it in either direction.
    assert.equal(loadShareFrom(snapshots, "openai", "chatgpt-subscription"), null);
  } finally { quota.close(); }
});

test("one measured pool is not a comparison", () => {
  const quota = store();
  try {
    recordPoolSpend(quota, [{ provider: "anthropic", quotaPool: "claude-subscription", tokens: 50_000 }], AT(5));
    // Relative load needs something to be relative to; a lonely 1.0 would penalise the only pool
    // there is for the crime of being used.
    assert.equal(poolLoad(quota)[0]?.share, null);
    assert.deepEqual(recordPoolLoad(quota).map((entry) => entry.share), [null]);
    assert.equal(loadShareFrom(quota.latest(), "anthropic", "claude-subscription"), null);
  } finally { quota.close(); }
});

test("pools carrying the same load produce no reason to move work", () => {
  const quota = store();
  try {
    recordPoolSpend(quota, [
      { provider: "anthropic", quotaPool: "claude-subscription", tokens: 10_000 },
      { provider: "xai", quotaPool: "grok-subscription", tokens: 10_000 },
    ], AT(5));
    assert.deepEqual(poolLoad(quota).map((entry) => entry.share), [0, 0]);
  } finally { quota.close(); }
});

test("the local reading is recorded as measured, under its own name", () => {
  const quota = store();
  try {
    recordPoolSpend(quota, [
      { provider: "anthropic", quotaPool: "claude-subscription", tokens: 9_000 },
      { provider: "xai", quotaPool: "grok-subscription", tokens: 1_000 },
    ], AT(5));
    recordPoolLoad(quota);
    const row = quota.latest().find((entry) => entry.metric === POOL_LOAD_METRIC && entry.provider === "anthropic")!;
    // Not `pressure`, and not `native`: a provider that one day reports a real remaining balance
    // must outrank BrainGate's account of its own traffic, and a receipt must be able to say
    // which of the two it used.
    assert.equal(row.evidence, "measured");
    assert.equal(row.unit, "ratio");
    assert.notEqual(row.metric, "pressure");
    // Load is not health: a busy pool is still a working one.
    assert.equal(row.status, "unknown");
  } finally { quota.close(); }
});

test("nothing is recorded for a spend of zero or a nonsense count", () => {
  const quota = store();
  try {
    recordPoolSpend(quota, [
      { provider: "anthropic", quotaPool: "claude-subscription", tokens: 0 },
      { provider: "xai", quotaPool: "grok-subscription", tokens: Number.NaN },
      { provider: "google", quotaPool: "antigravity-subscription", tokens: -5 },
    ], AT(5));
    assert.deepEqual(poolLoad(quota), []);
  } finally { quota.close(); }
});
