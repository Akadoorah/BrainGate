import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import { nativeDirectCapable, planShadowInvocation, shadowProviderRoleStatus } from "./profiles.js";
import { STAGE_PATH_TOKEN, type PlannedNativeSession, type ShadowRolePayload } from "./types.js";

/**
 * The DIRECT invocation for the providers whose native harness BrainGate has measured.
 *
 * This is the read half of the multi-provider milestone: the same policy that has run Claude in the
 * operator's workspace since ADR 0017, built for Codex, Grok and Antigravity from what their
 * installed builds actually accept. Each assertion below is one measurement, taken 2026-09-14 on
 * codex-cli 0.153.4, grok 1.0.24 and agy 1.2.2, and stated as a property of the argv rather than as
 * a property of the CLI's reputation.
 *
 * The failure these pin against is the old shape: a plan that said `nativeHarness` while the argv
 * still substituted BrainGate's own harness — an isolated home, `--ignore-user-config`, a staged
 * sandbox profile, a tool allowlist. Every one of those is checked for absence here, because "the
 * flag is missing" is exactly what a regression would look like.
 */

function snapshot(providerId: ProviderId, models: readonly string[] | null = null): ProviderSnapshot {
  const observedAt = "2026-09-14T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  const binary = providerId === "anthropic" ? "claude" : providerId === "openai" ? "codex" : providerId === "google" ? "agy" : providerId;
  return {
    providerId,
    displayName: providerId,
    binary,
    available: obs(true),
    version: obs(providerId === "openai" ? "0.153.4" : providerId === "google" ? "1.2.2" : providerId === "xai" ? "1.0.24" : "2.1.270"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: models === null ? obs(null) : obs([...models]),
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: obs(null),
    removedBillingOverrides: [],
    warnings: [],
  } as unknown as ProviderSnapshot;
}

function modelFor(providerId: ProviderId): ModelRef {
  return { providerId, modelId: `${providerId}-model`, quotaPool: `${providerId}-subscription` };
}

const payload: ShadowRolePayload = Object.freeze({
  schemaVersion: 1,
  role: "primary",
  phase: "initial",
  task: "Summarize the file this workspace is for.",
  findings: Object.freeze([]),
  context: Object.freeze({}),
  responseContract: Object.freeze({ kind: "work", output: "string" }),
});

const WORKSPACE = "/private/tmp/braingate-m21-workspace";

function readPlan(providerId: ProviderId, session?: Partial<PlannedNativeSession>): ReturnType<typeof planShadowInvocation> {
  const input = {
    snapshot: snapshot(providerId, [`${providerId}-model`]),
    model: modelFor(providerId),
    cwd: WORKSPACE,
    nativeHarness: true as const,
    payload,
    now: new Date("2026-09-14T01:00:00Z"),
  };
  if (session === undefined) return planShadowInvocation(input);
  const resolved: PlannedNativeSession = {
    kind: session.kind ?? "handoff",
    sessionId: session.sessionId ?? null,
    providerId,
    modelId: `${providerId}-model`,
    resumeMode: session.resumeMode ?? "available",
    reason: session.reason ?? null,
    persistent: session.persistent ?? false,
  };
  return planShadowInvocation({ ...input, nativeSession: resolved });
}

/** Flags that mean BrainGate is still substituting a harness of its own for the CLI's. */
const SUBSTITUTED_HARNESS_FLAGS = ["--ignore-user-config", "--ignore-rules", "--strict-mcp-config", "--mcp-config", "--no-subagents", "--disable-web-search", "--deny", "--add-dir"];

/**
 * `--sandbox` is the one flag whose meaning is the provider's, not BrainGate's.
 *
 * Codex's own sandbox policy is the read posture and is checked for its value; for Grok a sandbox
 * *profile* is the staged boundary BrainGate writes and hands over, and for Antigravity `--sandbox`
 * is a terminal-restriction mode no read needs.
 */
function assertNoForeignSandbox(args: readonly string[], providerId: string): void {
  if (providerId === "openai") {
    const value = args[args.indexOf("--sandbox") + 1];
    assert.equal(value, "read-only", "Codex's sandbox is its own, and a read sets it to read-only");
    assert.equal(args.includes("dangerously-bypass-approvals-and-sandbox"), false);
    return;
  }
  assert.equal(args.includes("--sandbox"), false, `${providerId} has no sandbox BrainGate should be applying under DIRECT`);
}

test("Codex DIRECT reads the workspace with its own config and the read-only sandbox", () => {
  // A goal-backed run keeps its session, so this one is the persistent case; the no-continuity case
  // is the next test.
  const plan = readPlan("openai", { kind: "fresh", sessionId: null, persistent: true });
  const args = [...plan.args];
  assert.equal(plan.workspaceMode, "project", "a DIRECT read is not a copy");
  assert.equal(plan.cwd, WORKSPACE);
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"), "the JSONL stream is how the answer and the thread id are read");
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2), ["-C", WORKSPACE], "the working root is the selected workspace");
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"], "a read keeps the CLI's own read-only policy");
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "openai-model"]);
  // The operator's own Codex configuration is the harness here: plugins, MCP servers and rules.
  for (const flag of SUBSTITUTED_HARNESS_FLAGS) assert.equal(args.includes(flag), false, `${flag} substitutes BrainGate's harness for the CLI's`);
  assertNoForeignSandbox(args, "openai");
  assert.equal(args.includes(STAGE_PATH_TOKEN), false, "no staged workspace token in a DIRECT run");
  assert.equal(plan.nativeHarness, true);
  assert.equal(plan.guarantees.noProjectWrites, true, "the kernel sandbox is what keeps a read from writing");
});

