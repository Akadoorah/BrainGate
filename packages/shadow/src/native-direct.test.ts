import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import { NodeShadowProcessExecutor } from "./process-executor.js";
import type { ModelRef } from "@braingate/router";
import { extractAntigravityResult, extractCodexAgentMessage, providerTokenUsage, reportedSessionIdOf } from "./invoker.js";
import { nativeDirectCapable, planShadowInvocation, shadowProviderRoleStatus } from "./profiles.js";
import { STAGE_PATH_TOKEN, type PlannedNativeSession, type ShadowInvocationPlan, type ShadowProcessResult, type ShadowRolePayload } from "./types.js";

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
  // Measured 2026-09-19 on grok 1.0.30: under an enforced schema the model answers in one turn
  // without a single tool call, promising to inspect and never doing so. A DIRECT read asks for
  // prose instead, and the prose is the answer.
  assert.equal(args.includes("--json-schema"), false, "no enforced schema on a DIRECT read: it costs the inspection");
  assert.match(args[args.indexOf("-p") + 1] ?? "", /Answer in plain text/, "and the prompt asks for prose");
});

test("a resumed Grok session is continued by id, and a fresh one is pinned", () => {
  const resumed = [...readPlan("xai", { kind: "resumed", sessionId: "5e1e942f-772b-47e3-b220-e85f65fef3f6", persistent: true }).args];
  assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2), ["--resume", "5e1e942f-772b-47e3-b220-e85f65fef3f6"]);
  assert.equal(resumed.includes("--session-id"), false, "exactly one of the two, never both");
  const fresh = [...readPlan("xai", { kind: "fresh", sessionId: "8d1c0f1e-0000-4000-8000-000000000001", persistent: true }).args];
  assert.deepEqual(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2), ["--session-id", "8d1c0f1e-0000-4000-8000-000000000001"]);
  assert.equal(fresh.includes("--resume"), false);
});

/** The reading of an Antigravity settings file, in the shape the plan receives it. */
function antigravityMeasured(input: { readonly reads: boolean; readonly shell: boolean }) {
  return Object.freeze({ toolDenial: "unknown" as const, declaredSubagents: "unknown" as const, sandbox: "unknown" as const, sessionIdPinning: "unknown" as const, headlessReads: input.reads, headlessShell: input.shell });
}

test("Antigravity is refused a DIRECT run until its own settings allow headless reads, and the refusal names the rule", () => {
  // Not "untried": agy 1.2.2 was measured on 2026-09-14 and auto-denied `read_file` under
  // `--mode accept-edits`, under `--mode plan` and under `--sandbox`; agy 1.2.7 on 2026-09-19 ended
  // a run that needed the workspace with `denied_actions` and no answer. The CLI's own answer is a
  // rule in the operator's settings.json, which BrainGate reads and never writes.
  for (const measured of [undefined, antigravityMeasured({ reads: false, shell: true }), antigravityMeasured({ reads: true, shell: false })]) {
    assert.throws(
      () => planShadowInvocation({
        snapshot: snapshot("google", ["google-model"]),
        model: modelFor("google"),
        cwd: WORKSPACE,
        nativeHarness: true,
        payload,
        ...(measured === undefined ? {} : { measured }),
        now: new Date("2026-09-14T01:00:00Z"),
      }),
      /auto-denies every tool|SHADOW_PROVIDER_BLOCKED/,
      "one rule without the other does not open it: measured, the model reaches for the shell even to read",
    );
    const status = shadowProviderRoleStatus("google", "primary", { direct: true, ...(measured === undefined ? {} : { measured }) });
    assert.equal(status.enabled, false);
    assert.match(String(status.reason), /auto-denies every tool/, "the reason carries the measurement, not a shrug");
    assert.match(String(status.reason), /permissions\.allow/, "and says where the rule goes");
    assert.match(String(status.reason), /read_file\(\*\) and command\(\*\)/, "and which rules");
    assert.doesNotMatch(String(status.reason), /dangerously-skip-permissions/, "a blanket bypass is not offered as the way in");
    assert.equal(nativeDirectCapable("google", measured ?? null), false);
  }
});

