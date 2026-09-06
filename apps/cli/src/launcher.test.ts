import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("packaged launcher starts the CLI without provider activity", () => {
  const launcher = fileURLToPath(new URL("../bin/braingate.mjs", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "braingate-launcher-"));
  const result = spawnSync(process.execPath, [launcher, "help", "--json"], {
    encoding: "utf8",
    env: { ...process.env, BRAINGATE_HOME: home },
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { commands?: string[] };
  assert.ok(parsed.commands?.includes("shadow"));
  assert.equal(result.stderr, "");
});
