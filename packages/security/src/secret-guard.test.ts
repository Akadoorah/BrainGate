import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrainGateInvariantError } from "@braingate/core";
import { SecretGuard, isSensitivePath, redactSecrets } from "./index.js";

test("sensitive path policy blocks common credentials", () => {
  for (const path of [".env", ".env.production", ".ssh/id_ed25519", ".aws/credentials", "cert.pem", ".npmrc", ".docker/config.json"]) {
    assert.equal(isSensitivePath(path), true, path);
  }
  assert.equal(isSensitivePath("src/config.ts"), false);
});

test("read guard blocks sensitive files and symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-secret-"));
  const outside = mkdtempSync(join(tmpdir(), "braingate-outside-"));
  writeFileSync(join(root, ".env"), "SECRET=x");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "safe.ts"), "export {};");
  writeFileSync(join(outside, "secret.txt"), "secret");
  try { symlinkSync(join(outside, "secret.txt"), join(root, "src", "escape")); } catch { /* platform may disallow symlinks */ }
  const guard = new SecretGuard();
  assert.match(guard.assertReadablePath(root, "src/safe.ts"), /safe\.ts$/);
  assert.throws(() => guard.assertReadablePath(root, ".env"), (e: unknown) => e instanceof BrainGateInvariantError && e.code === "SECRET_PATH_BLOCKED");
  if (require("node:fs").existsSync(join(root, "src", "escape"))) {
    assert.throws(() => guard.assertReadablePath(root, "src/escape"), (e: unknown) => e instanceof BrainGateInvariantError && e.code === "SECRET_PATH_ESCAPE");
  }
});

test("output redaction removes common token formats", () => {
  const raw = "OPENAI=sk-abcdefghijklmnopqrstuvwxyz012345 github=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 password=hunter-hunter-123";
  const redacted = redactSecrets(raw);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redacted, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
  assert.doesNotMatch(redacted, /hunter-hunter/);
  assert.match(redacted, /REDACTED/);
});

test("execution environment is allowlisted and direct-billing keys are always removed", () => {
  const guard = new SecretGuard();
  const result = guard.buildEnvironment({ PATH: "/bin", HOME: "/home/test", RANDOM_SECRET: "x", OPENAI_API_KEY: "paid", GH_TOKEN: "account" }, { allowedAdditionalKeys: ["GH_TOKEN"] });
  assert.equal(result.env.PATH, "/bin");
  assert.equal(result.env.GH_TOKEN, "account");
  assert.equal(result.env.OPENAI_API_KEY, undefined);
  assert.equal(result.env.RANDOM_SECRET, undefined);
  assert.throws(() => guard.buildEnvironment({}, { allowedAdditionalKeys: ["OPENAI_API_KEY"], overrides: { OPENAI_API_KEY: "x" } }));
});
