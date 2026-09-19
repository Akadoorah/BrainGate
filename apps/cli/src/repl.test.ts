import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { initializeDogfoodProject } from "@braingate/dogfood";
import { ProjectRegistry, TaskLedger, executionScopeFor } from "@braingate/core";
import { ProjectMemory } from "@braingate/memory";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import { activityLabel, grantLines, looksLikeWriteRequest, runRepl, withoutStreamedAnswer } from "./repl.js";

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

function project(): string {
  // returns the repo path; the registry lives beside it

  const root = mkdtempSync(join(tmpdir(), "braingate-repl-"));
  const repo = join(root, "demo"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "config.yml"), "theme: dark\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "initial"]);
  initializeDogfoodProject({ cwd: repo, projectId: "demo", name: "Demo" });
  return repo;
}

/**
 * A state directory of this session's own, with a catalogue in it.
 *
 * Without this the session resolves `~/.braingate` — the operator's real catalogue, acceptances and
 * quota history — and writes a project's stores into it. Two tests in this file were failing on
 * exactly that: the write hit a state directory the sandbox would not let them open, and the
 * failure arrived as `CLI_UNEXPECTED` with the details suppressed, so the suite said "environment"
 * and nothing more. A test that needs the operator's home to be writable is testing the machine.
 */
function operatorEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "braingate-repl-home-"));
  const env = { BRAINGATE_HOME: home };
  const catalog = new ModelCatalog(resolveOperatorState(env, home).modelCatalogPath);
  for (const [providerId, modelId, coder, speed] of [
    ["anthropic", "claude-sonnet-5", 95, "balanced"],
    ["anthropic", "claude-haiku-4-5", 85, "fast"],
  ] as const) {
    catalog.upsert({
      providerId, modelId, quotaPool: `${providerId}-subscription`,
      capabilities: { coder, reviewer: 70, judge: 65 }, speed,
      contextCapacity: 200_000, writeCapable: true, reasoning: coder, underlyingFamily: null,
    });
  }
  return env;
}

/**
 * One provider, as a snapshot the session can route against without asking the machine.
 *
 * The session used to discover providers for real, which made these tests depend on the operator's
 * own Claude and Codex logins and take seconds each: with a redirected HOME the CLI reports itself
 * logged out and two of them failed, and with the real HOME they were passing by accident. A
 * planning test is about planning, so the discovery it needs is supplied.
 */
const PROVIDER_DISPLAY: Readonly<Record<string, { readonly name: string; readonly binary: string }>> = Object.freeze({
  anthropic: { name: "Claude Code", binary: "claude" },
  openai: { name: "Codex CLI", binary: "codex" },
  xai: { name: "Grok CLI", binary: "grok" },
  google: { name: "Antigravity", binary: "agy" },
});

function snapshot(providerId: "anthropic" | "openai" | "xai" | "google", models: readonly string[]): ProviderSnapshot {
  const observedAt = "2026-09-13T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName: PROVIDER_DISPLAY[providerId]!.name,
    binary: PROVIDER_DISPLAY[providerId]!.binary,
    available: obs(true),
    version: obs("2.1.269"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: obs([...models]),
    capabilities: obs({ headless: true, modelPinning: true, sessionIdPinning: true, outputFormats: ["json"], supportsMcp: true, supportsSubagents: true }),
    quotaState: obs("unknown"),
    quotaHint: obs(null),
    quotaObservedAt: obs(null),
    refusalBackoffUntil: obs(null),
    observedAt,
  } as unknown as ProviderSnapshot;
}

/**
 * Drives a session from a fixed script of answers, capturing everything written.
 *
 * The state directory is a parameter because some of these tests are about what survives a
 * session: a helper that minted a fresh `BRAINGATE_HOME` per run could never see a preference
 * outlive the process it was set in.
 */
/**
 * @param overrides Additional (or replacement) `runRepl` dependencies — a fake `executor` to let a
 * run actually execute, `registerCancel` to reach into the session's own cancellation hook, a wider
 * `discoverAll` for a provider the default two do not cover. Merged in last, so a test that needs a
 * real executor or a third provider is not copying this whole fixture to get one.
 */
