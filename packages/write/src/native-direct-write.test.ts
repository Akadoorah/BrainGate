import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import { DIRECT_WRITE_PROVIDERS, assertWriteEligible, directWriteCapable, planWriteInvocation } from "./write-profiles.js";

/**
 * The DIRECT write invocation for each provider whose native write posture BrainGate has measured.
 *
 * Measured 2026-09-14 on this machine: codex-cli 0.153.4 (`-s workspace-write`), grok 1.0.24
 * (`--permission-mode acceptEdits`), agy 1.2.2 (`--mode accept-edits`). Each assertion is about the
 * argv BrainGate builds, because that is the part BrainGate owns: the provider keeps its tools, its
 * MCP servers, its subagents and its own configuration.
 *
 * The failure these pin against is a DIRECT write that quietly keeps the staged posture it was
 * built for — an isolated home, `--ignore-user-config`, a BrainGate sandbox profile, `--worktree` —
 * which would either edit a copy or refuse the run the operator just approved.
 */

function snapshot(providerId: ProviderId, version: string): ProviderSnapshot {
  const observedAt = "2026-09-14T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  const binary = providerId === "openai" ? "codex" : providerId === "google" ? "agy" : providerId;
  return {
    providerId,
    displayName: providerId,
    binary,
    available: obs(true),
    version: obs(version),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: obs(null),
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: obs(null),
    removedBillingOverrides: [],
    warnings: [],
  } as unknown as ProviderSnapshot;
}

const WORKSPACE = "/private/tmp/braingate-m21-workspace";
const SCHEMA_PATH = "/private/tmp/braingate-m21-state/write-schemas/task.json";

function writePlan(providerId: ProviderId, session?: { kind: "fresh" | "resumed" | "handoff"; sessionId: string | null; persistent: boolean }) {
  const model: ModelRef = { providerId, modelId: `${providerId}-model`, quotaPool: `${providerId}-subscription` };
  const input = {
    snapshot: snapshot(providerId, providerId === "openai" ? "0.153.4" : providerId === "google" ? "1.2.2" : "1.0.24"),
    model,
    cwd: WORKSPACE,
    nativeHarness: true as const,
    task: "Append one inert comment line to the test document.",
    context: Object.freeze({ goal: "documentation-only change" }),
    maxTurns: 12,
    schemaPath: SCHEMA_PATH,
    now: new Date("2026-09-14T01:00:00Z"),
  };
  return planWriteInvocation(session === undefined ? input : { ...input, session });
}

test("a DIRECT write is planned for every provider on the measured list, and only those", () => {
  assert.deepEqual([...DIRECT_WRITE_PROVIDERS], ["xai", "openai", "google"], "measured after Claude, which is the reference implementation");
  assert.equal(directWriteCapable("anthropic"), true, "Claude has had one since ADR 0017");
  for (const providerId of DIRECT_WRITE_PROVIDERS) assert.equal(directWriteCapable(providerId), true);
  assert.equal(directWriteCapable("github-copilot"), false);
  assert.equal(directWriteCapable("openai"), true);
  for (const providerId of DIRECT_WRITE_PROVIDERS) {
    const plan = writePlan(providerId);
    assert.equal(plan.cwd, WORKSPACE, `${providerId} writes the workspace the operator selected`);
    assert.equal(plan.grant.workspaceMode, "project", `${providerId} is not confined to a worktree it does not have`);
  }
});

test("Codex DIRECT writes through its own kernel sandbox, without BrainGate's staged config", () => {
  const plan = writePlan("openai");
  const args = [...plan.args];
  assert.equal(args[0], "exec");
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2), ["-C", WORKSPACE]);
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"], "writes are allowed inside the working root and nowhere else");
  assert.deepEqual(args.slice(args.indexOf("--output-schema"), args.indexOf("--output-schema") + 2), ["--output-schema", SCHEMA_PATH]);
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--add-dir", "--dangerously-bypass-approvals-and-sandbox", "--approve-for-me"]) {
    assert.equal(args.includes(flag), false, `${flag} is either BrainGate's staged harness or a policy this run keeps`);
  }
  assert.equal(plan.stdin.includes("Append one inert comment line"), true, "the brief arrives on stdin");
  assert.deepEqual(Object.keys(plan.externalFiles ?? {}), [SCHEMA_PATH], "the schema is written outside the workspace so it cannot join the diff");
});

