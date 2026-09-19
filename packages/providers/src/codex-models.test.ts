import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexHomePath, readCodexModelCache } from "./codex-models.js";

/** The shape codex-cli 0.153.4 writes (2026-09-20), trimmed to what is read. */
const CACHE = JSON.stringify({
  fetched_at: "2026-09-19T20:57:53Z",
  models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra" },
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
    { slug: "codex-auto-review", display_name: "Codex Auto Review" },
    { slug: "", display_name: "nameless" },
    { display_name: "no slug at all" },
  ],
});

test("the models Codex cached for its own picker are read back, in its order", () => {
  const home = mkdtempSync(join(tmpdir(), "braingate-codex-"));
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "models_cache.json"), CACHE);
    const read = readCodexModelCache({ env: { HOME: home } });
    assert.equal(read.present, true);
    assert.deepEqual([...read.models], ["gpt-6-astra", "gpt-5.6-sol", "codex-auto-review"], "every slug, nothing invented for entries without one");
    assert.equal(read.path, join(home, ".codex", "models_cache.json"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("CODEX_HOME wins over HOME, and an environment naming neither reads nothing", () => {
  const custom = mkdtempSync(join(tmpdir(), "braingate-codex-home-"));
  try {
    writeFileSync(join(custom, "models_cache.json"), CACHE);
    assert.equal(codexHomePath({ CODEX_HOME: custom, HOME: "/nowhere" }), custom);
    assert.equal(readCodexModelCache({ env: { CODEX_HOME: custom } }).models.length, 3);
    const nothing = readCodexModelCache({ env: {} });
    assert.equal(nothing.present, false);
    assert.deepEqual([...nothing.models], []);
  } finally { rmSync(custom, { recursive: true, force: true }); }
});

test("an unreadable cache is absent, not a list", () => {
  assert.equal(readCodexModelCache({ text: "{ not json" }).present, false);
  assert.equal(readCodexModelCache({ text: JSON.stringify({ models: "gpt-6-astra" }) }).models.length, 0);
});
