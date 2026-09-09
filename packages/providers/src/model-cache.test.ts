import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelListCache, modelCacheKey } from "./model-cache.js";
import { ProviderDiscovery } from "./index.js";
import type { ProbeCommand, ProbeResult, ProbeRunner } from "./types.js";

function cacheAt(ttlMs = 60 * 60 * 1000, now = () => 1_000_000) {
  return new ModelListCache({ path: join(mkdtempSync(join(tmpdir(), "braingate-model-cache-")), "model-lists.json"), ttlMs, now });
}

test("a remembered list is returned until it ages out", () => {
  let clock = 1_000_000;
  const cache = new ModelListCache({ path: join(mkdtempSync(join(tmpdir(), "braingate-model-ttl-")), "c.json"), ttlMs: 60_000, now: () => clock });
  cache.write("k", ["a", "b"]);
  assert.deepEqual(cache.read("k"), ["a", "b"]);
  clock += 59_000;
  assert.deepEqual(cache.read("k"), ["a", "b"]);
  clock += 2_000;
  assert.equal(cache.read("k"), null, "a list older than the window is measured again");
});

test("a different CLI build does not inherit the previous one's answer", () => {
  const a = modelCacheKey({ providerId: "google", version: "1.1.27", command: "agy models" });
  const b = modelCacheKey({ providerId: "google", version: "1.1.28", command: "agy models" });
  // Updating a provider must invalidate its cache without anyone remembering to clear it.
  assert.notEqual(a, b);
  assert.notEqual(a, modelCacheKey({ providerId: "google", version: "1.1.27", command: "agy list-models" }));
});

test("an unreadable or tampered cache is a miss, never a failure", () => {
  const cache = cacheAt();
  assert.equal(cache.read("missing"), null);
  writeFileSync(cache.path, "{ not json", "utf8");
  assert.equal(cache.read("k"), null);
  writeFileSync(cache.path, JSON.stringify({ schemaVersion: 99, entries: [] }), "utf8");
  assert.equal(cache.read("k"), null);
  // A row whose shape is wrong is dropped rather than trusted into a snapshot.
  writeFileSync(cache.path, JSON.stringify({ schemaVersion: 1, entries: [{ key: "k", models: [1, 2], observedAt: "x" }] }), "utf8");
  assert.equal(cache.read("k"), null);
});

test("an entry stamped in the future is not trusted", () => {
  const cache = new ModelListCache({ path: join(mkdtempSync(join(tmpdir(), "braingate-model-future-")), "c.json"), now: () => 1_000_000 });
  writeFileSync(cache.path, JSON.stringify({ schemaVersion: 1, entries: [{ key: "k", models: ["a"], observedAt: new Date(1_000_000 + 10 * 60_000).toISOString() }] }), "utf8");
  assert.equal(cache.read("k"), null);
});

class CountingRunner implements ProbeRunner {
  readonly seen: string[] = [];
  constructor(private readonly stdout: (command: ProbeCommand) => string) {}
  async run(command: ProbeCommand): Promise<ProbeResult> {
    const text = `${command.binary} ${command.args.join(" ")}`;
    this.seen.push(text);
    return {
      command, spawned: true, exitCode: 0, stdout: this.stdout(command), stderr: "", timedOut: false,
      errorCode: null, observedAt: "2026-09-09T00:00:00.000Z", removedBillingOverrides: [],
    };
  }
}

test("the slowest probe is skipped once its answer is known", async () => {
  const cache = cacheAt();
  const listing = (command: ProbeCommand) => command.args.join(" ") === "models" ? "gemini-3.8-flash-low\ngemini-3.1-pro-high\n" : "1.1.27 --print --model json mcp";

  const first = new CountingRunner(listing);
  const before = await new ProviderDiscovery(first, { modelCache: cache }).discover("google");
  assert.deepEqual(before.models.value, ["gemini-3.8-flash-low", "gemini-3.1-pro-high"]);
  assert.ok(first.seen.includes("agy models"));

  const second = new CountingRunner(listing);
  const after = await new ProviderDiscovery(second, { modelCache: cache }).discover("google");
  assert.equal(second.seen.includes("agy models"), false, "the network round trip must not be repeated");
  // Still the provider's own answer to its own command, read back rather than asked again.
  assert.deepEqual(after.models.value, ["gemini-3.8-flash-low", "gemini-3.1-pro-high"]);
  assert.equal(after.models.evidence, "native");
});

test("a provider whose model command also reports sign-in is never cached", async () => {
  const cache = cacheAt();
  const listing = () => "You are logged in with grok.com.\n  * grok-4.6 (default)\n";

  const first = new CountingRunner(listing);
  await new ProviderDiscovery(first, { modelCache: cache }).discover("xai");
  const second = new CountingRunner(listing);
  const after = await new ProviderDiscovery(second, { modelCache: cache }).discover("xai");

  // A cached "signed in" that outlives a sign-out routes work to a provider that will refuse
  // it. Where one command answers both questions, the second is what decides.
  assert.ok(second.seen.includes("grok models"), "authentication must be measured every time");
  assert.equal(after.authState.value, "authenticated");
});