test("Antigravity runs DIRECT with its own settings when they allow headless reads, and the plan claims only what they allow", () => {
  const readsOnly = antigravityMeasured({ reads: true, shell: true });
  assert.equal(nativeDirectCapable("google", readsOnly), true, "the gate is the operator's settings, read per machine");
  const status = shadowProviderRoleStatus("google", "primary", { direct: true, measured: readsOnly });
  assert.equal(status.enabled, true);
  assert.match(String(status.reason), /its own settings allow headless reads/);

  const plan = planShadowInvocation({
    snapshot: snapshot("google", ["google-model"]),
    model: modelFor("google"),
    cwd: WORKSPACE,
    nativeHarness: true,
    payload,
    measured: readsOnly,
    now: new Date("2026-09-19T01:00:00Z"),
  });
  assert.equal(plan.nativeHarness, true);
  assert.equal(plan.workspaceMode, "project");
  assert.equal(plan.cwd, WORKSPACE);
  assert.equal(plan.executable, "agy");
  // The runtime's own permission model is the whole tool policy: no bypass, no sandbox, no mode.
  for (const forbidden of ["--dangerously-skip-permissions", "--sandbox", "--add-dir", "--mode"]) {
    assert.equal(plan.args.includes(forbidden), false, `${forbidden} is not passed`);
  }
  // Measured 2026-09-19 on agy 1.2.7: NDJSON with token-level `text_delta` events, and a `result`
  // envelope that still carries `conversation_id`, which is the condition for reading it this way.
  assert.deepEqual(plan.args.slice(0, 4), ["--output-format", "stream-json", "--model", "google-model"]);
  assert.equal(plan.streamDialect, "google");
  // The effort tier belongs to the model id on this build, and a contradicting `--effort` aborts
  // the run before a token is spent. `google-model` names no tier, so none is claimed for it.
  assert.equal(plan.args.includes("--effort"), false, "an id with no tier gets the CLI's own default, not a guess");
  assert.match(plan.args.at(-1) ?? "", /^-p=/, "the prompt is attached to -p, the one form no option can land inside");
  assert.equal(plan.guarantees.noShell, false, "the shell rule the gate needs means the plan cannot claim `noShell`");

  const both = planShadowInvocation({
    snapshot: snapshot("google", ["google-model"]),
    model: modelFor("google"),
    cwd: WORKSPACE,
    nativeHarness: true,
    payload,
    measured: antigravityMeasured({ reads: true, shell: true }),
    nativeSession: Object.freeze({ kind: "resumed", sessionId: "c0ffee00-1111-4222-8333-444455556666", persistent: true, resumeMode: "native", reason: "goal-continuity" }) as unknown as PlannedNativeSession,
    now: new Date("2026-09-19T01:00:00Z"),
  });
  assert.equal(both.guarantees.noShell, false, "a shell rule in the operator's settings means the run may run commands, and the plan says so");
  assert.deepEqual(both.args.slice(both.args.indexOf("--conversation"), both.args.indexOf("--conversation") + 2), ["--conversation", "c0ffee00-1111-4222-8333-444455556666"], "a goal's conversation is resumed by id");
});

