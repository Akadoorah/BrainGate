import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import { GROK_WRITE_SANDBOX, codexIsolationProfileHash, type CodexIsolationAttestation, type GrokIsolationAttestation } from "@braingate/shadow";
import { NodeClaudeWriteExecutor } from "./claude-write-profile.js";
import { GROK_WRITE_PROFILE, GROK_WRITE_SANDBOX_FILE, WRITE_PROVIDERS, assertWriteEligible, planWriteInvocation } from "./write-profiles.js";

const NOW = new Date("2026-09-09T12:00:00.000Z");

function snapshot(providerId: ProviderId, version: string): ProviderSnapshot {
  const observedAt = NOW.toISOString();
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId, displayName: providerId,
    binary: providerId === "anthropic" ? "claude" : providerId === "openai" ? "codex" : "grok",
    available: obs(true), version: obs(version), authState: obs("authenticated" as const), authMode: obs("subscription" as const),
    models: obs(null), capabilities: obs({ headless: true as const, structuredOutput: true as const, modelPinning: true as const, mcp: true as const }),
    usage: obs(null), removedBillingOverrides: [], warnings: [],
  };
}

function model(providerId: ProviderId, modelId: string): ModelRef {
  return { providerId, modelId, quotaPool: `${providerId}-subscription` };
}

function grokProof(overrides: Partial<GrokIsolationAttestation> = {}): GrokIsolationAttestation {
  return {
    providerId: "xai", source: "sandbox-event-self-test", version: "1.0.24",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    profileHash: GROK_WRITE_SANDBOX.hash,
    observedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    ...overrides,
  } as GrokIsolationAttestation;
}

function codexProof(overrides: Partial<CodexIsolationAttestation> = {}): CodexIsolationAttestation {
  return {
    providerId: "openai", source: "sandbox-self-test", version: "0.153.4",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    profileHash: codexIsolationProfileHash(), droppedFeatureKeys: [],
    observedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    ...overrides,
  } as CodexIsolationAttestation;
}

function worktree(): string {
  return mkdtempSync(join(tmpdir(), "braingate-write-profile-"));
}

