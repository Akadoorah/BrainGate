import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import {
  CODEX_VISUAL_PROMPT,
  VISUAL_FEATURE,
  codexIsolationProfileHash,
  codexVisualDisabledFeatures,
  codexVisualFeatureKeys,
  planCodexVisualInvocation,
  type CodexIsolationAttestation,
} from "./index.js";

function snapshot(providerId: ProviderId = "openai", values: { auth?: "subscription" | "api" } = {}): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId, displayName: providerId, binary: "codex",
    available: obs(true), version: obs("1.0.0"),
    authState: obs("authenticated"), authMode: obs(values.auth ?? "subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    removedBillingOverrides: [], warnings: [],
  };
}

function isolation(values: Partial<CodexIsolationAttestation> = {}): CodexIsolationAttestation {
  const now = Date.now();
  return {
    providerId: "openai", source: "sandbox-self-test", version: "1.0.0",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    profileHash: codexIsolationProfileHash(), droppedFeatureKeys: [],
    observedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    ...values,
  };
}

const model: ModelRef = { providerId: "openai", modelId: "gpt-visual", quotaPool: "chatgpt-subscription" };
const payload = { schemaVersion: 1, role: "visual", task: "a hero image", context: {} };

function refuses(code: string) {
  return (error: unknown): boolean => error instanceof BrainGateInvariantError && error.code === code;
}

test("image generation is enabled, and only image generation", () => {
  const plan = planCodexVisualInvocation({ snapshot: snapshot(), model, cwd: "/tmp/x", payload, codexIsolation: isolation() });
  const command = plan.args.join(" ");
  assert.match(command, new RegExp(`features\\.${VISUAL_FEATURE}=true`));
  // Every other declared control stays off. Enabling one must not enable its neighbours.
  for (const key of codexVisualDisabledFeatures([])) {
    assert.match(command, new RegExp(`features\\.${key}=false`), `${key} should still be disabled`);
  }
  assert.doesNotMatch(command, new RegExp(`features\\.${VISUAL_FEATURE}=false`));
  assert.equal(codexVisualFeatureKeys([]).includes(VISUAL_FEATURE), false);
});

test("the workspace stays read-only, because the image is produced outside it", () => {
  const plan = planCodexVisualInvocation({ snapshot: snapshot(), model, cwd: "/tmp/x", payload, codexIsolation: isolation() });
  // Generation writes into the provider's own home, so nothing here is relaxed to allow it.
  assert.equal(plan.guarantees.noProjectWrites, true);
  assert.equal(plan.guarantees.projectOnlyRead, true);
  assert.equal(plan.guarantees.noShell, true);
  assert.equal(plan.guarantees.noMcp, true);
  assert.equal(plan.workspaceMode, "staged-clean");
  assert.doesNotMatch(plan.args.join(" "), /dangerously|--full-auto|--sandbox\b/);
});

test("a visual run needs the same isolation attestation a review does", () => {
  // Generation does not lower the bar for proving the sandbox holds; it raises the cost of it
  // not holding.
  assert.throws(
    () => planCodexVisualInvocation({ snapshot: snapshot(), model, cwd: "/tmp/x", payload }),
    refuses("VISUAL_ISOLATION_REQUIRED"),
  );
  assert.throws(
    () => planCodexVisualInvocation({ snapshot: snapshot(), model, cwd: "/tmp/x", payload, codexIsolation: isolation({ expiresAt: new Date(Date.now() - 1_000).toISOString() }) }),
    refuses("VISUAL_ISOLATION_REQUIRED"),
  );
});

test("API-billed authentication is refused, as everywhere else", () => {
  assert.throws(
    () => planCodexVisualInvocation({ snapshot: snapshot("openai", { auth: "api" }), model, cwd: "/tmp/x", payload, codexIsolation: isolation() }),
    refuses("VISUAL_API_AUTH_DENIED"),
  );
});

test("only the OpenAI provider has a visual profile today", () => {
  assert.throws(
    () => planCodexVisualInvocation({ snapshot: snapshot("anthropic"), model: { ...model, providerId: "anthropic" }, cwd: "/tmp/x", payload, codexIsolation: isolation() }),
    refuses("VISUAL_PROVIDER_UNSUPPORTED"),
  );
});

test("the prompt asks for a declaration and forbids inventing one", () => {
  assert.match(CODEX_VISUAL_PROMPT, /BRAINGATE_ARTIFACTS/);
  assert.match(CODEX_VISUAL_PROMPT, /read-only/);
  // Collection is by declared path, so an invented path must fail rather than be tolerated.
  assert.match(CODEX_VISUAL_PROMPT, /a path that does not exist fails the task/);
  assert.match(CODEX_VISUAL_PROMPT, /omit the block entirely/);
  // The task text travels on stdin, never in argv.
  const plan = planCodexVisualInvocation({ snapshot: snapshot(), model, cwd: "/tmp/x", payload, codexIsolation: isolation() });
  assert.doesNotMatch(plan.args.join(" "), /a hero image/);
  assert.match(plan.stdin ?? "", /a hero image/);
});
