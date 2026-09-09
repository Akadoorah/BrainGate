import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IsolationAttestationCache, codexIsolationFingerprint, grokIsolationFingerprint } from "./isolation-cache.js";

function cache(reuseMs = 30 * 60 * 1000) {
  let clock = 1_000_000_000;
  const store = new IsolationAttestationCache({
    path: join(mkdtempSync(join(tmpdir(), "braingate-isolation-cache-")), "isolation.json"),
    reuseMs,
    now: () => clock,
  });
  return { store, advance: (ms: number) => { clock += ms; } };
}

function grokHome(contents: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "braingate-fp-grok-"));
  for (const [name, body] of Object.entries(contents)) writeFileSync(join(home, name), body, "utf8");
  return home;
}

test("a proof is returned for the machine it was earned on", () => {
  const { store } = cache();
  store.write("xai", "fp-a", { source: "sandbox-event-self-test" });
  assert.deepEqual(store.read("xai", "fp-a"), { source: "sandbox-event-self-test" });
  assert.equal(store.read("xai", "fp-b"), null, "a different machine state is a different question");
  assert.equal(store.read("openai", "fp-a"), null, "one provider's proof says nothing about another's");
});

test("a proof is reused for a while, and not for as long as it claims to be valid", () => {
  const { store, advance } = cache(30 * 60 * 1000);
  store.write("xai", "fp", { attested: true });
  advance(29 * 60 * 1000);
  assert.notEqual(store.read("xai", "fp"), null);
  // The attestation itself is good for a day. Reuse deliberately stops far short: the entry
  // sits in the operator's own home, so the honest limit on trusting it is time.
  advance(2 * 60 * 1000);
  assert.equal(store.read("xai", "fp"), null);
});

test("a clock that moved backwards does not extend a proof", () => {
  const { store, advance } = cache();
  store.write("xai", "fp", { attested: true });
  advance(-60_000);
  assert.equal(store.read("xai", "fp"), null);
});

test("a corrupt or hand-edited cache is a miss, never a failure", () => {
  const { store } = cache();
  store.write("xai", "fp", { attested: true });
  writeFileSync(store.path, "{ not json", "utf8");
  assert.equal(store.read("xai", "fp"), null);
  writeFileSync(store.path, JSON.stringify({ schemaVersion: 99, entries: [] }), "utf8");
  assert.equal(store.read("xai", "fp"), null);
  // A row whose shape is wrong is dropped rather than handed back as an attestation.
  writeFileSync(store.path, JSON.stringify({ schemaVersion: 1, entries: [{ providerId: "xai", fingerprint: "fp", storedAt: "now", attestation: "not-an-object" }] }), "utf8");
  assert.equal(store.read("xai", "fp"), null);
});

test("clearing forgets every proof", () => {
  const { store } = cache();
  store.write("xai", "fp", { attested: true });
  store.clear();
  assert.equal(store.read("xai", "fp"), null);
});

// The expensive part of a self-test is spawning the provider; the part that goes stale fastest
// is the operator's own configuration. A version string cannot see either of these.
test("a sandbox profile the operator added since is a different machine", () => {
  const home = grokHome({ "config.toml": "[cli]\ninstaller = \"npm\"\n" });
  const binary = join(mkdtempSync(join(tmpdir(), "braingate-fp-bin-")), "grok");
  writeFileSync(binary, "#!/bin/sh\n", "utf8");
  const before = grokIsolationFingerprint({ GROK_HOME: home }, binary);

  // A same-named profile in the operator's own sandbox.toml silently takes precedence over the
  // one BrainGate writes, which is exactly what the self-test exists to catch.
  writeFileSync(join(home, "sandbox.toml"), "[profiles.braingate-staged]\nextends = \"devbox\"\n", "utf8");
  assert.notEqual(grokIsolationFingerprint({ GROK_HOME: home }, binary), before);
});

test("an MCP server added to the provider's home is a different machine", () => {
  const home = grokHome({ "config.toml": "[cli]\ninstaller = \"npm\"\n" });
  const binary = join(mkdtempSync(join(tmpdir(), "braingate-fp-bin2-")), "grok");
  writeFileSync(binary, "#!/bin/sh\n", "utf8");
  const before = grokIsolationFingerprint({ GROK_HOME: home }, binary);
  writeFileSync(join(home, "config.toml"), "[cli]\ninstaller = \"npm\"\n\n[mcp_servers.example]\ncommand = \"node\"\n", "utf8");
  assert.notEqual(grokIsolationFingerprint({ GROK_HOME: home }, binary), before);
});

test("a replaced provider binary is a different machine", () => {
  const home = grokHome();
  const directory = mkdtempSync(join(tmpdir(), "braingate-fp-bin3-"));
  const binary = join(directory, "grok");
  writeFileSync(binary, "#!/bin/sh\necho 1\n", "utf8");
  const before = grokIsolationFingerprint({ GROK_HOME: home }, binary);
  writeFileSync(binary, "#!/bin/sh\necho 2 and then some more bytes\n", "utf8");
  assert.notEqual(grokIsolationFingerprint({ GROK_HOME: home }, binary), before);
});

test("the same machine fingerprints the same, or the cache would never hit", () => {
  const home = grokHome({ "config.toml": "[cli]\n" });
  const binary = join(mkdtempSync(join(tmpdir(), "braingate-fp-bin4-")), "grok");
  writeFileSync(binary, "#!/bin/sh\n", "utf8");
  assert.equal(grokIsolationFingerprint({ GROK_HOME: home }, binary), grokIsolationFingerprint({ GROK_HOME: home }, binary));

  const codexHome = mkdtempSync(join(tmpdir(), "braingate-fp-codex-"));
  mkdirSync(join(codexHome, "generated_images"), { recursive: true });
  assert.equal(codexIsolationFingerprint({ CODEX_HOME: codexHome }, binary), codexIsolationFingerprint({ CODEX_HOME: codexHome }, binary));
});

test("a home that does not exist yet still fingerprints, rather than throwing", () => {
  // The first run on a fresh machine must not fail because there is nothing to hash.
  const binary = join(mkdtempSync(join(tmpdir(), "braingate-fp-bin5-")), "grok");
  writeFileSync(binary, "#!/bin/sh\n", "utf8");
  assert.match(grokIsolationFingerprint({ GROK_HOME: join(tmpdir(), "braingate-absent-home") }, binary), /^[0-9a-f]{32}$/);
});