function session(cwd: string, answers: readonly string[], env: NodeJS.ProcessEnv = operatorEnv(), overrides: Record<string, unknown> = {}) {
  const remaining = [...answers];
  const asked: string[] = [];
  // How much had been printed when each question was put. The gate is an ordering, and a test that
  // only checks a question was asked cannot tell that the plan it refers to came before it.
  const askedAt: number[] = [];
  let out = ""; let err = "";
  return {
    asked,
    askedAt,
    text: () => `${out}${err}`,
    run: () => runRepl({
      cwd,
      env,
      animate: false,
      colour: false,
      stdout: (t) => { out += t; },
      stderr: (t) => { err += t; },
      // A null answer is end of input, which ends the session.
      ask: async (question) => { asked.push(question); askedAt.push(out.length + err.length); return remaining.shift() ?? null; },
      discoverAll: async () => [snapshot("anthropic", ["claude-sonnet-5", "claude-haiku-4-5"]), snapshot("openai", ["gpt-6-astra"])],
      probeCapabilities: async () => ({ features: { sessionIdPinning: { supported: true } } }),
      measureCapabilities: async () => ({}),
      verifyCodexIsolation: async (item: ProviderSnapshot) => ({
        providerId: "openai" as const, source: "sandbox-self-test" as const,
        version: item.version.value ?? "0.0.0", platform: "darwin" as const,
        profileHash: "test-profile", policyHash: "test-policy",
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        unrecognisedKeys: [], droppedKeys: [], droppedFeatureKeys: [],
      }),
      verifyGrokIsolation: async (item: ProviderSnapshot) => ({
        providerId: "xai" as const, source: "sandbox-event-self-test" as const,
        version: item.version.value ?? "0.0.0", platform: "darwin" as const,
        profileHash: "test-profile", policyHash: "test-policy",
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        readableRoots: [], networkRestricted: true, configSurfaces: [],
      }),
      ...overrides,
    }),
  };
}

test("a question is planned and skipped unless confirmed, so typing never spends on its own", async () => {
  const repo = project();
  // Decline the plan, then end the session.
  const s = session(repo, ["where is the theme configuration defined?", "n"]);
  assert.equal(await s.run(), 0);
  assert.match(s.text(), /read-only/);
  assert.match(s.text(), /Skipped\. Nothing was spent\./);
  // The confirmation is the gate: it must have been asked before anything could run.
  assert.ok(s.asked.some((q) => /Run it\?/.test(q)), "no confirmation was requested");
});

test("an instruction is recognised as a write and says so before asking", async () => {
  const repo = project();
  const s = session(repo, ["change the empty-state label to Nothing yet", "n"]);
  assert.equal(await s.run(), 0);
  // DIRECT is the default policy (ADR 0017), so the honest line names the workspace, not a
  // worktree. The plan must also be printed before the question that lets it run: the operator
  // cannot decline something they were never shown.
  assert.match(s.text(), /write · direct · in your workspace/);
  assert.ok(s.asked.some((q) => /changes files in your workspace, and nothing is committed/.test(q)), "the write confirmation must say where the change lands");
  const gate = s.asked.findIndex((q) => /Run it\?/.test(q));
  assert.ok(gate >= 0, "the run must be confirmed before it happens");
  const planned = s.text().indexOf("write · direct · in your workspace");
  assert.ok(planned >= 0 && planned < (s.askedAt[gate] ?? 0), "the plan was not shown before the confirmation");
});

test("write intent is detected from an instruction, not from a question", () => {
  assert.equal(looksLikeWriteRequest("change the label to X"), true);
  assert.equal(looksLikeWriteRequest("Rename the helper"), true);
  assert.equal(looksLikeWriteRequest("fix the typo in the README"), true);
  assert.equal(looksLikeWriteRequest("where is the theme configuration defined?"), false);
  assert.equal(looksLikeWriteRequest("which modules send email?"), false);
  assert.equal(looksLikeWriteRequest("how does the router score models?"), false);
});

test("slash commands work and /exit ends the session", async () => {
  const repo = project();
  const s = session(repo, ["/help", "/exit"]);
  assert.equal(await s.run(), 0);
  assert.match(s.text(), /\/feedback <task-id>/);
});

test("an unregistered directory is offered registration, not turned away", async () => {
  const empty = mkdtempSync(join(tmpdir(), "braingate-repl-empty-"));
  // Declining leaves nothing registered, but the offer is the point: arriving somewhere new is
  // the ordinary first run, and the banner has already said what this is.
  const s = session(empty, ["n"]);
  assert.notEqual(await s.run(), 0);
  assert.ok(s.asked.some((q) => /as a BrainGate project\? \[Y\/n\]/.test(q)), "registration was never offered");
  assert.match(s.text(), /isolation boundary/);
  assert.match(s.text(), /braingate init/);
});