test("a run with no goal continuity leaves no native session behind", () => {
  // Not a substituted harness: a persistence decision. A run that is not continuing a goal has
  // nothing to continue later, so Codex is told not to leave a session on the operator's disk.
  const args = [...readPlan("openai").args];
  assert.ok(args.includes("--ephemeral"), "no goal means no session to keep");
  const kept = [...readPlan("openai", { kind: "fresh", sessionId: null, persistent: true }).args];
  assert.equal(kept.includes("--ephemeral"), false, "and a goal-backed run keeps the one it will resume");
});

test("a resumed Codex session keeps the id and drops the flags its resume subcommand rejects", () => {
  const plan = readPlan("openai", { kind: "resumed", sessionId: "01a09d2f-73db-72b3-8029-6a4786c2eb69", persistent: true });
  const args = [...plan.args];
  assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
  assert.ok(args.includes("01a09d2f-73db-72b3-8029-6a4786c2eb69"), "the session id is passed");
  // Measured on codex-cli 0.153.4: `exec resume` rejects `-s` and `-C` outright, so the sandbox
  // travels as the config override the subcommand does accept.
  assert.equal(args.includes("-s"), false, "resume rejects -s with an argument error");
  assert.equal(args.includes("-C"), false);
  assert.ok(args.includes('sandbox_mode="read-only"'), "and the sandbox is set through config instead");
  assert.equal(args[args.length - 1], "-", "the prompt still arrives on stdin");
});

test("Grok DIRECT reads in the workspace with the runtime's own read posture", () => {
  const plan = readPlan("xai");
  const args = [...plan.args];
  assert.equal(plan.workspaceMode, "project");
  assert.equal(plan.cwd, WORKSPACE);
  assert.ok(args.includes("-p"), "single-turn headless");
  assert.deepEqual(args.slice(args.indexOf("--cwd"), args.indexOf("--cwd") + 2), ["--cwd", WORKSPACE]);
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "default"], "a read must not borrow the write posture");
  assert.equal(args.includes("acceptEdits"), false, "and never the write posture");
  assert.equal(args.includes("--worktree"), false, "DIRECT never creates a worktree");
  for (const flag of SUBSTITUTED_HARNESS_FLAGS) assert.equal(args.includes(flag), false, `${flag} is BrainGate's harness, not Grok's`);
  assertNoForeignSandbox(args, "xai");
  assert.equal(plan.guarantees.noProjectWrites, true, "a headless Grok refuses what it would have prompted for");
});

