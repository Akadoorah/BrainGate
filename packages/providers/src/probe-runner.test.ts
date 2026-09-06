import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError } from "@braingate/core";
import {
  assertSafeProbeCommand,
  sanitizeSubscriptionEnvironment,
  SUBSCRIPTION_BILLING_OVERRIDE_ENV,
} from "./index.js";

test("subscription environment strips known direct-billing overrides without removing GitHub account auth", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/bin",
    GH_TOKEN: "github-account-token",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    GEMINI_API_KEY: "secret",
    XAI_API_KEY: "secret",
    COPILOT_PROVIDER_API_KEY: "secret",
  };
  const sanitized = sanitizeSubscriptionEnvironment(base);

  assert.equal(sanitized.env.PATH, "/bin");
  assert.equal(sanitized.env.GH_TOKEN, "github-account-token");
  for (const key of SUBSCRIPTION_BILLING_OVERRIDE_ENV) assert.equal(sanitized.env[key], undefined);
  assert.deepEqual(sanitized.removed, [
    "ANTHROPIC_API_KEY",
    "COPILOT_PROVIDER_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
  ]);
});

test("probe command whitelist rejects prompts, login and mutating commands", () => {
  assert.doesNotThrow(() => assertSafeProbeCommand({ binary: "claude", args: ["--version"] }));
  assert.doesNotThrow(() => assertSafeProbeCommand({ binary: "agy", args: ["models"] }));

  for (const command of [
    { binary: "claude", args: ["-p", "hello"] },
    { binary: "codex", args: ["exec", "hello"] },
    { binary: "copilot", args: ["login"] },
    { binary: "grok", args: ["update"] },
    { binary: "agy", args: ["-p", "hello"] },
  ]) {
    assert.throws(
      () => assertSafeProbeCommand(command),
      (error: unknown) => error instanceof BrainGateInvariantError && error.code === "PROVIDER_PROBE_UNSAFE",
    );
  }
});