test("a resumed Codex write continues the session, and a fresh one is not told to keep nothing", () => {
  const resumed = [...writePlan("openai", { kind: "resumed", sessionId: "01a09d2f-73db-72b3-8029-6a4786c2eb69", persistent: true }).args];
  assert.deepEqual(resumed.slice(0, 2), ["exec", "resume"]);
  assert.ok(resumed.includes("01a09d2f-73db-72b3-8029-6a4786c2eb69"));
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'), "resume takes no -s, so the sandbox travels as config");
  assert.equal(resumed.includes("-C"), false);
  const fresh = [...writePlan("openai", { kind: "handoff", sessionId: null, persistent: false }).args];
  assert.ok(fresh.includes("--ephemeral"), "a run with no goal to continue leaves no session behind");
});

test("Grok DIRECT writes with edits approved and nothing else", () => {
  const plan = writePlan("xai");
  const args = [...plan.args];
  assert.deepEqual(args.slice(args.indexOf("--cwd"), args.indexOf("--cwd") + 2), ["--cwd", WORKSPACE]);
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "acceptEdits"]);
  assert.ok(args.includes("--json-schema"), "the write contract is enforced by the CLI");
  for (const flag of ["--always-approve", "bypassPermissions", "--dangerously-skip-permissions", "--worktree", "--sandbox", "--no-subagents", "--disable-web-search"]) {
    assert.equal(args.includes(flag), false, `${flag} is a bypass, a worktree BrainGate must not create, or a harness it no longer substitutes`);
  }
});

test("Grok DIRECT continues its session by id, and pins a new one when it has one to name", () => {
  const resumed = [...writePlan("xai", { kind: "resumed", sessionId: "5e1e942f-772b-47e3-b220-e85f65fef3f6", persistent: true }).args];
  assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2), ["--resume", "5e1e942f-772b-47e3-b220-e85f65fef3f6"]);
  assert.equal(resumed.includes("--session-id"), false);
  const fresh = [...writePlan("xai", { kind: "fresh", sessionId: "8d1c0f1e-0000-4000-8000-000000000001", persistent: true }).args];
  assert.deepEqual(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2), ["--session-id", "8d1c0f1e-0000-4000-8000-000000000001"]);
  assert.equal(fresh.includes("--resume"), false);
});

test("Antigravity DIRECT writes in its accept-edits mode, and continues a conversation when it has one", () => {
  const plan = writePlan("google");
  const args = [...plan.args];
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "accept-edits"]);
  assert.equal(args.some((argument) => argument.startsWith("-p=")), true, "the prompt is attached to -p");
  for (const flag of ["--dangerously-skip-permissions", "--sandbox", "--add-dir", "--new-project"]) assert.equal(args.includes(flag), false, `${flag} is a bypass or widens the workspace`);
  const resumed = [...writePlan("google", { kind: "resumed", sessionId: "5e1e942f-772b-47e3-b220-e85f65fef3f6", persistent: true }).args];
  assert.deepEqual(resumed.slice(resumed.indexOf("--conversation"), resumed.indexOf("--conversation") + 2), ["--conversation", "5e1e942f-772b-47e3-b220-e85f65fef3f6"]);
});

test("a DIRECT write needs no sandbox self-test, because it does not use one BrainGate wrote", () => {
  // The staged path's whole gate is a proof about a sandbox profile. A DIRECT run has no such
  // profile, so demanding the proof would refuse exactly the run this path exists to make.
  assert.doesNotThrow(() => assertWriteEligible(snapshot("xai", "1.0.24"), { providerId: "xai", modelId: "xai-model", quotaPool: "xai-subscription" }, { nativeHarness: true }));
  assert.throws(
    () => assertWriteEligible(snapshot("xai", "1.0.24"), { providerId: "xai", modelId: "xai-model", quotaPool: "xai-subscription" }),
    /attestation/i,
    "the worktree policy still requires the proof it was built on",
  );
});

test("Antigravity has no worktree write profile, so that policy refuses it rather than borrowing Codex's", () => {
  assert.throws(
    () => planWriteInvocation({
      snapshot: snapshot("google", "1.2.2"),
      model: { providerId: "google", modelId: "google-model", quotaPool: "google-subscription" },
      cwd: WORKSPACE,
      task: "Append one inert comment line.",
      context: Object.freeze({}),
      schemaPath: SCHEMA_PATH,
      now: new Date("2026-09-14T01:00:00Z"),
    }),
    /DIRECT write profile only/,
  );
});