test("accepting the offer registers the project and continues into the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-repl-adopt-"));
  const repo = join(root, "my-service"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "x.txt"), "x\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "initial"]);

  // Accept, adopt the starting scores, decline a reviewer on every write, then leave. The id and
  // the name are no longer questions: the directory names the project, and the wizard says so.
  const s = session(repo, ["y", "y", "n", "/exit"]);
  assert.equal(await s.run(), 0);
  assert.equal(JSON.parse(readFileSync(join(repo, ".brain", "project.json"), "utf8")).project_id, "my-service");
  assert.match(s.text(), /assumed: project id `my-service`/);
  // The session must actually start, not merely register and stop.
  assert.match(s.text(), /Type a request, or \/help/);
});

test("the wizard runs once: a second session in the same workspace starts straight into the prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-repl-once-"));
  const repo = join(root, "once"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "x.txt"), "x\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "initial"]);

  const env = operatorEnv();
  const first = session(repo, ["y", "y", "n", "/exit"], env);
  assert.equal(await first.run(), 0, first.text());
  assert.ok(first.asked.some((q) => /Adopt these \d+ models/.test(q)), `asked: ${JSON.stringify(first.asked)}`);

  const second = session(repo, ["/exit"], env);
  assert.equal(await second.run(), 0, second.text());
  assert.ok(!second.asked.some((q) => /as a BrainGate project/.test(q)), "the wizard re-registered a registered workspace");
  assert.ok(!second.asked.some((q) => /Adopt these/.test(q)), "the wizard re-ran on a registered workspace");
});

test("/review on is remembered across sessions and sends a reviewer with the next write", async () => {
  const repo = project();
  const env = operatorEnv();
  const first = session(repo, ["/review", "/review on", "/exit"], env);
  assert.equal(await first.run(), 0, first.text());
  assert.match(first.text(), /Reviewer on every write: off/);
  assert.match(first.text(), /Reviewer on every write: on\./);

  // A second process, same workspace: the preference is read back before the first prompt.
  const second = session(repo, ["change the empty-state label to Nothing yet", "n", "/exit"], env);
  assert.equal(await second.run(), 0, second.text());
  assert.match(second.text(), /Reviewer on every write: on\. \/review off changes it\./);
  // And it reached the plan rather than only the banner: a T1 DIRECT edit's budget permits a
  // reviewer without requiring one, so a reviewer in the plan line is the flag having had effect.
  assert.match(second.text(), /reviewer=/, "the session's reviewer preference never reached the write plan");

  const third = session(repo, ["/review off", "/exit"], env);
  assert.equal(await third.run(), 0, third.text());
  const fourth = session(repo, ["/exit"], env);
  assert.equal(await fourth.run(), 0, fourth.text());
  assert.ok(!fourth.text().includes("Reviewer on every write: on"), "/review off did not persist");
});

test("/policy worktree persists into the next session", async () => {
  const repo = project();
  const env = operatorEnv();
  const first = session(repo, ["/policy worktree", "/exit"], env);
  assert.equal(await first.run(), 0, first.text());
  assert.match(first.text(), /isolated worktree|worktree/);

  const second = session(repo, ["/policy", "/exit"], env);
  assert.equal(await second.run(), 0, second.text());
  assert.match(second.text(), /remembered from your last session here/);
  // And it is the boundary the next run would use, not only a line in the banner.
  assert.match(second.text(), /Execution policy: [^\n]*worktree/i);
});

test("/setup reruns the wizard in a registered workspace without re-registering it", async () => {
  const repo = project();
  const env = operatorEnv();
  const s = session(repo, ["/setup", "y", "n", "/exit"], env);
  assert.equal(await s.run(), 0, s.text());
  assert.match(s.text(), /is already registered here\. Nothing about it is changed\./);
  assert.match(s.text(), /Editable any time: \/setup, \/models, \/providers, \/policy, \/review\./);
  assert.ok(!s.asked.some((q) => /as a BrainGate project/.test(q)), "/setup offered to register an already-registered workspace");
});