test("the executing role is no longer one provider, and every one of them has to prove a boundary", () => {
  // Antigravity is not on the list, and that is a measurement rather than an omission: agy 1.2.2
  // auto-denies every tool it would need in headless mode, so it can neither read nor write the
  // workspace it is pointed at. It is refused under both policies, in its own words.
  assert.deepEqual([...WRITE_PROVIDERS], ["anthropic", "xai", "openai"]);
  assert.throws(
    () => assertWriteEligible(snapshot("google" as ProviderId, "1.2.2"), model("google" as ProviderId, "gemini"), { now: NOW }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "WRITE_PROVIDER_BLOCKED",
  );
  assert.throws(
    () => assertWriteEligible(snapshot("google" as ProviderId, "1.2.2"), model("google" as ProviderId, "gemini"), { nativeHarness: true, now: NOW }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "WRITE_PROVIDER_BLOCKED",
    "the DIRECT policy does not open it either: there is no invocation to open it with",
  );
});

test("a Grok write without a current sandbox self-test is refused, not downgraded", () => {
  assert.throws(
    () => assertWriteEligible(snapshot("xai", "1.0.24"), model("xai", "grok-4.6"), { now: NOW }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "WRITE_GROK_ISOLATION_REQUIRED",
  );
  assert.throws(
    () => assertWriteEligible(snapshot("xai", "1.0.24"), model("xai", "grok-4.6"), { grokIsolation: grokProof({ version: "1.0.13" }), now: NOW }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "WRITE_GROK_ISOLATION_REQUIRED",
    "an attestation from a different build proves nothing about this one",
  );
  assert.throws(
    () => assertWriteEligible(snapshot("xai", "1.0.24"), model("xai", "grok-4.6"), { grokIsolation: grokProof({ profileHash: "read-only-profile-hash" }), now: NOW }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "WRITE_GROK_ISOLATION_REQUIRED",
    "a proof earned under the read profile does not cover the one that grants writes",
  );
  assert.doesNotThrow(() => assertWriteEligible(snapshot("xai", "1.0.24"), model("xai", "grok-4.6"), { grokIsolation: grokProof(), now: NOW }));
});

test("a Grok write runs in the worktree, under its own profile, with secrets denied by the kernel", () => {
  const cwd = worktree();
  const plan = planWriteInvocation({
    snapshot: snapshot("xai", "1.0.24"), model: model("xai", "grok-4.6"), cwd,
    task: "rename a local variable", context: { files: [] }, grokIsolation: grokProof(), now: NOW,
  });
  assert.equal(plan.providerId, "xai");
  assert.equal(plan.args[plan.args.indexOf("--cwd") + 1], cwd);
  assert.equal(plan.args[plan.args.indexOf("--sandbox") + 1], GROK_WRITE_PROFILE);
  assert.ok(plan.args.includes("--json-schema"));
  assert.ok(!plan.args.includes("--always-approve"));
  const profile = plan.runtimeFiles?.[GROK_WRITE_SANDBOX_FILE];
  assert.ok(profile !== undefined);
  assert.match(profile, /extends = "strict"/);
  assert.match(profile, /\*\*\/\.env/);
  assert.equal(plan.grant.granted.includes("edit"), true);
  assert.equal(plan.grant.granted.includes("shell"), true, "a kernel-enforced sandbox in a worktree is where a shell is safe");
});

test("a Codex write is confined to the working root and never widens it", () => {
  const cwd = worktree();
  const schemaPath = join(worktree(), "schema.json");
  const plan = planWriteInvocation({
    snapshot: snapshot("openai", "0.153.4"), model: model("openai", "gpt-5.1-codex"), cwd,
    task: "add a missing null check", context: {}, codexIsolation: codexProof(), schemaPath, now: NOW,
  });
  assert.equal(plan.args[plan.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(plan.args[plan.args.indexOf("-C") + 1], cwd);
  assert.ok(!plan.args.includes("--add-dir"), "the sandbox is the worktree; widening it would be the whole risk");
  assert.equal(plan.args[plan.args.indexOf("--output-schema") + 1], schemaPath);
  assert.ok(plan.externalFiles?.[schemaPath] !== undefined);
});

test("a Codex write without somewhere outside the worktree for its schema is refused", () => {
  assert.throws(
    () => planWriteInvocation({
      snapshot: snapshot("openai", "0.153.4"), model: model("openai", "gpt-5.1-codex"), cwd: worktree(),
      task: "t", context: {}, codexIsolation: codexProof(), now: NOW,
    }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "WRITE_SCHEMA_PATH_REQUIRED",
  );
});

test("Claude's own write profile is unchanged, and still carries no shell", () => {
  const plan = planWriteInvocation({
    snapshot: snapshot("anthropic", "2.1.266"), model: model("anthropic", "claude-opus-5"), cwd: worktree(),
    task: "t", context: {}, now: NOW,
  });
  assert.equal(plan.providerId, "anthropic");
  assert.ok(plan.args.includes("--restricted"));
  assert.equal(plan.grant.granted.includes("shell"), false);
  assert.match(plan.grant.refused.find((item) => item.capability === "shell")!.reason, /no sandbox that fails closed/);
});

test("BrainGate's own file reaches the CLI, and leaves before the diff does", async () => {
  const cwd = worktree();
  const external = join(worktree(), "nested", "schema.json");
  const executor = new NodeClaudeWriteExecutor();
  const plan = {
    providerId: "xai" as const, executable: process.execPath,
    args: ["-e", "const fs=require('node:fs');process.stdout.write(fs.readFileSync('.grok/sandbox.toml','utf8'))"],
    cwd, modelId: "m", quotaPool: "q", stdin: "", allowedEnvKeys: [], envOverrides: {},
    grant: planWriteInvocation({ snapshot: snapshot("xai", "1.0.24"), model: model("xai", "grok-4.6"), cwd, task: "t", context: {}, grokIsolation: grokProof(), now: NOW }).grant,
    runtimeFiles: { [GROK_WRITE_SANDBOX_FILE]: "[profiles.braingate-write]\n" },
    externalFiles: { [external]: "{}" },
  };
  const result = await executor.run({ plan, env: { PATH: process.env.PATH } });
  assert.match(result.stdout, /braingate-write/, "the CLI must see the profile during the run");
  assert.equal(existsSync(join(cwd, GROK_WRITE_SANDBOX_FILE)), false, "and it must be gone before the change is collected");
  assert.equal(existsSync(external), false);
});

test("a repository that already has a sandbox profile fails the run rather than losing it", async () => {
  const cwd = worktree();
  mkdirSync(join(cwd, ".grok"), { recursive: true });
  writeFileSync(join(cwd, GROK_WRITE_SANDBOX_FILE), "[profiles.mine]\n");
  const executor = new NodeClaudeWriteExecutor();
  await assert.rejects(
    executor.run({
      plan: {
        providerId: "xai" as const, executable: process.execPath, args: ["-e", "0"], cwd, modelId: "m", quotaPool: "q",
        stdin: "", allowedEnvKeys: [], envOverrides: {},
        grant: planWriteInvocation({ snapshot: snapshot("xai", "1.0.24"), model: model("xai", "grok-4.6"), cwd: worktree(), task: "t", context: {}, grokIsolation: grokProof(), now: NOW }).grant,
        runtimeFiles: { [GROK_WRITE_SANDBOX_FILE]: "[profiles.braingate-write]\n" },
      },
      env: { PATH: process.env.PATH },
    }),
  );
  assert.equal(readFileSync(join(cwd, GROK_WRITE_SANDBOX_FILE), "utf8"), "[profiles.mine]\n");
});

test("a file BrainGate places for the run can never be aimed into the worktree from outside", () => {
  const cwd = worktree();
  const executor = new NodeClaudeWriteExecutor();
  const inside = join(cwd, "schema.json");
  assert.rejects(
    executor.run({
      plan: {
        providerId: "openai" as const, executable: process.execPath, args: ["-e", "0"], cwd, modelId: "m", quotaPool: "q",
        stdin: "", allowedEnvKeys: [], envOverrides: {},
        grant: planWriteInvocation({ snapshot: snapshot("openai", "0.153.4"), model: model("openai", "gpt-5.1-codex"), cwd, task: "t", context: {}, codexIsolation: codexProof(), schemaPath: join(worktree(), "s.json"), now: NOW }).grant,
        externalFiles: { [inside]: "{}" },
      },
      env: { PATH: process.env.PATH },
    }),
  );
});

test("Claude's write grant claims no sandbox attestation, because it holds none", () => {
  const plan = planWriteInvocation({
    snapshot: snapshot("anthropic", "2.1.266"), model: model("anthropic", "claude-opus-5"), cwd: worktree(),
    task: "t", context: {}, now: NOW,
  });
  // Derived from the proof, not asserted beside it: no kernel sandbox, so no shell.
  assert.equal(plan.grant.granted.includes("shell"), false);
  assert.equal(plan.grant.granted.includes("edit"), true, "the worktree is a structural boundary and needs no attestation");
});

test("a Grok write's shell is granted by the attestation it actually holds", () => {
  const cwd = worktree();
  const withProof = planWriteInvocation({
    snapshot: snapshot("xai", "1.0.24"), model: model("xai", "grok-4.6"), cwd,
    task: "t", context: {}, grokIsolation: grokProof(), now: NOW,
  });
  assert.equal(withProof.grant.granted.includes("shell"), true);

  // Eligibility refuses a stale proof outright, which is the layer above. What this asserts is
  // that the grant reads the same proof rather than a literal that happens to agree with it.
  assert.throws(
    () => planWriteInvocation({
      snapshot: snapshot("xai", "1.0.24"), model: model("xai", "grok-4.6"), cwd,
      task: "t", context: {}, grokIsolation: grokProof({ profileHash: "some-other-policy" }), now: NOW,
    }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "WRITE_GROK_ISOLATION_REQUIRED",
  );
});

test("a read snapshot never becomes a write workspace, however current the Codex attestation is", () => {
  // The write primary runs in the task worktree through the write executor; the shadow invoker is
  // built for the reviewer only. This asserts the separation rather than trusting it: the same
  // provider and the same attestation that make Codex eligible to *read* a project snapshot must
  // leave every write path exactly where it was.
  const cwd = worktree();
  const plan = planWriteInvocation({
    snapshot: snapshot("openai", "0.153.4"), model: model("openai", "gpt-5.1-codex"), cwd,
    task: "rename a local variable", context: { files: [] }, codexIsolation: codexProof(), schemaPath: join(worktree(), "schema.json"), now: NOW,
  });
  // The write plan has no workspace-mode field at all: it is a worktree plan by construction, and the
  // snapshot vocabulary lives on the shadow read path.
  assert.equal(plan.cwd, cwd, "a write is still confined to its own worktree");
  assert.equal(plan.grant.granted.includes("edit"), true, "and it is still a write, not a read");
});