test("a provider with no measured DIRECT invocation still refuses one", () => {
  assert.equal(nativeDirectCapable("anthropic"), true);
  assert.equal(nativeDirectCapable("openai"), true);
  assert.equal(nativeDirectCapable("xai"), true);
  assert.equal(nativeDirectCapable("google"), false, "measured per machine: nothing measured means Antigravity's settings allow nothing");
  assert.equal(nativeDirectCapable("github-copilot"), false, "copilot has not been measured for it");
  assert.equal(nativeDirectCapable("github-copilot", antigravityMeasured({ reads: true, shell: true })), false, "and a settings reading is Antigravity's gate, not anyone else's");
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

test("DIRECT reaches a provider the staged gates close, and does not pretend for one it cannot", () => {
  // Codex is the case the gate used to answer wrongly: staged roles only, so a primary read was
  // declared unreachable until the operator named it — at which point the measured DIRECT
  // invocation is exactly what runs.
  assert.equal(shadowProviderRoleStatus("openai", "primary").enabled, false, "the staged route closes it");
  const direct = shadowProviderRoleStatus("openai", "primary", { direct: true });
  assert.equal(direct.enabled, true, "and the DIRECT route opens it");
  assert.match(String(direct.reason), /DIRECT/, "with a reason that says which route it is");

  // Antigravity is the case where both routes are closed on an unconfigured machine, and the reason
  // says which measurement closed the second one rather than implying nobody looked.
  const google = shadowProviderRoleStatus("google", "primary", { direct: true });
  assert.equal(google.enabled, false);
  assert.match(String(google.reason), /auto-denies every tool/);

  // A provider with no DIRECT profile is not reachable this way either.
  assert.equal(shadowProviderRoleStatus("github-copilot", "primary", { direct: true }).enabled, false);
  // And DIRECT is a statement about the primary worker, not a way to reach the staged roles.
  assert.equal(shadowProviderRoleStatus("google", "planner", { direct: true }).enabled, false);
});

test("a DIRECT Codex run's schema is written outside the workspace, before the process starts", async () => {
  // Codex takes its response schema as a path, and a DIRECT run has no staged directory to put one
  // in. The executor writes these files for either mode now: the first version wrote them inside the
  // staged branch, and a real read failed with "Failed to read output schema file: No such file or
  // directory" — the provider was right and BrainGate had not written the file it promised.
  const root = mkdtempSync(join(tmpdir(), "braingate-direct-schema-"));
  const workspace = join(root, "repo");
  const schemaPath = join(root, "state", "shadow-schemas", "task.json");
  mkdirSync(workspace, { recursive: true });
  try {
    const plan = planShadowInvocation({
      snapshot: { ...snapshot("openai", ["openai-model"]), binary: "/bin/cat" } as ProviderSnapshot,
      model: modelFor("openai"),
      cwd: workspace,
      nativeHarness: true,
      payload,
      schemaPath,
      now: new Date("2026-09-14T01:00:00Z"),
    });
    assert.deepEqual(Object.keys(plan.externalFiles ?? {}), [schemaPath], "the plan names the file it needs");
    assert.equal(plan.args.includes("--output-schema"), true, "and passes it to the CLI");

    const executor = new NodeShadowProcessExecutor();
    const result = await executor.run({
      project: { projectId: "direct-schema", name: "Direct Schema", repositories: [workspace], storageDir: join(root, "state"), workspaceId: "direct-schema" } as never,
      plan,
    });
    assert.equal(result.spawned, true);
    assert.equal(JSON.parse(readFileSync(schemaPath, "utf8")).type, "object", "the schema is on disk where the plan said");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * The two DIRECT streams, replayed exactly as their CLIs produced them.
 *
 * Every line below was copied from a real run on 2026-09-19 (codex-cli 0.153.4, agy 1.2.7) in a
 * throwaway git repository holding one canary file. Replaying them through the real executor rather
 * than asserting on `readStreamLine` alone is what pins the property the operator actually cares
 * about: prose reaches the terminal *while the provider is still working*, and the answer of record
 * still parses out of what was retained.
 */
const CODEX_STREAM: readonly string[] = Object.freeze([
  '{"type":"thread.started","thread_id":"01a0ba7c-5dce-7fd2-a002-953a9aa9d711"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will read canary.txt for the ID."}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'cat canary.txt\'","aggregated_output":"The distinctive id is BG-CANARY-7741-ZQ.\\nSecond line: the project name is Rehla.\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"{\\"kind\\":\\"work\\",\\"output\\":\\"The distinctive ID is BG-CANARY-7741-ZQ.\\"}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":45225,"output_tokens":65,"reasoning_output_tokens":0}}',
]);

const AGY_STREAM: readonly string[] = Object.freeze([
  '{"event":"init","conversation_id":"73961df0-0d11-40ed-9fe7-842abf43eb6a","init":{"model":"gemini-3.8-flash-medium","cwd":"/tmp/repo"}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"output":"Second line: the project name is Rehla."}}}',
  '{"event":"step_update","step_update":{"step_index":12,"state":"ACTIVE","step_type":"agent_response","text_delta":"The distinctive ID is "}}',
  '{"event":"step_update","step_update":{"step_index":12,"state":"ACTIVE","step_type":"agent_response","text_delta":"BG-CANARY-7741-ZQ."}}',
  '{"event":"result","result":{"conversation_id":"73961df0-0d11-40ed-9fe7-842abf43eb6a","status":"SUCCESS","response":"The distinctive ID is BG-CANARY-7741-ZQ.","usage":{"input_tokens":79004,"output_tokens":1501}}}',
]);

/** A CLI that says something, waits, and only then finishes — as a real one does. */
function replayScript(lines: readonly string[], split: number): readonly string[] {
  return Object.freeze([
    "-e",
    `process.stdout.write(${JSON.stringify(`${lines.slice(0, split).join("\n")}\n`)});`
    + `setTimeout(() => process.stdout.write(${JSON.stringify(`${lines.slice(split).join("\n")}\n`)}), 150);`,
  ]);
}

async function replayedDirectRun(plan: ShadowInvocationPlan, workspace: string, root: string): Promise<{ readonly text: string; readonly result: ShadowProcessResult }> {
  let sawText: (text: string) => void = () => { /* replaced by the promise below */ };
  const streamed = new Promise<string>((resolveText) => { sawText = resolveText; });
  const pieces: string[] = [];
  const run = new NodeShadowProcessExecutor().run({
    project: { projectId: "s", name: "s", repositories: [workspace], storageDir: join(root, "state"), workspaceId: "s" } as never,
    plan,
    onText: (text) => { pieces.push(text); sawText(text); },
  });
  // The whole claim of this phase, written as a race: the terminal has words before the run is over.
  const winner = await Promise.race([streamed.then(() => "text" as const), run.then(() => "run" as const)]);
  assert.equal(winner, "text", "the answer must reach the terminal before the process closes");
  const result = await run;
  return { text: pieces.join(""), result };
}

test("a DIRECT Codex read streams its words and still yields its answer and session id", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-direct-stream-"));
  const workspace = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  try {
    const planned = planShadowInvocation({
      snapshot: snapshot("openai", ["openai-model"]), model: modelFor("openai"), cwd: workspace,
      nativeHarness: true, payload, now: new Date("2026-09-19T01:00:00Z"),
    });
    assert.equal(planned.streamDialect, "openai");
    const { text, result } = await replayedDirectRun(
      { ...planned, executable: process.execPath, args: replayScript(CODEX_STREAM, 3), stdin: "" },
      workspace, root,
    );
    assert.match(text, /I will read canary\.txt/, "the narration is shown while the run is still working");
    assert.match(text, /The distinctive ID is BG-CANARY-7741-ZQ\./, "and the contract's prose is unwrapped rather than printed as JSON");
    assert.doesNotMatch(text, /"kind"/, "the operator is never shown the contract's braces");
    // What the run is judged on afterwards, out of what survived the thinning.
    assert.equal(extractCodexAgentMessage(result.stdout), '{"kind":"work","output":"The distinctive ID is BG-CANARY-7741-ZQ."}');
    assert.equal(reportedSessionIdOf("openai", result.stdout), "01a0ba7c-5dce-7fd2-a002-953a9aa9d711");
    assert.doesNotMatch(result.stdout, /project name is Rehla/, "a command's output is not an answer, and it is the whole file");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a DIRECT Antigravity read streams its deltas and still yields its answer and conversation id", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-direct-stream-agy-"));
  const workspace = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  try {
    const planned = planShadowInvocation({
      snapshot: snapshot("google", ["google-model"]), model: modelFor("google"), cwd: workspace,
      nativeHarness: true, payload, measured: antigravityMeasured({ reads: true, shell: true }),
      now: new Date("2026-09-19T01:00:00Z"),
    });
    assert.equal(planned.streamDialect, "google");
    const { text, result } = await replayedDirectRun(
      { ...planned, executable: process.execPath, args: replayScript(AGY_STREAM, 3), stdin: "" },
      workspace, root,
    );
    assert.equal(text, "The distinctive ID is BG-CANARY-7741-ZQ.");
    assert.equal(extractAntigravityResult(result.stdout), "The distinctive ID is BG-CANARY-7741-ZQ.");
    assert.equal(reportedSessionIdOf("google", result.stdout), "73961df0-0d11-40ed-9fe7-842abf43eb6a");
    assert.equal(providerTokenUsage("google", result.stdout)?.output, 1501, "the run's own accounting survives the thinning");
    assert.doesNotMatch(result.stdout, /project name is Rehla/, "a tool step carries whole files and nothing reads them back");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