test("a resumed Grok session is continued by id, and a fresh one is pinned", () => {
  const resumed = [...readPlan("xai", { kind: "resumed", sessionId: "5e1e942f-772b-47e3-b220-e85f65fef3f6", persistent: true }).args];
  assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2), ["--resume", "5e1e942f-772b-47e3-b220-e85f65fef3f6"]);
  assert.equal(resumed.includes("--session-id"), false, "exactly one of the two, never both");
  const fresh = [...readPlan("xai", { kind: "fresh", sessionId: "8d1c0f1e-0000-4000-8000-000000000001", persistent: true }).args];
  assert.deepEqual(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2), ["--session-id", "8d1c0f1e-0000-4000-8000-000000000001"]);
  assert.equal(fresh.includes("--resume"), false);
});

test("Antigravity DIRECT reads in the workspace, fail-closed and without a conversation on a fresh run", () => {
  const plan = readPlan("google");
  const args = [...plan.args];
  assert.equal(plan.workspaceMode, "project");
  assert.equal(plan.cwd, WORKSPACE, "agy has no cwd flag: the process working directory is the workspace");
  assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), ["--output-format", "json"], "one envelope carries the answer and the conversation id");
  const prompt = args.find((argument) => argument.startsWith("-p="));
  assert.notEqual(prompt, undefined, "the prompt is attached to -p, the one form no option can separate");
  assert.equal(args.includes("--mode"), false, "a read is not the accept-edits posture");
  assert.equal(args.includes("accept-edits"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  for (const flag of SUBSTITUTED_HARNESS_FLAGS) assert.equal(args.includes(flag), false, `${flag} is not Antigravity's own harness`);
  assertNoForeignSandbox(args, "google");
  assert.equal(args.includes("--conversation"), false, "nothing to resume on a fresh run");
});

test("a resumed Antigravity conversation is continued by id", () => {
  const args = [...readPlan("google", { kind: "resumed", sessionId: "5e1e942f-772b-47e3-b220-e85f65fef3f6", persistent: true }).args];
  assert.deepEqual(args.slice(args.indexOf("--conversation"), args.indexOf("--conversation") + 2), ["--conversation", "5e1e942f-772b-47e3-b220-e85f65fef3f6"]);
});

test("a provider with no measured DIRECT invocation still refuses one", () => {
  assert.equal(nativeDirectCapable("anthropic"), true);
  assert.equal(nativeDirectCapable("openai"), true);
  assert.equal(nativeDirectCapable("xai"), true);
  assert.equal(nativeDirectCapable("google"), true);
  assert.equal(nativeDirectCapable("github-copilot"), false, "copilot has not been measured for it");
  assert.throws(
    () => planShadowInvocation({
      snapshot: snapshot("github-copilot", ["copilot-model"]),
      model: modelFor("github-copilot"),
      cwd: WORKSPACE,
      nativeHarness: true,
      payload,
    }),
    /SHADOW_NATIVE_HARNESS_UNSUPPORTED|no measured DIRECT invocation/,
  );
});

test("DIRECT reaches the primary role for a provider the staged gates close", () => {
  // Google is the sharpest case: closed outright without an operator acceptance, because a staged
  // run keeps the operator's real home and BrainGate cannot scope it. A DIRECT run is a different
  // question — the operator selected this worker and approved this run in their own workspace — and
  // the answer is different for that reason rather than because the gate was relaxed.
  const staged = shadowProviderRoleStatus("google", "primary");
  assert.equal(staged.enabled, false, "the staged route is still closed");
  const direct = shadowProviderRoleStatus("google", "primary", { direct: true });
  assert.equal(direct.enabled, true, "and the DIRECT route is open");
  assert.match(String(direct.reason), /DIRECT/, "with a reason that says which route it is");

  // A provider with no DIRECT profile is not reachable this way either.
  assert.equal(shadowProviderRoleStatus("github-copilot", "primary", { direct: true }).enabled, false);
  // And DIRECT is a statement about the primary worker, not a way to reach the staged roles.
  assert.equal(shadowProviderRoleStatus("google", "planner", { direct: true }).enabled, false);
});