test("a session turn never becomes project memory", async () => {
  const repo = project();
  // Two exchanges, both declined so nothing is spent; the thread is still recorded in-process.
  const s = session(repo, ["which modules send email?", "n", "and the other one?", "n", "/exit"]);
  assert.equal(await s.run(), 0);

  // Project memory is durable and evidence-gated. A session turn is neither, and must not have
  // acquired the standing of a promoted record by passing through the session.
  const registry = new ProjectRegistry(join(repo, "..", "registry"));
  const registered = registry.loadFile(join(repo, ".brain", "project.json"));
  const memory = new ProjectMemory(registered);
  try {
    assert.equal(memory.listEffective(50).length, 0, "the session wrote to project memory");
  } finally { memory.close(); }
});

test("/forget clears the thread without touching project memory", async () => {
  const repo = project();
  const s = session(repo, ["/forget", "/exit"]);
  assert.equal(await s.run(), 0);
  assert.match(s.text(), /Project memory is untouched/);
});

test("a subdirectory of a registered repository is not offered registration again", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-repl-nested-"));
  const repo = join(root, "monorepo"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "README.md"), "root\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "initial"]);
  initializeDogfoodProject({ cwd: repo, projectId: "monorepo", name: "Monorepo" });

  const nested = join(repo, "apps", "flutter_migration");
  mkdirSync(nested, { recursive: true });

  // init writes the manifest at the repository root. Offering to register from a subdirectory
  // produced a second identity and then PROJECT_INIT_CONFLICT, which is what this pins against.
  const s = session(nested, ["/exit"]);
  assert.equal(await s.run(), 0);
  assert.ok(!s.asked.some((q) => /Register this repository now/.test(q)), "registration was offered inside an already-registered repository");
  assert.match(s.text(), /Type a request, or \/help/);
});

test("the confirmation shows what each role may do, not only which model was chosen", () => {
  const planned = [
    "T4/medium · planner=anthropic/claude-fable-5-1 · reviewer=openai/gpt-6-astra",
    "  planner: read, subagents · refused web",
    "  reviewer: read · refused subagents",
    "Zero provider model calls executed.",
  ].join("\n");
  assert.deepEqual([...grantLines(planned)], [
    "planner: read, subagents · refused web",
    "reviewer: read · refused subagents",
  ]);
  assert.deepEqual([...grantLines("T0/low · primary=anthropic/claude-haiku-4-5")], []);
});

test("the indicator names the role, the CLI, the model and the pool being spent", () => {
  assert.equal(
    activityLabel({ role: "planner", provider: "xai", model: "grok-4.6", quotaPool: "grok-subscription" }),
    "planning · grok · grok-4.6",
  );
  // Codex spends a ChatGPT subscription, which its own name does not say, so the pool stays.
  assert.equal(
    activityLabel({ role: "reviewer", provider: "openai", model: "gpt-6-astra", quotaPool: "chatgpt-subscription" }),
    "reviewing · codex · gpt-6-astra · chatgpt-subscription",
  );
  // The CLI the operator signed into, not the vendor behind it: nobody waits on "google".
  assert.equal(
    activityLabel({ role: "primary", provider: "google", model: "gemini-3.8-flash-medium", quotaPool: "antigravity-subscription" }),
    "working · antigravity · gemini-3.8-flash-medium",
  );
  // A role with no better verb still says which model is spending the time.
  assert.match(activityLabel({ role: "primary", model: "claude-sonnet-5", quotaPool: "claude-subscription" }), /^working · claude-sonnet-5/);
});

test("an answer that was streamed live is not printed a second time", () => {
  const finished = "The service reports failures through a shared handler.\n\nTask 8fbc9645 · observed=1 · outcome=approved";
  assert.equal(withoutStreamedAnswer(finished), "\nTask 8fbc9645 · observed=1 · outcome=approved");
  // Nothing recognisable to keep is better than repeating the whole answer.
  assert.equal(withoutStreamedAnswer("just an answer with no receipt"), "");
});

// ---------------------------------------------------------------- output is printed once

/** What a run prints when the answer streamed live: the receipt, and the answer only once. */
test("R: a streamed answer is not printed a second time by the final block", () => {
  const block = "The theme is read from config.yml.\n\nTask 4f2c1a77-1111-4111-8111-111111111111 · observed=1 · outcome=SUCCESS\n";
  const kept = withoutStreamedAnswer(block);
  assert.doesNotMatch(kept, /The theme is read/, "the streamed answer is not repeated");
  assert.match(kept, /Task 4f2c1a77/, "and the receipt survives");
  // Nothing to keep when the run printed no receipt at all: printing the answer again would be the
  // duplication this exists to prevent.
  assert.equal(withoutStreamedAnswer("The theme is read from config.yml.\n"), "");
});

test("S: text a provider repeated itself is stored and printed once, not duplicated again", () => {
  // The provider's own output is the provider's; BrainGate does not edit it. What it must not do is
  // add a second copy on the way out. The receipt boundary is the whole mechanism.
  const providerText = "The flag is unused.\nThe flag is unused.\n";
  const block = `${providerText}\nTask 4f2c1a77-1111-4111-8111-111111111111 · observed=1 · outcome=SUCCESS\n`;
  const kept = withoutStreamedAnswer(block);
  assert.equal(kept.match(/The flag is unused\./g), null, "the answer stays out of the receipt block");
  assert.equal(providerText.match(/The flag is unused\./g)?.length, 2, "and the provider's text is preserved as it was");
});

// ---------------------------------------------------------------- Phase E: fewer keystrokes

/** `operatorEnv` plus two xai models with different `reasoning` scores, for `/use grok`. */
function operatorEnvWithXai(): NodeJS.ProcessEnv {
  const env = operatorEnv();
  const catalog = new ModelCatalog(resolveOperatorState(env).modelCatalogPath);
  for (const [modelId, reasoning] of [["grok-4.5", 80], ["grok-4.6", 88]] as const) {
    catalog.upsert({
      providerId: "xai", modelId, quotaPool: "grok-subscription",
      capabilities: { coder: reasoning, reviewer: 70 }, speed: "balanced",
      contextCapacity: 200_000, writeCapable: true, reasoning, underlyingFamily: null,
    });
  }
  return env;
}

test("/use grok resolves the CLI name to the provider and picks the strongest configured model", async () => {
  const repo = project();
  const env = operatorEnvWithXai();
  const s = session(repo, ["/use grok", "/exit"], env, {
    discoverAll: async () => [
      snapshot("anthropic", ["claude-sonnet-5"]),
      snapshot("openai", ["gpt-6-astra"]),
      snapshot("xai", ["grok-4.5", "grok-4.6"]),
    ],
  });
  assert.equal(await s.run(), 0, s.text());
  // xai has `nativeDirect: true` unconditionally, so both configured models pass the `direct`
  // policy filter and the higher `reasoning` score (grok-4.6, 88) must win over grok-4.5 (80).
  assert.match(s.text(), /Next work will go to xai\/grok-4\.6 — the strongest configured model for xai that can run `direct` \(coder 88 of 2 configured\)/);
});

test("/use <alias> reports an unknown provider by name, and a provider with nothing configured", async () => {
  const repo = project();
  const s = session(repo, ["/use mistral", "/use codex", "/exit"]);
  assert.equal(await s.run(), 0, s.text());
  assert.match(s.text(), /Unknown provider `mistral`\. Known: grok, claude, codex, antigravity/);
  // `operatorEnv` (the default fixture) only configures anthropic models.
  assert.match(s.text(), /No models are configured for openai yet\. Run `braingate discover`/);
});

test("an unrecognised slash command is offered the closest one within an edit distance of 2", async () => {
  const repo = project();
  const s = session(repo, ["/hepl", "/qwertyzargh", "/exit"]);
  assert.equal(await s.run(), 0, s.text());
  assert.match(s.text(), /Unknown command \/hepl\. Did you mean \/help\? Try \/help for the full list\./);
  // Genuinely unrelated: no suggestion is offered rather than a guess.
  assert.match(s.text(), /Unknown command \/qwertyzargh\. Try \/help\.\n/);
});

test("/remember hints at /promote, and /promote <n> --evidence promotes the numbered proposal", async () => {
  const repo = project();
  const env = operatorEnv();
  const s = session(repo, [
    "/remember the service reads its theme from config.yml",
    "/promote 1 --evidence config.yml",
    "/remember the service caches responses for 60 seconds",
    "/remember the cache is invalidated on every deploy",
    "/memory",
    // Two proposals created moments apart can share a millisecond, and the store then breaks the
    // tie on its own id rather than on creation order — so which of the two `/memory` prints as
    // "1" and which as "2" is read back from its own output below, rather than assumed.
    "/promote 2 --evidence deploy-notes.md",
    "/exit",
  ], env);
  assert.equal(await s.run(), 0, s.text());
  assert.match(s.text(), /promote it with\n {2}\/promote 1 --evidence <file>/, "/remember ends with the exact hint");
  assert.match(s.text(), /Promoted proposal \S+ to canonical memory record/);
  const listed = [...s.text().matchAll(/^ {2}(\d)\. \S+ · verified_fact · operator · (.+)$/gm)]
    .map((match) => ({ number: Number(match[1]), body: match[2]! }));
  assert.equal(listed.length, 2, `/memory numbered exactly the two pending proposals: ${JSON.stringify(listed)}`);
  const second = listed.find((entry) => entry.number === 2);
  const first = listed.find((entry) => entry.number === 1);
  assert.notEqual(second, undefined);
  assert.notEqual(first, undefined);

  // The same operator home the session itself resolved `~/.braingate` from — a fresh, unrelated
  // registry root reads a different, empty storage directory and would pass this check vacuously.
  const registry = new ProjectRegistry(resolveOperatorState(env).home);
  const registered = registry.loadFile(join(repo, ".brain", "project.json"));
  const memory = new ProjectMemory(registered);
  try {
    const records = memory.listEffective(10);
    assert.equal(records.length, 2, "exactly the two /promote calls became canonical records");
    assert.ok(records.some((record) => record.body.includes("config.yml")), "the first /promote (its own number 1) went through");
    assert.ok(records.some((record) => record.body === second!.body), "/promote 2 targeted whichever proposal /memory actually numbered 2");
    assert.ok(!records.some((record) => record.body === first!.body), "the proposal /memory numbered 1 (but /promote never named) stayed a proposal");
  } finally { memory.close(); }
});

test("/promote without evidence is refused, and a number nothing lists is refused by name", async () => {
  const repo = project();
  const s = session(repo, ["/remember the export path is configurable", "/promote 1", "/promote 9 --evidence x", "/exit"]);
  assert.equal(await s.run(), 0, s.text());
  assert.match(s.text(), /MEMORY_EVIDENCE_REQUIRED/, "evidence stays mandatory even through /promote");
  assert.match(s.text(), /No proposal numbered 9\. \/memory listed 1\./);
});

test("cancellation: Ctrl+C mid-run finalizes the task as interrupted, prints one line, and the session keeps working", async () => {
  const repo = project();
  const env = operatorEnv();
  let cancelNow: (() => void) | null = null;
  let calls = 0;
  const executor = {
    run: async () => {
      calls += 1;
      // Simulates the operator's Ctrl+C arriving while this exact provider call is in flight — the
      // same moment `abortActiveRuns`/`abortTrackedChildren` would run for a real signal.
      if (calls === 1) cancelNow?.();
      return {
        spawned: true, exitCode: 0, timedOut: false, durationMs: 1, stderr: "", removedEnvironmentKeys: [],
        stdout: JSON.stringify({ result: JSON.stringify({ kind: "work", output: "the theme lives in config.yml" }) }),
      };
    },
  };
  const REQUEST = "where is the theme configuration defined?";
  const s = session(repo, [REQUEST, "y", REQUEST, "y", "/exit"], env, {
    executor,
    registerCancel: (cancel: () => void) => { cancelNow = cancel; },
  });
  assert.equal(await s.run(), 0, s.text());
  assert.equal(calls, 2, "the run that was cancelled, and the next one that was not");
  assert.match(s.text(), /Cancelled\. Task [0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12} recorded as interrupted; nothing was merged\./);
  // The generic failure text is exactly what the cancellation line replaces.
  assert.doesNotMatch(s.text(), /Exit 1: this task did not finish successfully/);
  // The second, uncancelled request still ran and answered.
  assert.match(s.text(), /the theme lives in config\.yml/);

  const registry = new ProjectRegistry(resolveOperatorState(env).home);
  const registered = registry.loadFile(join(repo, ".brain", "project.json"));
  const scope = executionScopeFor(registered, repo);
  const ledger = new TaskLedger(scope.project);
  try {
    const tasks = ledger.listTasks();
    assert.equal(tasks.length, 2, "both the cancelled run and the completed one left a task");
    const cancelledTask = tasks[0]!; // listTasks is oldest first, and the cancelled run happened first
    const receipt = ledger.receipt(cancelledTask.taskId);
    const marker = receipt.events.find((event) => event.kind === "task.finalized");
    assert.equal((marker?.payload as { readonly snapshot?: { readonly outcome?: string; readonly failureKind?: string } } | undefined)?.snapshot?.outcome, "INTERRUPTED");
    assert.equal((marker?.payload as { readonly snapshot?: { readonly outcome?: string; readonly failureKind?: string } } | undefined)?.snapshot?.failureKind, "interrupted");
  } finally { ledger.close(); }
});
